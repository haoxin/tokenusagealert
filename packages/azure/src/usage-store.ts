import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import {
  HourlyUsageSchema, ResourceInventorySchema, TenantDailyUsageSchema, TenantIdSchema, UsageRunSchema, UsageShardViewSchema,
  type HourlyUsage, type ResourceInventory, type UsageRun, type TenantDailyUsage, type UsageShardView,
  type UsagePriceBook,
} from '@tokenusagealert/schemas'
import { businessDate, mapConcurrent, repriceMissingUsageHour, USAGE_RETENTION_MS } from '@tokenusagealert/domain'
import { randomUUID } from 'node:crypto'
import { storageErrorCode, withBlobLease } from './blob-lease.js'
import { z } from 'zod'

const watermarkSchema = z.object({
  schemaVersion: z.literal(1), tenantId: TenantIdSchema,
  lastFinalizedWindowStartUtc: z.iso.datetime({ offset: true }).nullable(),
})
const cacheSchema = z.object({
  schemaVersion: z.literal(1), tenantId: TenantIdSchema,
  resourceObservedAtUtc: z.iso.datetime({ offset: true }),
  subscriptionDiscovery: z.array(z.object({
    subscriptionId: TenantIdSchema, discoveredAtUtc: z.iso.datetime({ offset: true }),
  })),
  metricDimensions: z.record(z.string(), z.array(z.string())),
  modelsMetricDimensions: z.record(z.string(), z.array(z.string())).optional(),
})

export class UsageTopologyMismatchError extends Error {
  constructor() { super('Drain usage executions and explicitly reset operations/usage-topology.json before changing shard count.'); this.name = 'UsageTopologyMismatchError' }
}

export class BlobUsageStore {
  private readonly usage: ContainerClient
  private readonly inventory: ContainerClient
  private readonly operations: ContainerClient
  readonly shardId: number
  readonly shardCount: number
  constructor(service: BlobServiceClient, options: { usage?: string; inventory?: string; operations?: string; shardId?: number; shardCount?: number } = {}) {
    this.usage = service.getContainerClient(options.usage ?? 'usage')
    this.inventory = service.getContainerClient(options.inventory ?? 'inventory')
    this.operations = service.getContainerClient(options.operations ?? 'operations')
    this.shardId = options.shardId ?? 0
    this.shardCount = options.shardCount ?? 1
  }

  async initialize(autoCreate: boolean) {
    for (const container of [this.usage, this.inventory, this.operations]) {
      if (autoCreate) await container.createIfNotExists()
      await container.getProperties()
    }
  }

  withLease<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
    const lock = this.shardCount === 1 ? 'locks/usage' : `locks/usage/shards/${this.shardId}`
    return withBlobLease(this.operations, lock, async (leaseSignal) => {
      const name = 'usage-topology.json'
      let existing = await this.read(this.operations, name)
      if (!existing) {
        try {
          await this.write(this.operations, name, { shardCount: this.shardCount }, null, leaseSignal)
        } catch (error) {
          if (!['BlobAlreadyExists', 'ConditionNotMet'].includes(String(storageErrorCode(error)))) throw error
        }
        existing = await this.read(this.operations, name)
      }
      if (z.object({ shardCount: z.number().int() }).parse(existing?.data).shardCount !== this.shardCount) {
        throw new UsageTopologyMismatchError()
      }
      return operation(leaseSignal)
    }, signal)
  }

  private async read(container: ContainerClient, name: string): Promise<{ data: unknown; etag: string } | null> {
    const blob = container.getBlockBlobClient(name)
    try {
      const properties = await blob.getProperties()
      if (!properties.etag) throw new Error(`Missing ETag for ${name}`)
      const buffer = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } })
      const data: unknown = JSON.parse(buffer.toString('utf8'))
      return { data, etag: properties.etag }
    } catch (error) {
      if (storageErrorCode(error) === 'BlobNotFound') return null
      throw error
    }
  }

  private async write(container: ContainerClient, name: string, data: unknown, etag: string | null, signal: AbortSignal) {
    signal.throwIfAborted()
    const body = JSON.stringify(data)
    await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' }, abortSignal: signal,
    })
  }

  async getInventory(id: string): Promise<ResourceInventory | null> {
    const tenantId = TenantIdSchema.parse(id)
    const result = await this.read(this.inventory, `tenants/${tenantId}/resources.json`)
    if (!result) return null
    const resources = ResourceInventorySchema.parse(result.data)
    const cached = await this.read(this.inventory, `tenants/${tenantId}/resource-cache.json`)
    if (!cached) return resources
    const cache = cacheSchema.parse(cached.data)
    if (cache.resourceObservedAtUtc !== resources.observedAtUtc || cache.tenantId !== tenantId) return resources
    return {
      ...resources, subscriptionDiscovery: cache.subscriptionDiscovery,
      accounts: resources.accounts.map((account) => ({
        ...account, ...(cache.metricDimensions[account.id] ? { metricDimensions: cache.metricDimensions[account.id] } : {}),
        ...(cache.modelsMetricDimensions?.[account.id] ? { modelsMetricDimensions: cache.modelsMetricDimensions[account.id] } : {}),
      })),
    }
  }

  async saveInventory(value: ResourceInventory, signal: AbortSignal) {
    const data = ResourceInventorySchema.parse(value)
    const name = `tenants/${data.tenantId}/resources.json`
    const previous = await this.read(this.inventory, name)
    const { subscriptionDiscovery: _discovery, ...base } = data
    const accounts = data.accounts.map(({ metricDimensions: _dimensions, modelsMetricDimensions: _modelsDimensions, ...account }) => account)
    // Keep the baseline inventory readable by the previous release; cache metadata has its own document.
    await this.write(this.inventory, name, { ...base, accounts }, previous?.etag ?? null, signal)
    const cacheName = `tenants/${data.tenantId}/resource-cache.json`
    const oldCache = await this.read(this.inventory, cacheName)
    await this.write(this.inventory, cacheName, cacheSchema.parse({
      schemaVersion: 1, tenantId: data.tenantId, resourceObservedAtUtc: data.observedAtUtc,
      subscriptionDiscovery: data.subscriptionDiscovery ?? [],
      metricDimensions: Object.fromEntries(data.accounts.filter((account) => account.metricDimensions)
        .map((account) => [account.id, account.metricDimensions])),
      modelsMetricDimensions: Object.fromEntries(data.accounts.filter((account) => account.modelsMetricDimensions)
        .map((account) => [account.id, account.modelsMetricDimensions])),
    }), oldCache?.etag ?? null, signal)
  }

  async saveHour(value: HourlyUsage, signal: AbortSignal) {
    await this.saveHours([value], signal)
  }

  async repriceMissingHour(tenantId: string, windowStartUtc: string, book: UsagePriceBook, actor: string, signal: AbortSignal) {
    TenantIdSchema.parse(tenantId)
    const start = Date.parse(windowStartUtc)
    if (!Number.isFinite(start) || start % 3_600_000 !== 0 || start + 3_600_000 > Date.now() ||
      start + 3_600_000 <= Date.now() - USAGE_RETENTION_MS) {
      throw new Error('Repricing requires one retained, completed natural hour.')
    }
    const name = `tenants/${tenantId}/${businessDate(windowStartUtc).replaceAll('-', '/')}.json`
    const stored = await this.read(this.usage, name)
    if (!stored) throw new Error('The requested persisted usage day does not exist.')
    const day = TenantDailyUsageSchema.parse(stored.data)
    const original = day.hours.find((hour) => Date.parse(hour.windowStartUtc) === start)
    if (!original) throw new Error('The requested persisted usage hour does not exist.')
    if (original.knownCostUsd !== null) {
      if (!original.pricingRepairAuditId) return { changed: false, before: original, hour: original, auditId: null }
      const before = await this.read(this.operations, `usage-repricing/${original.pricingRepairAuditId}/before.json`)
      const audit = z.object({ original: HourlyUsageSchema }).parse(before?.data)
      if (audit.original.knownCostUsd !== null || audit.original.windowStartUtc !== original.windowStartUtc ||
        audit.original.tenantId !== tenantId || audit.original.priceSnapshotId !== original.priceSnapshotId) {
        throw new Error('The persisted repricing audit does not belong to this originally missing amount.')
      }
      const completed = await this.read(this.operations, `usage-repricing/${original.pricingRepairAuditId}/after.json`)
      if (!completed) await this.write(this.operations, `usage-repricing/${original.pricingRepairAuditId}/after.json`, {
        action: 'usage.missing-price.repriced', actor, occurredAtUtc: new Date().toISOString(), hour: original,
      }, null, signal)
      return { changed: false, before: audit.original, hour: original, auditId: original.pricingRepairAuditId }
    }
    const auditId = randomUUID()
    const repriced = HourlyUsageSchema.parse({ ...repriceMissingUsageHour(original, book), pricingRepairAuditId: auditId })
    if (repriced.knownCostUsd === null) throw new Error('No reliable amount was obtained; the original missing-price hour was left unchanged.')
    await this.write(this.operations, `usage-repricing/${auditId}/before.json`, {
      action: 'usage.missing-price.repricing-prepared', actor, occurredAtUtc: new Date().toISOString(),
      original, proposed: repriced, sourceEtag: stored.etag,
    }, null, signal)
    await this.write(this.usage, name, TenantDailyUsageSchema.parse({
      ...day, hours: day.hours.map((hour) => hour.windowStartUtc === original.windowStartUtc ? repriced : hour),
    }), stored.etag, signal)
    await this.write(this.operations, `usage-repricing/${auditId}/after.json`, {
      action: 'usage.missing-price.repriced', actor, occurredAtUtc: new Date().toISOString(), hour: repriced,
    }, null, signal)
    return { changed: true, before: original, hour: repriced, auditId }
  }

  async saveHours(values: HourlyUsage[], signal: AbortSignal) {
    if (values.length === 0) throw new Error('No usage hours were supplied.')
    const hours = values.map((value) => HourlyUsageSchema.parse(value))
      .sort((a, b) => a.windowStartUtc.localeCompare(b.windowStartUtc))
    const tenantId = hours[0]!.tenantId
    if (hours.some((hour) => hour.tenantId !== tenantId)) throw new Error('A usage write must contain only one tenant.')
    const groups = new Map<string, HourlyUsage[]>()
    let finalized: string | null = null
    for (const hour of hours) {
      const date = businessDate(hour.windowStartUtc)
      const group = groups.get(date) ?? []
      group.push(hour); groups.set(date, group)
    }
    for (const [date, updates] of groups) {
      const name = `tenants/${tenantId}/${date.replaceAll('-', '/')}.json`
      const existing = await this.read(this.usage, name)
      const previous = existing ? TenantDailyUsageSchema.parse(existing.data).hours : []
      const byWindow = new Map(previous.map((hour) => [hour.windowStartUtc, hour]))
      for (const hour of updates) {
        const old = byWindow.get(hour.windowStartUtc)
        // A failed retry cannot erase an already finalized, complete amount. The run still records the failure.
        if (old?.finality === 'final' && old.status === 'complete' && hour.status !== 'complete') continue
        const { revision: _revision, finalizedAtUtc: _finalized, ...baseline } = hour
        const next: HourlyUsage = {
          ...baseline,
          thresholdUsd: old ? old.thresholdUsd : hour.thresholdUsd,
        }
        byWindow.set(hour.windowStartUtc, next)
        if (next.finality === 'final' && (!finalized || next.windowStartUtc > finalized)) finalized = next.windowStartUtc
      }
      const data: TenantDailyUsage = {
        schemaVersion: 1, tenantId, businessDate: date,
        hours: [...byWindow.values()].sort((a, b) => a.windowStartUtc.localeCompare(b.windowStartUtc)),
      }
      await this.write(this.usage, name, TenantDailyUsageSchema.parse(data), existing?.etag ?? null, signal)
    }
    if (finalized) {
      const name = `state/${tenantId}.json`
      const previous = await this.read(this.usage, name)
      const before = previous ? watermarkSchema.parse(previous.data).lastFinalizedWindowStartUtc : null
      if (!before || finalized > before) await this.write(this.usage, name, {
        schemaVersion: 1, tenantId, lastFinalizedWindowStartUtc: finalized,
      }, previous?.etag ?? null, signal)
    }
    await this.prune(tenantId, new Date(hours[hours.length - 1]!.collectedAtUtc), signal)
  }

  async hours(id: string, hours: number, now = new Date()): Promise<HourlyUsage[]> {
    const tenantId = TenantIdSchema.parse(id)
    const cutoff = now.getTime() - Math.min(240, hours) * 3_600_000
    const oldestDate = businessDate(new Date(cutoff).toISOString()).replaceAll('-', '/')
    const result: HourlyUsage[] = []
    const prefix = `tenants/${tenantId}/`
    for await (const item of this.usage.listBlobsFlat({ prefix })) {
      const date = item.name.slice(prefix.length, -5)
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || date < oldestDate) continue
      const blob = await this.read(this.usage, item.name)
      if (!blob) continue
      const day = TenantDailyUsageSchema.parse(blob.data)
      if (day.tenantId !== tenantId) throw new Error('Stored usage tenant does not match its Blob path.')
      result.push(...day.hours.filter((hour) =>
        Date.parse(hour.windowEndUtc) > cutoff && Date.parse(hour.windowEndUtc) <= now.getTime(),
      ))
    }
    return result.sort((a, b) => a.windowStartUtc.localeCompare(b.windowStartUtc))
  }

  private async prune(tenantId: string, now: Date, signal: AbortSignal) {
    const cutoff = now.getTime() - USAGE_RETENTION_MS
    const prefix = `tenants/${tenantId}/`
    const cutoffDate = businessDate(new Date(cutoff).toISOString()).replaceAll('-', '/')
    for await (const item of this.usage.listBlobsFlat({ prefix })) {
      const date = item.name.slice(prefix.length, -5)
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || date > cutoffDate) continue
      const blob = await this.read(this.usage, item.name)
      if (!blob) continue
      const day = TenantDailyUsageSchema.parse(blob.data)
      const retained = day.hours.filter((hour) => Date.parse(hour.windowEndUtc) > cutoff)
      if (retained.length === 0) {
        await this.usage.getBlobClient(item.name).delete({ conditions: { ifMatch: blob.etag }, abortSignal: signal })
      } else if (retained.length !== day.hours.length) {
        await this.write(this.usage, item.name, { ...day, hours: retained }, blob.etag, signal)
      }
    }
  }

  async writeRun(run: UsageRun, signal: AbortSignal) {
    const data = UsageRunSchema.parse(run)
    const paths = [`runs/usage/history/${data.runId}.json`, `runs/usage/shards/${this.shardId}.json`]
    if (this.shardId === 0) paths.push('runs/usage/latest.json')
    for (const name of paths) {
      const previous = await this.read(this.operations, name)
      const { execution: _execution, telemetry: _telemetry, capacityWarning: _warning, ...baseline } = data
      await this.write(this.operations, name, name === 'runs/usage/latest.json' ? baseline : data, previous?.etag ?? null, signal)
    }
  }

  async latestRun(): Promise<UsageRun | null> {
    const record = await this.read(this.operations, `runs/usage/shards/${this.shardId}.json`) ??
      (this.shardId === 0 ? await this.read(this.operations, 'runs/usage/latest.json') : null)
    return record ? UsageRunSchema.parse(record.data) : null
  }

  async allRuns(): Promise<UsageRun[]> {
    const results = await mapConcurrent(Array.from({ length: this.shardCount }, (_, i) => i), 8, async (i) => {
      const record = await this.read(this.operations, `runs/usage/shards/${i}.json`) ??
        (i === 0 ? await this.read(this.operations, 'runs/usage/latest.json') : null)
      if (!record) return null
      const run = UsageRunSchema.parse(record.data)
      return (run.execution?.shardCount ?? 1) === this.shardCount ? run : null
    })
    return results.flatMap((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value ? [result.value] : []
    })
  }

  async saveView(view: UsageShardView, signal: AbortSignal) {
    const data = UsageShardViewSchema.parse(view)
    const name = `views/dashboard-24h/shards/${this.shardId}.json`
    const previous = await this.read(this.usage, name)
    await this.write(this.usage, name, data, previous?.etag ?? null, signal)
  }

  async views(): Promise<UsageShardView[]> {
    const results = await mapConcurrent(Array.from({ length: this.shardCount }, (_, i) => i), 8, async (i) => {
      const item = await this.read(this.usage, `views/dashboard-24h/shards/${i}.json`)
      if (!item) return null
      const view = UsageShardViewSchema.parse(item.data)
      return view.shardCount === this.shardCount ? view : null
    })
    return results.flatMap((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value ? [result.value] : []
    })
  }
}
