import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ManualPriceInputSchema, PricingSnapshotSchema, RetailPricePageSchema, TokenObservationSchema,
  UsagePriceReferenceSchema,
  type ManualPriceVersion, type RetailPriceItem, type UsagePriceBook,
} from '@tokenusagealert/schemas'
import { compactOfficialPrices } from './compact-pricing.js'
import { normalizePrices } from './pricing.js'
import { calculateDeploymentCost, indexUsagePrices } from './usage.js'

const now = new Date('2026-10-05T10:30:00.000Z')
const hour = '2026-10-05T09:00:00.000Z'
const guid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const pages: unknown[] = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/retail-prices-pages.json', import.meta.url), 'utf8',
))
const baseline = pages.flatMap((page) => RetailPricePageSchema.parse(page).Items)
const input = baseline[0]!

function snapshot(extra: RetailPriceItem[] = []) {
  const { entries } = normalizePrices([...baseline, ...extra])
  return PricingSnapshotSchema.parse({
    schemaVersion: 1, snapshotId: guid(1), fetchedAtUtc: now.toISOString(), source: 'fixture',
    apiVersion: '2023-01-01-preview', parserVersion: 2, currency: 'USD', cloud: 'AzureCloud',
    pageCount: 1, sourceRecordCount: entries.length, meterCount: entries.length, duplicateCount: 0,
    unsupportedMeterCount: entries.length, unrecognizedUnitCount: 0, contentHash: 'a'.repeat(64),
    entries, models: [...new Set(entries.map((entry) => entry.modelName).filter((name) => name !== null))],
    changes: { previousSnapshotId: null, addedMeterCount: entries.length, removedMeterCount: 0,
      changedPriceCount: 0, unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
  })
}
function observation(modelName = 'gpt-4.1', version = '2025-04-14', region = 'swedencentral') {
  return TokenObservationSchema.parse({
    deployment: {
      id: '/subscriptions/fixture/resourceGroups/mock/providers/Microsoft.CognitiveServices/accounts/mock/deployments/mock',
      subscriptionId: guid(2), accountId: '/accounts/mock', accountName: 'mock', accountKind: 'OpenAI',
      region, name: 'mock', modelName, modelVersion: version, modelFormat: 'OpenAI', sku: 'GlobalStandard',
      firstObservedAtUtc: '2026-10-01T00:00:00.000Z', observedAtUtc: now.toISOString(), deleted: false,
    },
    inputTokens: '1000000', outputTokens: '2000000', metricsStatus: 'success', metadataVerified: true, issues: [],
  })
}
function manual(overrides: Partial<ManualPriceVersion> = {}): ManualPriceVersion {
  return {
    ruleId: guid(3), revision: 1, modelName: 'gpt-6.1-sol', modelVersion: null, deploymentSku: 'GlobalStandard',
    regionScope: 'selected', regions: ['swedencentral'], inputUsdPerMillion: '3', outputUsdPerMillion: '7',
    note: 'Local test fixture, not a real quote', effectiveFromUtc: '2026-10-05T08:00:00.000Z',
    effectiveToUtc: null, enabled: true, updatedAtUtc: '2026-10-05T07:30:00.000Z', updatedByObjectId: 'fixture',
    ...overrides,
  }
}
function book(versions: ManualPriceVersion[] = [], extra: RetailPriceItem[] = []): UsagePriceBook {
  return { kind: 'usage-price-book', official: compactOfficialPrices(snapshot(extra), now),
    manual: { schemaVersion: 1, revision: versions.length, snapshotId: versions.length ? guid(4) : null, versions } }
}

describe('compact official pricing', () => {
  it('scales token units to USD per million and preserves official provenance without copying raw metadata', () => {
    const raw = snapshot()
    const compact = compactOfficialPrices(raw, now)
    expect(compact).toMatchObject({
      kind: 'compact-official', snapshotId: raw.snapshotId, fetchedAtUtc: raw.fetchedAtUtc,
      generatedAtUtc: now.toISOString(), unitTokens: '1000000', rawEntryCount: 2, models: ['gpt-4.1'],
    })
    expect(compact.rates.find((rate) => rate.direction === 'input')).toMatchObject({
      usd: '2', approvedMapping: true, regions: [{ name: 'swedencentral', meterId: input.meterId }],
    })
    expect(JSON.stringify(compact)).not.toContain('"raw":')
    expect(JSON.stringify(compact)).not.toContain('productId')
  })

  it('merges equal regions but keeps their real meter IDs and distinct regional prices', () => {
    const compact = compactOfficialPrices(snapshot([
      { ...input, armRegionName: 'eastus', meterId: guid(10) },
      { ...input, armRegionName: 'westus', meterId: guid(11), retailPrice: 0.00242 },
    ]), now)
    const rates = compact.rates.filter((rate) => rate.direction === 'input')
    expect(rates).toHaveLength(2)
    expect(rates.find((rate) => rate.usd === '2')?.regions).toEqual([
      { name: 'eastus', meterId: guid(10) }, { name: 'swedencentral', meterId: input.meterId },
    ])
    expect(rates.find((rate) => rate.usd === '2.42')?.regions).toEqual([{ name: 'westus', meterId: guid(11) }])
  })

  it('selects the newest already-effective SKU date independently in each region and never applies future prices', () => {
    const compact = compactOfficialPrices(snapshot([
      { ...input, meterId: guid(12), retailPrice: 0.004, effectiveStartDate: '2026-10-04T00:00:00Z' },
      { ...input, meterId: guid(13), retailPrice: 0.009, effectiveStartDate: '2026-10-06T00:00:00Z' },
      { ...input, meterId: guid(14), armRegionName: 'eastus' },
    ]), now)
    expect(compact.rates.filter((rate) => rate.direction === 'input')).toHaveLength(2)
    expect(compact.rates.find((rate) => rate.usd === '4')?.regions).toEqual([{ name: 'swedencentral', meterId: guid(12) }])
    expect(compact.rates.find((rate) => rate.usd === '2')?.regions).toEqual([{ name: 'eastus', meterId: guid(14) }])
    expect(compact.rates.some((rate) => rate.usd === '9')).toBe(false)
  })

  it('retains only the necessary predecessor at midnight so the prior completed hour still uses the latest price valid for that hour', () => {
    const raw = { ...snapshot([{
      ...input, meterId: guid(15), retailPrice: 0.004, effectiveStartDate: '2026-10-06T00:00:00Z',
    }]), fetchedAtUtc: '2026-10-06T00:00:00.000Z' }
    const clock = new Date('2026-10-06T00:00:00.000Z')
    const value: UsagePriceBook = { kind: 'usage-price-book', official: compactOfficialPrices(raw, clock),
      manual: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] } }
    expect(value.official!.rates.filter((rate) => rate.direction === 'input')).toHaveLength(2)
    const previousHour = calculateDeploymentCost(observation(), value, '2026-10-05T23:00:00.000Z')
    expect(previousHour.costUsd).toBe('18.000000000000')
    expect(previousHour.prices[0]?.meterId).toBe(input.meterId)
    const nextHour = calculateDeploymentCost(observation(), value, '2026-10-06T00:00:00.000Z')
    expect(nextHour.costUsd).toBe('20.000000000000')
    expect(nextHour.prices[0]?.meterId).toBe(guid(15))
    expect(compactOfficialPrices({ ...raw, fetchedAtUtc: '2026-10-06T02:15:00.000Z' }, new Date('2026-10-06T02:15:00.000Z')).rates
      .filter((rate) => rate.direction === 'input')).toHaveLength(1)
  })

  it('keeps context tiers, cache directions, deployment scopes and priority/batch/flex prices separate', () => {
    const labels = ['6-luna ShortCo Inp Std Gl', '6-luna LongCo Inp Std Gl',
      '6-luna ShortCo Cd Inp Std Gl', '6-luna LongCo Cd Wr Std Gl', '6-luna ShortCo Opt PP DZ',
      '6-luna ShortCo Opt Batch Gl', '6-luna ShortCo Opt Fl Gl']
    const compact = compactOfficialPrices(snapshot(labels.map((skuName, index) => ({
      ...input, skuName, productName: 'Azure OpenAI GPT6', meterId: guid(20 + index), unitOfMeasure: '1M',
    }))), now)
    const rates = compact.rates.filter((rate) => rate.model === 'gpt-6-luna')
    expect(rates).toHaveLength(7)
    expect(rates).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: 'short', direction: 'cachedInput', tier: 'standard' }),
      expect.objectContaining({ context: 'long', direction: 'cacheWrite', tier: 'standard' }),
      expect.objectContaining({ sku: 'DataZoneStandard', tier: 'priority' }),
      expect.objectContaining({ tier: 'batch' }), expect.objectContaining({ tier: 'flex' }),
    ]))
    expect(rates.every((rate) => rate.approvedMapping)).toBe(true)
  })

  it('rejects ambiguous same-date meter identities rather than silently dropping a price', () => {
    expect(() => compactOfficialPrices(snapshot([{ ...input, meterId: guid(31) }]), now)).toThrow(/ambiguous/)
  })

  it('does not include training, non-primary, non-token, nonzero-tier, or unidentified rows', () => {
    const compact = compactOfficialPrices(snapshot([
      { ...input, meterId: guid(40), isPrimaryMeterRegion: false },
      { ...input, meterId: guid(41), tierMinimumUnits: 100 },
      { ...input, meterId: guid(42), unitOfMeasure: '1 Hour' },
      { ...input, meterId: guid(43), skuName: 'gpt-4.1 FT Inp Gl' },
      { ...input, meterId: guid(44), skuName: 'future-unknown unrecognized billing' },
    ]), now)
    expect(compact.rates).toHaveLength(2)
  })

  it('preserves fine decimal prices exactly instead of rounding them to zero', () => {
    const compact = compactOfficialPrices(snapshot([{
      ...input, meterId: guid(45), armRegionName: 'eastus', unitOfMeasure: '1M', retailPrice: 0.000000000001,
    }]), now)
    expect(compact.rates.find((rate) => rate.regions.some((region) => region.name === 'eastus'))?.usd).toBe('0.000000000001')
  })

  it('computes exactly the same GPT-4.1 cost, region meter IDs and dates as the original raw snapshot', () => {
    const raw = snapshot()
    const compact = book()
    const original = calculateDeploymentCost(observation(), raw, hour)
    const optimized = calculateDeploymentCost(observation(), compact, hour, indexUsagePrices(compact))
    expect(original.costUsd).toBe('18.000000000000')
    expect(optimized.costUsd).toBe(original.costUsd)
    expect(optimized.pricingStatus).toBe(original.pricingStatus)
    expect(optimized.prices.map(({ meterId, effectiveStartUtc, snapshotId }) => ({ meterId, effectiveStartUtc, snapshotId })))
      .toEqual(original.prices.map(({ meterId, effectiveStartUtc, snapshotId }) => ({ meterId, effectiveStartUtc, snapshotId })))
  })
})

describe('manual missing-price fallback', () => {
  it('uses a missing model uniform input/output estimate with explicit immutable manual source references', () => {
    const result = calculateDeploymentCost(observation('gpt-6.1-sol', '2026-09-29'), book([manual()]), hour)
    expect(result).toMatchObject({ costUsd: '17.000000000000', pricingStatus: 'matched', issues: [] })
    expect(result.prices).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'manual', meterId: null, unitQuantity: '1000000', unitPriceUsd: '3',
        manualPriceId: guid(3), manualPriceRevision: 1, snapshotId: guid(4) }),
      expect.objectContaining({ direction: 'output', unitPriceUsd: '7' }),
    ]))
  })

  it('can use explicitly entered zero rates, but cannot turn missing prices into zero', () => {
    const item = observation('gpt-6.1-sol', '2026-09-29')
    expect(calculateDeploymentCost(item, book([manual({ inputUsdPerMillion: '0', outputUsdPerMillion: '0' })]), hour).costUsd)
      .toBe('0.000000000000')
    expect(calculateDeploymentCost(item, book(), hour).costUsd).toBeNull()
  })

  it('keeps an effective manual fallback on a valid empty-slice no-data hour instead of inventing a missing-price error', () => {
    const item = { ...observation('gpt-6.1-sol', '2026-09-29'), inputTokens: '0', outputTokens: '0',
      billingSlices: [], metricsStatus: 'noData' as const }
    expect(calculateDeploymentCost(item, book([manual()]), hour)).toMatchObject({
      costUsd: '0.000000000000', pricingStatus: 'matched', issues: [],
    })
  })

  it('uses official prices when both official and manual cover the model and region', () => {
    const result = calculateDeploymentCost(observation(), book([manual({ modelName: 'gpt-4.1', inputUsdPerMillion: '99' })]), hour)
    expect(result.costUsd).toBe('18.000000000000')
    expect(result.prices.every((price) => price.source === 'official' && price.meterId !== null)).toBe(true)
  })

  it('uses official known-direction subtotals for every model and never replaces a missing official direction with manual estimates', () => {
    const result = calculateDeploymentCost(observation('gpt-6-luna', '2026-09-22'), book(
      [manual({ modelName: 'gpt-6-luna' })],
      [{ ...input, meterId: guid(50), skuName: '6-luna ShortCo Inp Std Gl', productName: 'Azure OpenAI GPT6' }],
    ), hour)
    expect(result).toMatchObject({ costUsd: '2.000000000000', costUpperUsd: null, pricingStatus: 'missing' })
    expect(result.prices.every((price) => price.source === 'official')).toBe(true)
    expect(result.issues[0]?.code).toBe('PRICE_MATCH_FAILED')
  })

  it('does not mix a missing official direction with manual prices', () => {
    const value = book([manual({ modelName: 'gpt-4.1' })])
    value.official!.rates = value.official!.rates.filter((rate) => rate.direction === 'input')
    const result = calculateDeploymentCost(observation(), value, hour)
    expect(result.costUsd).toBe('2.000000000000')
    expect(result.costUpperUsd).toBeNull()
    expect(result.pricingStatus).toBe('missing')
    expect(result.prices.some((price) => price.source === 'manual')).toBe(false)
  })

  it.each([
    { regions: ['eastus'] }, { modelVersion: 'different-version' }, { deploymentSku: 'Standard' as const },
    { effectiveFromUtc: '2026-10-05T10:00:00.000Z' }, { effectiveToUtc: hour }, { enabled: false },
  ])('enforces the model version, SKU, region, effective interval and enabled flag: %j', (change) => {
    expect(calculateDeploymentCost(observation('gpt-6.1-sol', '2026-09-29'), book([manual(change)]), hour).costUsd).toBeNull()
  })

  it('uses all regions only when the rule explicitly has all-region scope', () => {
    const result = calculateDeploymentCost(observation('gpt-6.1-sol', '2026-09-29', 'eastus'),
      book([manual({ regionScope: 'all', regions: [] })]), hour)
    expect(result.costUsd).toBe('17.000000000000')
  })

  it('keeps a prior price applicable to its original hour after edit and disable versions are added', () => {
    const values = [
      manual({ effectiveToUtc: '2026-10-05T10:00:00.000Z' }),
      manual({ revision: 2, inputUsdPerMillion: '4', effectiveFromUtc: '2026-10-05T10:00:00.000Z',
        effectiveToUtc: '2026-10-05T11:00:00.000Z' }),
      manual({ revision: 3, enabled: false, effectiveFromUtc: '2026-10-05T11:00:00.000Z' }),
    ]
    const item = observation('gpt-6.1-sol', '2026-09-29')
    expect(calculateDeploymentCost(item, book(values), hour).costUsd).toBe('17.000000000000')
    expect(calculateDeploymentCost(item, book(values), '2026-10-05T10:00:00.000Z').costUsd).toBe('18.000000000000')
    expect(calculateDeploymentCost(item, book(values), '2026-10-05T11:00:00.000Z').costUsd).toBeNull()
  })

  it('surfaces ambiguous wildcard/specific or duplicate manual scopes without guessing', () => {
    const result = calculateDeploymentCost(observation('gpt-6.1-sol', '2026-09-29'), book([
      manual(), manual({ ruleId: guid(51), modelVersion: '2026-09-29' }),
    ]), hour)
    expect(result).toMatchObject({ costUsd: null, pricingStatus: 'ambiguous', prices: [] })
    expect(result.issues[0]?.code).toBe('MANUAL_PRICE_AMBIGUOUS')
  })

  it('preserves failed metrics and unverified historical deployment guards even with a manual price', () => {
    const item = observation('gpt-6.1-sol', '2026-09-29')
    expect(calculateDeploymentCost({ ...item, inputTokens: null, metricsStatus: 'failed' }, book([manual()]), hour).costUsd).toBeNull()
    const result = calculateDeploymentCost({ ...item, metadataVerified: false }, book([manual()]), hour)
    expect(result.costUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('HISTORICAL_DEPLOYMENT_UNVERIFIED')
  })

  it('permits a known missing official catalog only for independently entered manual fallback rules', () => {
    const value = book([manual()])
    value.official = null
    expect(calculateDeploymentCost(observation('gpt-6.1-sol', '2026-09-29'), value, hour).costUsd).toBe('17.000000000000')
  })
})

describe('manual price input validation', () => {
  const value = { modelName: 'gpt-6.1-sol', deploymentSku: 'GlobalStandard', regionScope: 'selected',
    regions: ['swedencentral'], inputUsdPerMillion: '3', outputUsdPerMillion: '7' }
  it.each([
    { modelName: '' }, { inputUsdPerMillion: '' }, { outputUsdPerMillion: '-1' }, { inputUsdPerMillion: 'NaN' },
    { regions: [] }, { regionScope: 'all' }, { deploymentSku: 'ProvisionedManaged' },
    { modelName: 'gpt-4o-audio-preview' }, { modelName: 'gpt-realtime-2' }, { modelName: 'text-embedding-3-large' },
  ])('rejects invalid prices or special billing models: %j', (change) => {
    expect(ManualPriceInputSchema.safeParse({ ...value, ...change }).success).toBe(false)
  })
  it('normalizes model/regions while retaining explicitly entered zero and an explicit all-region scope', () => {
    expect(ManualPriceInputSchema.parse({ ...value, modelName: ' GPT-6.1-SOL ', regions: [' SwedenCentral ', 'swedencentral'],
      inputUsdPerMillion: '0' })).toMatchObject({ modelName: 'gpt-6.1-sol', regions: ['swedencentral'], inputUsdPerMillion: '0' })
    expect(ManualPriceInputSchema.parse({ ...value, regionScope: 'all', regions: [] }).regionScope).toBe('all')
  })
  it('does not accept null official meters or untraceable manual references', () => {
    const base = { direction: 'input', meterId: guid(60), unitQuantity: '1000000', unitPriceUsd: '2',
      effectiveStartUtc: hour, snapshotId: guid(1) }
    expect(UsagePriceReferenceSchema.safeParse(base).success).toBe(true)
    expect(UsagePriceReferenceSchema.safeParse({ ...base, meterId: null }).success).toBe(false)
    expect(UsagePriceReferenceSchema.safeParse({ ...base, source: 'manual', meterId: null }).success).toBe(false)
    expect(UsagePriceReferenceSchema.safeParse({ ...base, source: 'manual', meterId: null, manualPriceId: guid(3), manualPriceRevision: 1 }).success).toBe(true)
  })
})
