import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { compactOfficialPrices, normalizePrices, businessDate, overviewHour } from '@tokenusagealert/domain'
import { HourlyUsageSchema, PricingSnapshotSchema, type FoundryEstimatedCost, type HourlyUsage, type UsageShardView, type UsagePriceBook, type RetailPriceItem } from '@tokenusagealert/schemas'
import { BlobUsageStore } from './usage-store.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const guid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { usage: `reprice-usage-${suffix}`, inventory: `reprice-inventory-${suffix}`, operations: `reprice-ops-${suffix}` }
  const store = new BlobUsageStore(client, names)
  await store.initialize(true)
  const start = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000).toISOString()
  const end = new Date(Date.parse(start) + 3_600_000).toISOString()
  const items: RetailPriceItem[] = ['Inp', 'Opt'].map((direction, index) => ({
    currencyCode: 'USD', type: 'Consumption', meterId: guid(index + 1), meterName: `${direction} Tokens`,
    productId: 'fixture', productName: 'Azure OpenAI GPT9', skuId: `sku-${index}`,
    skuName: `9-Orion ${direction} Gl`, serviceName: 'Foundry Models', armRegionName: 'swedencentral',
    retailPrice: index === 0 ? 2 : 7, unitOfMeasure: '1M', tierMinimumUnits: 0,
    effectiveStartDate: '2026-01-01T00:00:00Z', isPrimaryMeterRegion: true,
  }))
  const entries = normalizePrices(items).entries
  const snapshot = PricingSnapshotSchema.parse({
    schemaVersion: 1, snapshotId: guid(4), fetchedAtUtc: start, source: 'fixture', apiVersion: '2023-01-01-preview',
    parserVersion: 3, currency: 'USD', cloud: 'AzureCloud', pageCount: 1, sourceRecordCount: 2, meterCount: 2,
    duplicateCount: 0, unsupportedMeterCount: 0, unrecognizedUnitCount: 0, contentHash: 'a'.repeat(64), entries,
    changes: { previousSnapshotId: null, addedMeterCount: 2, removedMeterCount: 0, changedPriceCount: 0,
      unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
  })
  const book: UsagePriceBook = { kind: 'usage-price-book', official: compactOfficialPrices(snapshot),
    manual: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] } }
  const hour = HourlyUsageSchema.parse({
    schemaVersion: 1, tenantId: guid(3), windowStartUtc: start, windowEndUtc: end, collectedAtUtc: end,
    source: 'azure-monitor', status: 'partial', activity: 'hasUsage', finality: 'provisional',
    knownCostUsd: null, estimatedCostUsd: null, thresholdUsd: '1.00', inputTokens: '1000000', outputTokens: '2000000',
    priceSnapshotId: snapshot.snapshotId, estimatePolicy: 'cached-input-at-standard-rate', pricingRuleVersion: 2,
    validation: 'awaiting-positive-usage-verification',
    coverage: { expectedSubscriptions: 1, successfulSubscriptions: 1, accounts: 1, expectedDeployments: 1, successfulDeployments: 1, pricedDeployments: 0 },
    breakdown: [{
      deployment: { id: '/fixture/deployments/future', subscriptionId: guid(5), accountId: '/fixture/accounts/mock',
        accountName: 'mock', accountKind: 'OpenAI', region: 'swedencentral', name: 'future', modelName: 'gpt-9-orion',
        modelVersion: 'future-version', modelFormat: 'OpenAI', sku: 'GlobalStandard', firstObservedAtUtc: '2026-01-01T00:00:00.000Z',
        observedAtUtc: start, deleted: false },
      inputTokens: '1000000', outputTokens: '2000000', metricsStatus: 'success', metadataVerified: true,
      costUsd: null, prices: [], pricingStatus: 'unsupported', issues: [],
    }], issues: [{ code: 'UNSUPPORTED_PRICING_RULE', message: 'Old model whitelist', resourceId: null }],
  })
  await store.saveHour(hour, AbortSignal.timeout(10_000))
  return { store, names, hour, book, cleanup: async () => {
    await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete()))
  } }
}

describe('audited missing-amount repricing', () => {
  it('repairs only the exact existing hour with before/after audit, stable tokens and threshold, and an idempotent retry', async () => {
    const f = await fixture()
    try {
      const saved = await f.store.withLease((signal) =>
        f.store.repriceMissingHour(f.hour.tenantId, f.hour.windowStartUtc, f.book, 'fixture', signal), AbortSignal.timeout(15_000))
      expect(saved).toMatchObject({ changed: true, before: f.hour, hour: {
        knownCostUsd: '16.000000000000', knownCostUpperUsd: '16.000000000000', pricingRuleVersion: 5,
        thresholdUsd: '1.00', inputTokens: f.hour.inputTokens, outputTokens: f.hour.outputTokens,
      } })
      expect(saved.hour.pricingRepairAuditId).toBe(saved.auditId)
      const retry = await f.store.withLease((signal) =>
        f.store.repriceMissingHour(f.hour.tenantId, f.hour.windowStartUtc, f.book, 'fixture', signal), AbortSignal.timeout(15_000))
      expect(retry).toMatchObject({ changed: false, before: f.hour, hour: saved.hour, auditId: saved.auditId })
      const audit = client.getContainerClient(f.names.operations)
      const before = JSON.parse((await audit.getBlobClient(`usage-repricing/${saved.auditId}/before.json`).downloadToBuffer()).toString())
      const after = JSON.parse((await audit.getBlobClient(`usage-repricing/${saved.auditId}/after.json`).downloadToBuffer()).toString())
      expect(before.original).toEqual(f.hour)
      expect(after.hour).toEqual(saved.hour)
      const hours = await f.store.hours(f.hour.tenantId, 24)
      expect(hours).toEqual([saved.hour])
    } finally { await f.cleanup() }
  })

  it('does not rewrite already known/finalized amounts, and rejects future or mismatched-snapshot repairs before writing an audit', async () => {
    const f = await fixture()
    try {
      const other = { ...f.book, official: { ...f.book.official!, snapshotId: guid(9) } }
      await expect(f.store.repriceMissingHour(f.hour.tenantId, f.hour.windowStartUtc, other, 'fixture', AbortSignal.timeout(10_000)))
        .rejects.toThrow(/original official/)
      await expect(f.store.repriceMissingHour(f.hour.tenantId, new Date(Date.now() + 3_600_000).toISOString(), f.book, 'fixture', AbortSignal.timeout(10_000)))
        .rejects.toThrow(/completed natural hour/)
      const known = { ...f.hour, knownCostUsd: '0.50', estimatedCostUsd: '0.50', finality: 'final' as const, status: 'complete' as const }
      await f.store.saveHour(known, AbortSignal.timeout(10_000))
      expect(await f.store.repriceMissingHour(f.hour.tenantId, f.hour.windowStartUtc, f.book, 'fixture', AbortSignal.timeout(10_000)))
        .toMatchObject({ changed: false, hour: known, auditId: null })
      expect((await f.store.hours(f.hour.tenantId, 24))[0]?.knownCostUsd).toBe('0.50')
      const path = `tenants/${f.hour.tenantId}/${businessDate(f.hour.windowStartUtc).replaceAll('-', '/')}.json`
      expect((await client.getContainerClient(f.names.usage).getBlobClient(path).getProperties()).etag).toBeTruthy()
    } finally { await f.cleanup() }
  })
})

describe('bounded context/native estimate backfill', () => {
  const confirmed = (hour: HourlyUsage) => HourlyUsageSchema.parse({
    ...hour, status: 'complete', finality: 'final', finalizedAtUtc: hour.windowEndUtc, revision: 7,
    knownCostUsd: '16.000000000000', knownCostUpperUsd: '16.000000000000', estimatedCostUsd: '16.000000000000',
    pricingRuleVersion: 4, estimatePolicy: 'cache-ratio-retail-range', issues: [],
    coverage: { ...hour.coverage, pricedDeployments: 1 },
    breakdown: hour.breakdown.map((row) => ({ ...row, costUsd: '16.000000000000',
      costUpperUsd: '16.000000000000', pricingStatus: 'matched', issues: [] })),
  })
  const estimate = (): FoundryEstimatedCost => ({
    metricName: 'FoundryModelEstimatedCost', currency: 'USD', status: 'available',
    costUsd: '12.000000000000', retrievedAtUtc: new Date().toISOString(), issue: null,
  })

  it('preserves original day bytes and facts, refreshes only the tenant cache, and recovers without rewriting the day', async () => {
    const f = await fixture()
    try {
      const original = confirmed(f.hour)
      const otherStart = new Date(Date.parse(original.windowStartUtc) - 3_600_000).toISOString()
      const untouched = { ...original, windowStartUtc: otherStart, windowEndUtc: original.windowStartUtc }
      const date = businessDate(original.windowStartUtc)
      const name = `tenants/${original.tenantId}/${date.replaceAll('-', '/')}.json`
      const blob = client.getContainerClient(f.names.usage).getBlockBlobClient(name)
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, tenantId: original.tenantId,
        businessDate: date, hours: [untouched, original] }, null, 2)}\n`)
      await blob.upload(bytes, bytes.length, { conditions: { ifMatch: (await blob.getProperties()).etag } })
      const otherTenant = { tenantId: guid(50), displayName: 'Unchanged tenant', status: 'active', thresholdUsd: '1.00',
        latest: null, hours: [] }
      const view: UsageShardView = {
        schemaVersion: 1, runId: guid(51), shardId: 0, shardCount: 1, generatedAtUtc: original.collectedAtUtc,
        windowStartUtc: original.windowStartUtc, windowEndUtc: original.windowEndUtc,
        tenants: [{ tenantId: original.tenantId, displayName: 'Fixture', status: 'active', thresholdUsd: '1.00',
          latest: overviewHour(original), hours: [overviewHour(untouched), overviewHour(original)] }, otherTenant],
      }
      await f.store.saveView(view, AbortSignal.timeout(10_000))
      const requests = [{ windowStartUtc: original.windowStartUtc,
        estimates: { [original.breakdown[0]!.deployment.id]: estimate() } }]
      const run = () => f.store.withLease((signal) =>
        f.store.backfillContextEstimates(original.tenantId, requests, f.book, 'fixture', signal), AbortSignal.timeout(20_000))
      const result = await run()
      const updated = result.hours[0]!
      expect(updated).toMatchObject({ pricingRuleVersion: 5, estimatePolicy: 'equal-context-retail-range',
        finality: 'final', finalizedAtUtc: original.finalizedAtUtc, revision: 8,
        collectedAtUtc: original.collectedAtUtc, thresholdUsd: original.thresholdUsd,
        inputTokens: original.inputTokens, outputTokens: original.outputTokens, priceSnapshotId: original.priceSnapshotId,
        foundryEstimatedCost: { status: 'available', costUsd: '12.000000000000' } })
      expect(updated.breakdown[0]!.deployment).toEqual(original.breakdown[0]!.deployment)
      const operations = client.getContainerClient(f.names.operations)
      expect(await operations.getBlobClient(`usage-context-backfill/${result.auditId}/original-day.json`).downloadToBuffer()).toEqual(bytes)
      const storedDay = JSON.parse((await blob.downloadToBuffer()).toString())
      expect(storedDay.hours[0]).toEqual(untouched)
      const currentView = (await f.store.views())[0]!
      expect(currentView.tenants[1]).toEqual(otherTenant)
      expect(currentView.tenants[0]?.latest?.foundryEstimatedCost?.costUsd).toBe('12.000000000000')
      expect(currentView.tenants[0]?.hours[1]?.breakdown).toEqual([])
      const afterEtag = (await blob.getProperties()).etag
      expect(await run()).toMatchObject({ changed: false, auditId: result.auditId, cacheUpdated: 0 })
      await operations.getBlobClient(`usage-context-backfill/${result.auditId}/after.json`).delete()
      await f.store.saveView(view, AbortSignal.timeout(10_000))
      expect(await run()).toMatchObject({ changed: false, auditId: result.auditId, cacheUpdated: 1 })
      expect((await blob.getProperties()).etag).toBe(afterEtag)
      expect(await operations.getBlobClient(`usage-context-backfill/${result.auditId}/after.json`).exists()).toBe(true)
    } finally { await f.cleanup() }
  })

  it('rejects unavailable native costs and the wrong original snapshot before creating backfill artifacts', async () => {
    const f = await fixture()
    try {
      const original = confirmed(f.hour)
      await f.store.saveHour(original, AbortSignal.timeout(10_000))
      const requests = [{ windowStartUtc: original.windowStartUtc,
        estimates: { [original.breakdown[0]!.deployment.id]: estimate() } }]
      const unavailable = [{ ...requests[0]!, estimates: { [original.breakdown[0]!.deployment.id]:
        { ...estimate(), status: 'noData' as const, costUsd: null } } }]
      await expect(f.store.backfillContextEstimates(original.tenantId, unavailable, f.book, 'fixture', AbortSignal.timeout(10_000)))
        .rejects.toThrow(/complete native estimates/)
      const wrong = { ...f.book, official: { ...f.book.official!, snapshotId: guid(52) } }
      await expect(f.store.backfillContextEstimates(original.tenantId, requests, wrong, 'fixture', AbortSignal.timeout(10_000)))
        .rejects.toThrow(/original official/)
      const artifacts = []
      for await (const item of client.getContainerClient(f.names.operations).listBlobsFlat({ prefix: 'usage-context-backfill/' })) artifacts.push(item.name)
      expect(artifacts).toEqual([])
      expect((await f.store.hours(original.tenantId, 24)).find((hour) => hour.windowStartUtc === original.windowStartUtc)?.pricingRuleVersion).toBe(4)
    } finally { await f.cleanup() }
  })
})
