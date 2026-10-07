import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ManualPriceInputSchema } from '@tokenusagealert/schemas'
import {
  BlobManualPricingStore, ManualPriceConflictError, ManualPriceNotFoundError, ManualPriceScopeError,
  manualPriceHeads, type BlobPricingStore,
} from '@tokenusagealert/azure/pricing'
import { StorageLeaseBusyError } from '@tokenusagealert/azure/usage'
import { isSameOriginJson, isStrongEntityTag } from './request-safety.js'

export interface ManualPricingRoutesOptions {
  manual: Pick<BlobManualPricingStore, 'read' | 'save' | 'disable'>
  official: Pick<BlobPricingStore, 'getCompact'>
}
function problem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  request.log.warn({ status, code }, detail)
  return reply.status(status).type('application/problem+json').send({
    type: `urn:tokenusagealert:problem:${code.toLowerCase()}`, title: code, status, code, detail,
    instance: request.url, correlationId: request.id,
  })
}
export function registerManualPricingRoutes(app: FastifyInstance, options: ManualPricingRoutesOptions | undefined) {
  app.get('/api/v1/settings/manual-pricing', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return problem(request, reply, 503, 'MANUAL_PRICING_UNAVAILABLE', '手动价格模块尚未配置。')
    try {
      const [stored, official] = await Promise.all([options.manual.read(), options.official.getCompact()])
      if (stored.etag) reply.header('etag', stored.etag)
      return {
        ...stored, items: manualPriceHeads(stored.document), regionOptions: official?.catalog.regions ?? [],
        officialModels: official?.catalog.models ?? [], preference: 'official-first', effectivePolicy: 'next-full-hour',
      }
    } catch (error) {
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Manual pricing read failed')
      return problem(request, reply, 503, 'MANUAL_PRICE_READ_FAILED', '无法读取价格配置，请稍后重试；不会显示成空价格列表。')
    }
  })
  const mutate = async (request: FastifyRequest, reply: FastifyReply, id: string | null, disable: boolean) => {
    reply.header('cache-control', 'no-store')
    if (!options) return problem(request, reply, 503, 'MANUAL_PRICING_UNAVAILABLE', '手动价格模块尚未配置。')
    if (!isSameOriginJson(request)) return problem(request, reply, 403, 'MANUAL_PRICE_ORIGIN_REJECTED', '请使用同源 JSON 请求。')
    if (id && !z.string().uuid().safeParse(id).success) return problem(request, reply, 400, 'INVALID_MANUAL_PRICE_ID', '无效手动价格 ID。')
    const tag = request.headers['if-match']
    const none = request.headers['if-none-match']
    const create = id === null && none === '*' && tag === undefined
    if (!create && !(none === undefined && isStrongEntityTag(tag))) {
      return problem(request, reply, 428, 'MANUAL_PRICE_PRECONDITION_REQUIRED', '请携带当前强 ETag；首次新增可使用 If-None-Match: *，不能混用条件头。')
    }
    const body = disable ? z.object({}).strict().safeParse(request.body) : ManualPriceInputSchema.safeParse(request.body)
    if (!body.success) return problem(request, reply, 400, 'INVALID_MANUAL_PRICE', '请填写有效模型名称、部署方式、区域和 USD/百万 token 输入输出单价。')
    try {
      const official = await options.official.getCompact()
      const expected = isStrongEntityTag(tag) ? tag : null
      const saved = disable && id
        ? await options.manual.disable(id, expected, request.principal!.objectId)
        : await options.manual.save(ManualPriceInputSchema.parse(request.body), expected, request.principal!.objectId, id)
      const exists = !disable && [...official?.catalog.rates ?? [], ...official?.catalog.scheduledRates ?? []].some((rate) => rate.model === saved.item.modelName &&
        rate.sku === saved.item.deploymentSku && rate.tier === 'standard' &&
        Date.parse(rate.effectiveFromUtc) <= Date.parse(saved.item.effectiveFromUtc) &&
        (saved.item.regionScope === 'all' || rate.regions.some((region) => saved.item.regions.includes(region.name))))
      return reply.header('etag', saved.etag).status(id ? 200 : 201).send({
        item: saved.item, etag: saved.etag,
        warning: exists ? '相同范围已有官方价格，官方优先；手动价仅在官方缺价时备用，不覆盖官方价格。' : null,
      })
    } catch (error) {
      if (error instanceof ManualPriceConflictError) return problem(request, reply, 412, 'MANUAL_PRICE_CONFLICT', error.message)
      if (error instanceof ManualPriceScopeError) return problem(request, reply, 409, 'MANUAL_PRICE_SCOPE_OVERLAP', error.message)
      if (error instanceof ManualPriceNotFoundError) return problem(request, reply, 404, 'MANUAL_PRICE_NOT_FOUND', error.message)
      if (error instanceof StorageLeaseBusyError) return problem(request, reply, 409, 'MANUAL_PRICE_BUSY', '其他人员正在更新手动价格，请稍后刷新。')
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Manual price mutation could not be confirmed')
      return problem(request, reply, 503, 'MANUAL_PRICE_SAVE_FAILED', '未能确认完整保存结果，请刷新核对价格及审计，不要重复提交。')
    }
  }
  app.post('/api/v1/settings/manual-pricing', (request, reply) => mutate(request, reply, null, false))
  app.patch<{ Params: { id: string } }>('/api/v1/settings/manual-pricing/:id', (request, reply) => mutate(request, reply, request.params.id, false))
  app.post<{ Params: { id: string } }>('/api/v1/settings/manual-pricing/:id/disable', (request, reply) => mutate(request, reply, request.params.id, true))
}
