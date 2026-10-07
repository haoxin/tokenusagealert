import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { compactOfficialPrices, normalizePrices, businessDate } from '@tokenusagealert/domain'
import { HourlyUsageSchema, PricingSnapshotSchema, type UsagePriceBook, type RetailPriceItem } from '@tokenusagealert/schemas'
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
        knownCostUsd: '16.000000000000', knownCostUpperUsd: '16.000000000000', pricingRuleVersion: 3,
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
