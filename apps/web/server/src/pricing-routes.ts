import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  getPricingStatus, PricingSyncBusyError, PricingSyncFailedError,
  PricingDownloadChangedError,
  type PricingStore,
} from '@tokenusagealert/azure/pricing'
import { z } from 'zod'

export interface PricingRoutesOptions {
  store: PricingStore
  starter: { start(): Promise<{ executionName: string }> }
}

function problem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  request.log.warn({ code, status }, detail)
  return reply.status(status).type('application/problem+json').send({
    type: `urn:tokenusagealert:problem:${code.toLowerCase()}`,
    title: code, status, detail, instance: request.url, code,
    correlationId: request.id,
  })
}

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().max(80).regex(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-f0-9-]{36}$/,
  ).optional(),
}).strict()

export function registerPricingRoutes(app: FastifyInstance, options: PricingRoutesOptions | undefined) {
  app.get('/api/v1/pricing/status', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return problem(request, reply, 503, 'PRICING_UNAVAILABLE', 'Price synchronization is not configured.')
    try {
      return await getPricingStatus(options.store)
    } catch (error) {
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Price status could not be read or validated')
      return problem(request, reply, 503, 'PRICING_STATUS_UNAVAILABLE', 'The stored price status could not be read or validated; this is not an empty catalog.')
    }
  })
  app.get('/api/v1/pricing/history', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return problem(request, reply, 503, 'PRICING_UNAVAILABLE', 'Price synchronization is not configured.')
    const parsed = historyQuery.safeParse(request.query)
    if (!parsed.success) return problem(request, reply, 400, 'INVALID_PRICE_HISTORY_QUERY', 'Use a page size of 1–50 and a cursor returned by this endpoint.')
    try {
      return await options.store.listHistory(parsed.data.limit, parsed.data.cursor, new Date())
    } catch (error) {
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Price history could not be read or validated')
      return problem(request, reply, 503, 'PRICING_HISTORY_UNAVAILABLE', 'Price backup history is unavailable; retry rather than treating it as empty.')
    }
  })
  app.get('/api/v1/pricing/download', async (request, reply) => {
    reply.header('cache-control', 'private, no-store')
    if (!options) return problem(request, reply, 503, 'PRICING_UNAVAILABLE', '价格模块尚未配置。')
    const query = z.object({ format: z.enum(['compact', 'raw']).default('compact') }).strict().safeParse(request.query)
    if (!query.success) {
      return problem(request, reply, 400, 'INVALID_PRICE_DOWNLOAD_QUERY', '仅支持 compact/raw，不接受自定义 Blob 地址或过滤参数。')
    }
    const controller = new AbortController()
    request.raw.once('aborted', () => controller.abort())
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) controller.abort() })
    try {
      const download = query.data.format === 'raw'
        ? await options.store.getActiveDownload(controller.signal)
        : await options.store.getCompactDownload(controller.signal)
      if (!download) return problem(request, reply, 404, 'PRICE_SNAPSHOT_MISSING', '尚无可下载的价格快照，请先完成价格同步。')
      download.stream.on('error', (error: unknown) => {
        request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Pricing download stream failed')
      })
      return reply.type('application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${query.data.format === 'raw' ? 'aoai-pricing-raw.json' : 'aoai-pricing.json'}"`)
        .header('content-length', download.contentLength)
        .header('x-content-type-options', 'nosniff')
        .header('x-pricing-snapshot-id', download.summary.snapshotId)
        .header('etag', download.etag)
        .send(download.stream)
    } catch (error) {
      if (error instanceof PricingDownloadChangedError) {
        return problem(request, reply, 409, 'PRICE_SNAPSHOT_CHANGED', '价格正在更新，未生成混合版本文件，请重试下载。')
      }
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Pricing download could not be prepared')
      return problem(request, reply, 503, 'PRICE_DOWNLOAD_UNAVAILABLE', '价格文件读取失败，请稍后重试；不会返回空文件。')
    }
  })

  app.post('/api/v1/pricing/sync', async (request, reply) => {
    if (!options) return problem(request, reply, 503, 'PRICING_UNAVAILABLE', 'Price synchronization is not configured.')
    // Requiring JSON rejects simple cross-origin form submissions that would start a billable Job.
    const origin = request.headers.origin
    const authority = request.headers['x-forwarded-host'] ?? request.headers.host
    let wrongOrigin = false
    if (origin) {
      try {
        const source = new URL(origin)
        wrongOrigin = typeof authority !== 'string' ||
          source.host !== new URL(`${source.protocol}//${authority}`).host
      } catch { wrongOrigin = true }
    }
    if (
      !request.headers['content-type']?.startsWith('application/json') ||
      !request.headers.accept?.includes('application/json') ||
      request.headers['sec-fetch-site'] === 'cross-site' || wrongOrigin
    ) {
      return problem(request, reply, 403, 'PRICE_SYNC_ORIGIN_REJECTED', 'Start pricing sync from the same-origin application with a JSON request.')
    }
    if (!z.object({}).strict().safeParse(request.body).success) {
      return problem(request, reply, 400, 'INVALID_PRICE_SYNC_REQUEST', 'Price synchronization does not accept a custom URL, model filter, or execution template.')
    }
    try {
      const { executionName } = await options.starter.start()
      return reply.status(202).send({ status: 'started', executionName })
    } catch (error) {
      if (error instanceof PricingSyncBusyError) {
        return problem(request, reply, 409, 'PRICING_SYNC_BUSY', error.message)
      }
      if (error instanceof PricingSyncFailedError) {
        return problem(request, reply, 503, error.run.error?.code ?? 'PRICING_SYNC_FAILED', error.message)
      }
      request.log.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Pricing Job start failed')
      return problem(request, reply, 503, 'PRICING_JOB_START_FAILED', 'The pricing Job could not be started. Retry later; existing prices have not been changed.')
    }
  })
}
