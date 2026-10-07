import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  collectionWindow, mapConcurrent, tenantShard,
} from '@tokenusagealert/domain'
import {
  TenantIdSchema, TenantUsageResponseSchema, UsageOverviewSchema,
} from '@tokenusagealert/schemas'
import type { BlobTenantRepository } from '@tokenusagealert/azure'
import {
  StorageLeaseBusyError, overviewHour, type BlobUsageStore,
} from '@tokenusagealert/azure/usage'

export interface UsageRoutesOptions {
  tenants: Pick<BlobTenantRepository, 'listTenants' | 'getTenant'>
  store: BlobUsageStore
  starter: { start(): Promise<{ executionName: string }> }
}

function failure(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  request.log.warn({ status, code }, detail)
  return reply.status(status).type('application/problem+json').send({
    type: `urn:tokenusagealert:problem:${code.toLowerCase()}`, status, title: code,
    code, detail, instance: request.url, correlationId: request.id,
  })
}

export function registerUsageRoutes(app: FastifyInstance, options: UsageRoutesOptions | undefined) {
  app.get('/api/v1/dashboard', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return failure(request, reply, 503, 'USAGE_UNAVAILABLE', '用量采集尚未配置。')
    const now = new Date()
    const window = collectionWindow(now)
    const [views, runs, configuredTenants] = await Promise.all([
      options.store.views(), options.store.allRuns(), options.tenants.listTenants(),
    ])
    const liveTenants = new Map(configuredTenants.filter((tenant) => tenant.status !== 'deleted').map((tenant) => [tenant.tenantId, tenant]))
    const latestRun = [...runs].sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc))[0] ?? null
    if (views.length > 0) {
      const seen = new Set<string>()
      const tenants = views.flatMap((view) => view.tenants.filter((tenant) => liveTenants.has(tenant.tenantId)).map((tenant) => {
        if (seen.has(tenant.tenantId) || tenantShard(tenant.tenantId, view.shardCount) !== view.shardId) {
          throw new Error('Dashboard shards contain overlapping or incorrectly assigned tenants.')
        }
        seen.add(tenant.tenantId)
        const hours = tenant.hours.filter((hour) => Date.parse(hour.windowEndUtc) > now.getTime() - 24 * 3_600_000)
        return {
          ...tenant, hours, status: liveTenants.get(tenant.tenantId)!.status,
          displayName: liveTenants.get(tenant.tenantId)!.displayName,
          thresholdUsd: liveTenants.get(tenant.tenantId)!.hourlyThresholdUsd,
          latest: ['active', 'degraded'].includes(liveTenants.get(tenant.tenantId)!.status)
            ? hours.find((hour) => hour.windowStartUtc === window.windowStartUtc) ?? null : null,
        }
      }))
      for (const tenant of liveTenants.values()) if (!seen.has(tenant.tenantId)) tenants.push({
        tenantId: tenant.tenantId, displayName: tenant.displayName, status: tenant.status,
        thresholdUsd: tenant.hourlyThresholdUsd, latest: null, hours: [],
      })
      return UsageOverviewSchema.parse({
        generatedAtUtc: views.map((view) => view.generatedAtUtc).sort()[0],
        ...window, latestRun, runs, tenants,
        shardCoverage: {
          expected: options.store.shardCount, available: views.length,
          current: views.filter((view) => view.windowStartUtc === window.windowStartUtc).length,
        },
      })
    }
    const tenants = configuredTenants
    const results = await mapConcurrent(tenants.filter((item) => item.status !== 'deleted'), 16, async (tenant) => {
      const hours = (await options.store.hours(tenant.tenantId, 24, now)).map(overviewHour)
      return {
        tenantId: tenant.tenantId, displayName: tenant.displayName,
        status: tenant.status, thresholdUsd: tenant.hourlyThresholdUsd,
        latest: hours.find((hour) => hour.windowStartUtc === window.windowStartUtc) ?? null,
        hours,
      }
    })
    const rows = results.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    return UsageOverviewSchema.parse({
      generatedAtUtc: now.toISOString(), ...window, latestRun, runs, tenants: rows,
      shardCoverage: { expected: options.store.shardCount, available: 0, current: 0 },
    })
  })

  app.get<{ Params: { tenantId: string } }>('/api/v1/tenants/:tenantId/usage', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return failure(request, reply, 503, 'USAGE_UNAVAILABLE', '用量采集尚未配置。')
    const id = TenantIdSchema.safeParse(request.params.tenantId)
    const query = z.object({ hours: z.coerce.number().int().min(1).max(240).default(240) }).strict().safeParse(request.query)
    if (!id.success || !query.success) return failure(request, reply, 400, 'INVALID_USAGE_QUERY', '请指定有效租户及 1–240 小时的查询窗口。')
    const [hours, inventory, latestRun] = await Promise.all([
      options.store.hours(id.data, query.data.hours),
      options.store.getInventory(id.data), options.store.latestRun(),
    ])
    return TenantUsageResponseSchema.parse({ tenantId: id.data, hours, inventory, latestRun })
  })

  app.get('/api/v1/usage/status', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!options) return failure(request, reply, 503, 'USAGE_UNAVAILABLE', '用量采集尚未配置。')
    const runs = await options.store.allRuns()
    return { run: [...runs].sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc))[0] ?? null, runs, shardCount: options.store.shardCount }
  })

  app.post('/api/v1/usage/collect', async (request, reply) => {
    if (!options) return failure(request, reply, 503, 'USAGE_UNAVAILABLE', '用量采集尚未配置。')
    let originValid = !request.headers.origin
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin)
        const host = request.headers['x-forwarded-host'] ?? request.headers.host
        originValid = typeof host === 'string' && origin.host === new URL(`${origin.protocol}//${host}`).host
      } catch { originValid = false }
    }
    if (!originValid || request.headers['sec-fetch-site'] === 'cross-site' ||
      !request.headers['content-type']?.startsWith('application/json')) {
      return failure(request, reply, 403, 'USAGE_ORIGIN_REJECTED', '请在同源应用中发起 JSON 采集请求。')
    }
    if (!z.object({}).strict().safeParse(request.body).success) {
      return failure(request, reply, 400, 'INVALID_USAGE_REQUEST', '只允许固定采集任务，不接受自定义订阅、窗口或执行模板。')
    }
    try {
      const result = await options.starter.start()
      return reply.status(202).send({ status: 'started', executionName: result.executionName })
    } catch (error) {
      if (error instanceof StorageLeaseBusyError) return failure(request, reply, 409, 'USAGE_BUSY', '已有用量采集正在执行。')
      return failure(request, reply, 503, 'USAGE_START_FAILED', '无法启动采集，请查看运行状态。')
    }
  })
}
