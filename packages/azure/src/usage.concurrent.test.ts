import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  collectionWindow, normalizePrices, compactOfficialPrices,
} from '@tokenusagealert/domain'
import {
  PricingSnapshotSchema, RetailPricePageSchema,
  type HourlyUsage, type ResourceInventory, type SubscriptionInventoryDocument,
  type TenantListItem, type UsageRun, type UsageShardView, type PricingSnapshot,
} from '@tokenusagealert/schemas'
import { ArmUsageSource } from './usage-source.js'
import { UsageCollectionService } from './usage.js'

const guid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const abort = () => AbortSignal.timeout(60_000)
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

class MemoryStore {
  inventories = new Map<string, ResourceInventory>()
  saved = new Map<string, HourlyUsage[]>()
  runs: UsageRun[] = []
  views: UsageShardView[] = []
  async withLease<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) { return operation(signal) }
  async writeRun(run: UsageRun) { this.runs.push(structuredClone(run)) }
  async getInventory(id: string) { return this.inventories.get(id) ?? null }
  async saveInventory(value: ResourceInventory) { this.inventories.set(value.tenantId, structuredClone(value)) }
  async saveHours(values: HourlyUsage[]) {
    for (const value of values) {
      const existing = this.saved.get(value.tenantId) ?? []
      this.saved.set(value.tenantId, [
        ...existing.filter((item) => item.windowStartUtc !== value.windowStartUtc), structuredClone(value),
      ])
    }
  }
  async hours(id: string) { return this.saved.get(id) ?? [] }
  async saveView(value: UsageShardView) { this.views.push(structuredClone(value)) }
}

function tenant(id: string, now: Date): TenantListItem {
  return {
    schemaVersion: 1, revision: 1, tenantId: id, displayName: `Tenant ${id.slice(-5)}`,
    status: 'active', authorizationSource: 'lighthouse-template', hourlyThresholdUsd: '10.00', notes: '',
    createdByName: 'fixture', createdByObjectId: 'fixture',
    createdAtUtc: now.toISOString(), updatedAtUtc: now.toISOString(), deletedAtUtc: null, etag: '"fixture"',
  }
}

function subscriptions(id: string, count: number, offset: number, now: Date): SubscriptionInventoryDocument {
  const list = Array.from({ length: count }, (_, i) => ({
    subscriptionId: guid(offset + i), displayName: `Subscription ${offset + i}`, customerTenantId: id,
    state: 'Enabled', firstSeenAtUtc: now.toISOString(), lastSeenAtUtc: now.toISOString(), lastValidatedAtUtc: now.toISOString(),
  }))
  return {
    schemaVersion: 1, revision: 1, tenantId: id, expectedSubscriptionIds: list.map((item) => item.subscriptionId),
    subscriptions: list, observedAtUtc: now.toISOString(), updatedAtUtc: now.toISOString(),
  }
}

describe('hundreds of tenants and hundreds of subscriptions (no Azure requests)', () => {
  it('processes 300 × 200 subscriptions with bounded concurrent work and reuses discovery on the next hour', async () => {
    const now = new Date()
    const list = Array.from({ length: 300 }, (_, i) => tenant(guid(i + 1), now))
    const inventories = new Map(list.map((item, i) => [item.tenantId, subscriptions(item.tenantId, 200, 10000 + i * 200, now)]))
    const repository = {
      async listTenants() { return list },
      async getTenant(id: string) { return list.find((item) => item.tenantId === id)! },
      async getSubscriptionInventory(id: string) { return inventories.get(id) ?? null },
      async withTenantAuthorizationLease<T>(_id: string, work: (signal: AbortSignal) => Promise<T>) { return work(abort()) },
    }
    const store = new MemoryStore()
    let requestActive = 0
    let requestPeak = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      requestActive += 1; requestPeak = Math.max(requestPeak, requestActive)
      await delay(1)
      requestActive -= 1
      return json({ value: [] })
    })
    const credential = { async getToken() { return { token: 'local-fixture-not-an-azure-token' } } }
    const execution = { tenantConcurrency: 8, subscriptionConcurrency: 8, totalRequestConcurrency: 32 }
    const source = new ArmUsageSource(undefined, { execution, fetcher, credential })
    const pricing = { async getUsagePriceBook() {
      return { kind: 'usage-price-book' as const, official: null, manual: { schemaVersion: 1 as const, revision: 0, snapshotId: null, versions: [] } }
    } }
    const run = await new UsageCollectionService(repository, store, pricing, source, { execution, now: () => now }).run()
    expect(run.status).toBe('succeeded')
    expect(run.processedTenantCount).toBe(300)
    expect(run.telemetry?.subscriptionCount).toBe(60000)
    expect(run.telemetry?.completedHours).toBe(300)
    expect(run.telemetry?.tenantConcurrencyPeak).toBe(8)
    expect(run.telemetry?.subscriptionConcurrencyPeak).toBe(8)
    expect(run.telemetry?.globalSubscriptionPeak).toBeLessThanOrEqual(64)
    expect(requestPeak).toBe(32)
    expect(fetcher).toHaveBeenCalledTimes(60000)
    expect(store.saved.size).toBe(300)
    for (const hours of store.saved.values()) {
      expect(hours).toHaveLength(1)
      expect(hours[0]?.coverage.successfulSubscriptions).toBe(200)
      expect(hours[0]?.estimatedCostUsd).toBe('0.000000000000')
    }
    const cached = new ArmUsageSource(undefined, { execution, fetcher, credential })
    const cachedRun = await new UsageCollectionService(repository, store, pricing, cached, { execution, now: () => now }).run()
    expect(cachedRun.telemetry?.subscriptionCacheHits).toBe(60000)
    expect(cachedRun.telemetry?.httpRequests).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(60000)
    console.log(JSON.stringify({ simulatedTenants: 300, subscriptionsPerTenant: 200,
      coldDurationMs: run.telemetry?.durationMs, cachedDurationMs: cachedRun.telemetry?.durationMs,
      httpPeak: requestPeak, cloudPerformanceClaim: false }))
  }, 60_000)
})

describe('single-hour metrics and tenant cost aggregation', () => {
  function setup(failSubscription?: string) {
    const now = new Date()
    const window = collectionWindow(now)
    const list = [tenant(guid(1), now), tenant(guid(2), now)]
    const inventories = new Map(list.map((item, i) => [item.tenantId, subscriptions(item.tenantId, 2, 100 + i * 10, now)]))
    const store = new MemoryStore()
    for (const item of list) {
      const inv = inventories.get(item.tenantId)!
      store.inventories.set(item.tenantId, {
        schemaVersion: 1, tenantId: item.tenantId, observedAtUtc: now.toISOString(), issues: [],
        accounts: inv.subscriptions.map((sub) => ({
          id: `/subscriptions/${sub.subscriptionId}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/test`,
          name: 'test', kind: 'OpenAI', region: 'swedencentral', subscriptionId: sub.subscriptionId,
        })),
        deployments: inv.subscriptions.map((sub) => {
          const accountId = `/subscriptions/${sub.subscriptionId}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/test`
          return {
            id: `${accountId}/deployments/chat`, subscriptionId: sub.subscriptionId, accountId,
            accountName: 'test', accountKind: 'OpenAI', region: 'swedencentral', name: 'chat',
            modelName: 'gpt-4.1', modelVersion: '2025-04-14', modelFormat: 'OpenAI', sku: 'GlobalStandard',
            firstObservedAtUtc: new Date(now.getTime() - 5 * 3_600_000).toISOString(), observedAtUtc: now.toISOString(), deleted: false,
          }
        }),
      })
    }
    const metricsRequests: URL[] = []
    const discoveryRequests: URL[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      await delay(1)
      const id = /\/subscriptions\/([^/]+)/.exec(url.pathname)?.[1]
      if (id === failSubscription) return new Response('', { status: 403 })
      const accountId = `/subscriptions/${id}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/test`
      if (url.pathname.endsWith('/accounts')) {
        discoveryRequests.push(url)
        return json({ value: [{ id: accountId, name: 'test', kind: 'OpenAI', location: 'swedencentral' }] })
      }
      if (url.pathname.endsWith('/deployments')) return json({ value: [{
        id: `${accountId}/deployments/chat`, name: 'chat', sku: { name: 'GlobalStandard' },
        properties: { model: { name: 'gpt-4.1', version: '2025-04-14', format: 'OpenAI' } },
      }] })
      if (url.pathname.endsWith('/metricDefinitions')) return json({ value: ['InputTokens', 'OutputTokens'].map((name) => ({
        name: { value: name }, dimensions: ['ModelDeploymentName', 'ModelVersion', 'ModelName'].map((value) => ({ value })),
      })) })
      if (!url.pathname.endsWith('/metrics')) throw new Error(`Unexpected test URL ${url}`)
      metricsRequests.push(url)
      const [start, end] = url.searchParams.get('timespan')!.split('/')
      expect(Date.parse(end!) - Date.parse(start!)).toBe(3_600_000)
      expect(url.searchParams.get('interval')).toBe('PT1H')
      const multiplier = id && [guid(110), guid(111)].includes(id) ? 2 : 1
      return json({ value: ['InputTokens', 'OutputTokens'].map((name) => ({
        name: { value: name }, errorCode: 'Success', unit: 'Count',
        timeseries: [{
          metadatavalues: [
            { name: { value: 'ModelDeploymentName' }, value: 'chat' },
            { name: { value: 'ModelVersion' }, value: '2025-04-14' },
            { name: { value: 'ModelName' }, value: 'gpt-4.1' },
          ],
          data: [{ timeStamp: start, total: name === 'InputTokens' ? 1000 * multiplier : 500 }],
        }],
      })) })
    })
    const fixturePages: unknown[] = JSON.parse(readFileSync(new URL('../../../tests/fixtures/retail-prices-pages.json', import.meta.url), 'utf8'))
    const entries = normalizePrices(fixturePages.flatMap((page) => RetailPricePageSchema.parse(page).Items)).entries
    const snapshot: PricingSnapshot = PricingSnapshotSchema.parse({
      schemaVersion: 1, snapshotId: guid(888), fetchedAtUtc: now.toISOString(), source: 'fixture',
      apiVersion: '2023-01-01-preview', parserVersion: 1, currency: 'USD', cloud: 'AzureCloud',
      pageCount: 2, sourceRecordCount: 2, meterCount: 2, duplicateCount: 0, unsupportedMeterCount: 2,
      unrecognizedUnitCount: 0, contentHash: 'a'.repeat(64), entries,
      changes: { previousSnapshotId: null, addedMeterCount: 2, removedMeterCount: 0, changedPriceCount: 0, unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
    })
    const repository = {
      async listTenants() { return list },
      async getTenant(id: string) { return list.find((item) => item.tenantId === id)! },
      async getSubscriptionInventory(id: string) { return inventories.get(id) ?? null },
      async withTenantAuthorizationLease<T>(_id: string, work: (signal: AbortSignal) => Promise<T>) { return work(abort()) },
    }
    const execution = { tenantConcurrency: 2, subscriptionConcurrency: 2, totalRequestConcurrency: 3 }
    const source = new ArmUsageSource(undefined, { execution, fetcher, credential: { async getToken() { return { token: 'fixture' } } } })
    const pricing = { async getUsagePriceBook() {
      return { kind: 'usage-price-book' as const, official: compactOfficialPrices(snapshot, now),
        manual: { schemaVersion: 1 as const, revision: 0, snapshotId: null, versions: [] } }
    } }
    return { now, window, list, inventories, repository, store, source, pricing, execution, metricsRequests, discoveryRequests, fetcher }
  }

  it('sums subscriptions into their own tenant, with one-hour requests only', async () => {
    const s = setup()
    const result = await new UsageCollectionService(s.repository, s.store, s.pricing, s.source, { execution: s.execution, now: () => s.now }).run()
    expect(result.status).toBe('succeeded')
    expect(s.metricsRequests).toHaveLength(4)
    expect(s.store.saved.get(guid(1))?.[0]?.estimatedCostUsd).toBe('0.012000000000')
    expect(s.store.saved.get(guid(2))?.[0]?.estimatedCostUsd).toBe('0.016000000000')
    expect(s.store.saved.get(guid(1))?.[0]?.finality).toBe('provisional')
    expect(result.telemetry?.httpConcurrencyPeak).toBeLessThanOrEqual(3)
    expect(result.telemetry?.tenantConcurrencyPeak).toBe(2)
  })

  it('keeps reading new metrics while reusing the two-hour resource cache', async () => {
    const s = setup()
    const inventory = await s.source.collect(guid(1), s.inventories.get(guid(1))!, s.store.inventories.get(guid(1))!, s.window, abort())
    const cached = await s.source.collect(guid(1), s.inventories.get(guid(1))!, inventory.inventory, s.window, abort())
    expect(s.discoveryRequests).toHaveLength(2)
    expect(s.metricsRequests).toHaveLength(4)
    expect(cached.inventory.subscriptionDiscovery).toEqual(inventory.inventory.subscriptionDiscovery)
    const expired = structuredClone(cached.inventory)
    expired.subscriptionDiscovery = expired.subscriptionDiscovery!.map((item) => ({
      ...item, discoveredAtUtc: new Date(Date.now() - 2 * 3_600_000 - 1).toISOString(),
    }))
    await s.source.collect(guid(1), s.inventories.get(guid(1))!, expired, s.window, abort())
    expect(s.discoveryRequests).toHaveLength(4)
    expect(s.metricsRequests).toHaveLength(6)
  })

  it('isolates a forbidden subscription, never counts it as zero, and still finishes the other tenant', async () => {
    const s = setup(guid(100))
    const result = await new UsageCollectionService(s.repository, s.store, s.pricing, s.source, { execution: s.execution, now: () => s.now }).run()
    expect(result.processedTenantCount).toBe(2)
    expect(s.store.saved.get(guid(1))?.[0]).toMatchObject({ status: 'partial', estimatedCostUsd: null, knownCostUsd: '0.006000000000' })
    expect(s.store.saved.get(guid(2))?.[0]).toMatchObject({ status: 'complete', estimatedCostUsd: '0.016000000000' })
    expect(s.fetcher.mock.calls.filter(([input]) => String(input).includes(guid(100)))).toHaveLength(1)
  })

  it('rejects a three-hour range before making any request', async () => {
    const s = setup()
    await expect(s.source.collect(guid(1), s.inventories.get(guid(1))!, null, {
      windowStartUtc: s.window.windowStartUtc,
      windowEndUtc: new Date(Date.parse(s.window.windowStartUtc) + 3 * 3_600_000).toISOString(),
    }, abort())).rejects.toMatchObject({ code: 'INVALID_HOURLY_WINDOW' })
    expect(s.fetcher).not.toHaveBeenCalled()
  })

  it('does not query a withdrawn subscription or replay its cached resources', async () => {
    const s = setup()
    const original = s.inventories.get(guid(1))!
    const allowed = original.subscriptions[0]!
    const removed = original.subscriptions[1]!
    const scope = {
      ...original, expectedSubscriptionIds: [allowed.subscriptionId], subscriptions: [allowed],
      removedSubscriptions: [{
        subscriptionId: removed.subscriptionId, displayName: removed.displayName,
        customerTenantId: removed.customerTenantId, lastSeenAtUtc: removed.lastSeenAtUtc,
        removedAtUtc: new Date().toISOString(), reason: 'collector-access-removed' as const,
      }],
    }
    const result = await s.source.collect(guid(1), scope, s.store.inventories.get(guid(1))!, s.window, abort())
    expect(result.successfulSubscriptions).toBe(1)
    expect(result.observations).toHaveLength(1)
    expect(result.inventory.accounts.every((item) => item.subscriptionId === allowed.subscriptionId)).toBe(true)
    expect(result.inventory.issues).toEqual([])
    expect(s.fetcher.mock.calls.some(([url]) => String(url).includes(removed.subscriptionId))).toBe(false)
  })

  it('discards in-flight results if the tenant is removed before committing the hour', async () => {
    const s = setup()
    const original = s.source.collect.bind(s.source)
    vi.spyOn(s.source, 'collect').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (args[0] === guid(1)) s.list[0]!.status = 'deleted'
      return value
    })
    const alerts = { evaluate: vi.fn(async () => {}), disconnected: vi.fn(async () => {}) }
    const result = await new UsageCollectionService(s.repository, s.store, s.pricing, s.source, {
      execution: s.execution, now: () => s.now, alerts,
    }).run()
    expect(s.store.saved.has(guid(1))).toBe(false)
    expect(s.store.saved.has(guid(2))).toBe(true)
    expect(alerts.evaluate).toHaveBeenCalledTimes(1)
    expect(result.issues.some((issue) => issue.code === 'AUTHORIZATION_SCOPE_CHANGED')).toBe(true)
  })

  it('discards in-flight results if only one subscription is withdrawn', async () => {
    const s = setup()
    const original = s.source.collect.bind(s.source)
    vi.spyOn(s.source, 'collect').mockImplementation(async (...args) => {
      const value = await original(...args)
      if (args[0] === guid(1)) {
        const before = s.inventories.get(guid(1))!
        s.inventories.set(guid(1), {
          ...before, subscriptions: before.subscriptions.slice(0, 1),
          expectedSubscriptionIds: before.expectedSubscriptionIds.slice(0, 1),
        })
      }
      return value
    })
    const result = await new UsageCollectionService(s.repository, s.store, s.pricing, s.source, {
      execution: s.execution, now: () => s.now,
    }).run()
    expect(s.store.saved.has(guid(1))).toBe(false)
    expect(s.store.saved.has(guid(2))).toBe(true)
    expect(result.issues.some((issue) => issue.code === 'AUTHORIZATION_SCOPE_CHANGED')).toBe(true)
  })
})
