import { describe, expect, it } from 'vitest'
import {
  DeploymentUsageSchema, HourlyUsageSchema, PricingSnapshotSchema,
  type RetailPriceItem, type TokenObservation, type UsagePriceBook,
} from '@tokenusagealert/schemas'
import { compactOfficialPrices } from './compact-pricing.js'
import { normalizePrices, catalogModelName } from './pricing.js'
import { calculateDeploymentCost } from './usage.js'
import { repriceMissingUsageHour, summarizeUsageCosts } from './usage-summary.js'
import { evaluateAlertHour, initialAlertState } from './alerts.js'

const guid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const now = new Date('2026-10-06T04:00:00.000Z')
const window = '2026-10-06T01:00:00.000Z'
function meter(index: number, skuName: string, price: number, unit = '1M'): RetailPriceItem {
  return {
    currencyCode: 'USD', type: 'Consumption', meterId: guid(index), meterName: `${skuName} Tokens`,
    productId: 'fixture', productName: 'Azure OpenAI GPT9', skuId: `sku-${index}`, skuName,
    serviceName: 'Foundry Models', armRegionName: 'swedencentral',
    retailPrice: price, unitPrice: price, unitOfMeasure: unit, tierMinimumUnits: 0,
    effectiveStartDate: '2026-09-01T00:00:00Z', isPrimaryMeterRegion: true,
  }
}
function book(items: RetailPriceItem[]): UsagePriceBook {
  const { entries } = normalizePrices(items)
  const snapshot = PricingSnapshotSchema.parse({
    schemaVersion: 1, snapshotId: guid(100), fetchedAtUtc: '2026-10-06T00:00:00.000Z', source: 'fixture',
    apiVersion: '2023-01-01-preview', parserVersion: 3, currency: 'USD', cloud: 'AzureCloud',
    pageCount: 1, sourceRecordCount: entries.length, meterCount: entries.length, duplicateCount: 0,
    unsupportedMeterCount: entries.filter((entry) => entry.supportStatus !== 'supported').length,
    unrecognizedUnitCount: 0, contentHash: 'a'.repeat(64), entries,
    changes: { previousSnapshotId: null, addedMeterCount: entries.length, removedMeterCount: 0,
      changedPriceCount: 0, unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
  })
  return { kind: 'usage-price-book', official: compactOfficialPrices(snapshot, now),
    manual: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] } }
}
function observation(model = 'gpt-9-orion'): TokenObservation {
  return {
    deployment: {
      id: '/subscriptions/fixture/accounts/mock/deployments/future', subscriptionId: guid(101),
      accountId: '/accounts/mock', accountName: 'mock', accountKind: 'OpenAI', region: 'swedencentral',
      name: 'future', modelName: model, modelVersion: '2030-03-14', modelFormat: 'OpenAI', sku: 'GlobalStandard',
      firstObservedAtUtc: '2026-10-01T00:00:00.000Z', observedAtUtc: now.toISOString(), deleted: false,
    },
    inputTokens: '1000000', outputTokens: '2000000', metricsStatus: 'success', metadataVerified: true, issues: [],
  }
}
function contextBook() {
  return book([
    meter(1, '9-Orion ShortCo Inp Std Gl', 2), meter(2, '9-Orion ShortCo Opt Std Gl', 7),
    meter(3, '9-Orion LongCo Inp Std Gl', 4), meter(4, '9-Orion LongCo Opt Std Gl', 12),
  ])
}

describe('model-independent official billing', () => {
  it.each([
    ['gpt-9-orion', '9 Orion Inp Gl', '9 Orion Opt Gl'],
    ['gpt-9-ultra-solver', 'gpt 9 ultra solver Input Global', 'gpt 9 ultra solver Output Global'],
    ['acme-future-7', 'acme future 7 Input Global', 'acme future 7 Output Global'],
    ['o38-alpine', 'o38 alpine inp gl', 'o38 alpine opt gl'],
    ['gpt-audio-4-nano', 'gpt aud 4 nano inp Gl', 'gpt aud 4 nano opt Gl'],
    ['gpt-image-9-neon', 'Image 9 neon img inp Gl', 'Image 9 neon img opt Gl'],
  ])('automatically bills unseen %s from structural SKU/unit data, not a model-name or version whitelist', (model, input, output) => {
    const value = book([meter(10, input, 2), meter(11, output, 7)])
    expect(value.official!.models).toContain(model)
    const result = calculateDeploymentCost(observation(model), value, window)
    expect(result).toMatchObject({ costUsd: '16.000000000000', costUpperUsd: '16.000000000000', pricingStatus: 'matched', issues: [] })
    expect(result.prices.every((price) => price.source === 'official')).toBe(true)
    expect(DeploymentUsageSchema.parse(result)).toEqual(result)
  })

  it('returns a bounded official estimate when aggregated metrics cannot identify short/long request contexts', () => {
    const result = calculateDeploymentCost(observation(), contextBook(), window)
    expect(result).toMatchObject({ costUsd: '16.000000000000', costUpperUsd: '28.000000000000',
      pricingStatus: 'range', pricingUncertainty: ['context'], issues: [] })
    expect(result.prices).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: 'short', bound: 'lower' }),
      expect.objectContaining({ context: 'long', bound: 'upper' }),
    ]))
  })

  it('uses explicit metric context slices without equating the hourly token total to any single request context', () => {
    const item = observation()
    item.billingSlices = [
      { direction: 'input', tokens: '250000', context: 'short', modality: null, tier: 'standard' },
      { direction: 'input', tokens: '750000', context: 'long', modality: null, tier: 'standard' },
      { direction: 'output', tokens: '500000', context: 'short', modality: null, tier: 'standard' },
      { direction: 'output', tokens: '1500000', context: 'long', modality: null, tier: 'standard' },
    ]
    const result = calculateDeploymentCost(item, contextBook(), window)
    expect(result).toMatchObject({ costUsd: '25.000000000000', costUpperUsd: '25.000000000000', pricingStatus: 'matched' })
  })

  it('activates already-downloaded scheduled prices at their effective hour, not early and not one daily sync late', () => {
    const value = book([
      meter(33, '9 Orion Inp Gl', 2), meter(34, '9 Orion Opt Gl', 7),
      { ...meter(35, '9 Orion Inp Gl', 4), effectiveStartDate: '2026-10-06T03:00:00Z' },
    ])
    expect(value.official!.scheduledRates).toHaveLength(1)
    expect(calculateDeploymentCost(observation(), value, '2026-10-06T02:00:00.000Z').costUsd).toBe('16.000000000000')
    expect(calculateDeploymentCost(observation(), value, '2026-10-06T03:00:00.000Z').costUsd).toBe('18.000000000000')
    const regenerated = compactOfficialPrices({
      schemaVersion: 1, snapshotId: guid(100), fetchedAtUtc: '2026-10-06T00:00:00.000Z', source: 'fixture',
      apiVersion: '2023-01-01-preview', parserVersion: 3, currency: 'USD', cloud: 'AzureCloud',
      pageCount: 1, sourceRecordCount: 3, meterCount: 3, duplicateCount: 0, unsupportedMeterCount: 0,
      unrecognizedUnitCount: 0, contentHash: 'a'.repeat(64),
      entries: normalizePrices([
        meter(33, '9 Orion Inp Gl', 2), meter(34, '9 Orion Opt Gl', 7),
        { ...meter(35, '9 Orion Inp Gl', 4), effectiveStartDate: '2026-10-06T03:00:00Z' },
      ]).entries,
      changes: { previousSnapshotId: null, addedMeterCount: 3, removedMeterCount: 0,
        changedPriceCount: 0, unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
    }, new Date('2026-10-07T04:00:00.000Z'))
    expect(calculateDeploymentCost(observation(), { ...value, official: regenerated }, window).costUsd).toBe('16.000000000000')
  })

  it('does not double-count duplicated or incomplete token slices', () => {
    const item = observation()
    item.billingSlices = [{ direction: 'input', tokens: '1', context: 'short', modality: null, tier: 'standard' }]
    const result = calculateDeploymentCost(item, contextBook(), window)
    expect(result.costUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('TOKEN_SLICE_MISMATCH')
  })

  it('does not misclassify a successful no-data hour as missing prices when Monitor returns no billing slices', () => {
    const item = { ...observation(), inputTokens: '0', outputTokens: '0', billingSlices: [], metricsStatus: 'noData' as const }
    expect(calculateDeploymentCost(item, contextBook(), window)).toMatchObject({
      costUsd: '0.000000000000', costUpperUsd: '0.000000000000', pricingStatus: 'matched', issues: [],
    })
  })

  it('supports priority and flex meter contracts using the actual response tier', () => {
    const value = book([meter(12, '9 Orion PP Inp Gl', 6), meter(13, '9 Orion PP Opt Gl', 21)])
    const item = observation()
    item.billingSlices = [
      { direction: 'input', tokens: '1000000', context: null, modality: null, tier: 'priority' },
      { direction: 'output', tokens: '2000000', context: null, modality: null, tier: 'priority' },
    ]
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('48.000000000000')
    expect(calculateDeploymentCost(observation(), value, window).costUsd).toBeNull()
  })

  it('does not assume Standard service-tier rates when Models Usage totals omit the actual tier', () => {
    const value = book([
      meter(40, '9 Orion Inp Gl', 2), meter(41, '9 Orion Opt Gl', 7),
      meter(42, '9 Orion PP Inp Gl', 6), meter(43, '9 Orion PP Opt Gl', 21),
      meter(44, '9 Orion Fl Inp Gl', 1), meter(45, '9 Orion Fl Opt Gl', 3.5),
    ])
    const item = observation()
    item.metricFamily = 'models-usage'
    item.billingSlices = [
      { direction: 'input', tokens: '1000000', context: null, modality: null, tier: null },
      { direction: 'output', tokens: '2000000', context: null, modality: null, tier: null },
    ]
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '8.000000000000', costUpperUsd: '48.000000000000', pricingStatus: 'range', pricingUncertainty: ['tier'],
    })
    item.metricFamily = 'azure-openai-usage'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('16.000000000000')
  })

  it('keeps Foundry/xAI token usage unpriced without adding an official price and allows a later applicable user-entered rule', () => {
    const value = contextBook()
    const item = observation('grok-future')
    item.deployment.accountKind = 'AIServices'
    item.deployment.modelFormat = 'xAI'
    item.metricFamily = 'models-usage'
    item.billingSlices = [
      { direction: 'input', tokens: '1000000', context: null, modality: null, tier: null },
      { direction: 'output', tokens: '2000000', context: null, modality: null, tier: null },
    ]
    const missing = calculateDeploymentCost(item, value, window)
    expect(missing).toMatchObject({ inputTokens: '1000000', outputTokens: '2000000', costUsd: null, pricingStatus: 'missing' })
    expect(missing.issues[0]?.code).toBe('PRICE_MODEL_NOT_FOUND')
    value.manual = { schemaVersion: 1, revision: 1, snapshotId: guid(103), versions: [{
      ruleId: guid(104), revision: 1, modelName: 'grok-future', modelVersion: null, deploymentSku: 'GlobalStandard',
      regionScope: 'all', regions: [], inputUsdPerMillion: '2', outputUsdPerMillion: '10', note: 'Local fixture only',
      effectiveFromUtc: '2026-10-06T00:00:00.000Z', effectiveToUtc: null, enabled: true,
      updatedAtUtc: '2026-10-05T23:00:00.000Z', updatedByObjectId: 'fixture',
    }] }
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '22.000000000000', costUpperUsd: '22.000000000000', pricingStatus: 'matched',
    })
    expect(value.official!.models).not.toContain('grok-future')
  })

  it('uses batch rates only for the batch deployment contract, not cheaper batch prices on a Standard deployment', () => {
    const value = book([meter(14, '9 Orion Batch Inp Gl', 1), meter(15, '9 Orion Batch Opt Gl', 3.5)])
    const item = observation()
    item.deployment.sku = 'GlobalBatch'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('8.000000000000')
    expect(calculateDeploymentCost(observation(), value, window).costUsd).toBeNull()
  })

  it('matches per-version prices generically and does not use a newer different version merely because its price is latest', () => {
    const value = book([
      meter(16, '9 Orion 0513 Inp Gl', 2), meter(17, '9 Orion 0513 Opt Gl', 7),
      meter(18, '9 Orion 0613 Inp Gl', 100), meter(19, '9 Orion 0613 Opt Gl', 200),
    ])
    const item = observation()
    item.deployment.modelVersion = '2030-05-13'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('16.000000000000')
    item.deployment.modelVersion = '2030-07-13'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBeNull()
  })

  it('normalizes explicit ISO model-version labels without changing the canonical model name', () => {
    const value = book([meter(20, 'gpt 9 orion 2030-03-14 Inp Gl', 2), meter(21, 'gpt 9 orion 2030-03-14 Opt Gl', 7)])
    expect(value.official!.models).toEqual(['gpt-9-orion'])
    expect(calculateDeploymentCost(observation(), value, window).costUsd).toBe('16.000000000000')
  })

  it('handles future input-only embedding models and never requires an obsolete GPT-4.1 baseline', () => {
    const value = book([meter(22, 'text embedding 9 nova Gl', 0.0001, '1K')])
    const item = observation('text-embedding-9-nova')
    item.outputTokens = '0'
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '0.100000000000', costUpperUsd: '0.100000000000', pricingStatus: 'matched',
    })
  })

  it('does not convert unknown non-token units to zero or an input/output token rate', () => {
    const value = book([meter(23, '9 Orion Input Gl', 2, '1 Hour')])
    const result = calculateDeploymentCost(observation(), value, window)
    expect(result).toMatchObject({ costUsd: null, costUpperUsd: null, pricingStatus: 'unsupported' })
    expect(result.issues.some((issue) => issue.code === 'UNSUPPORTED_BILLING_UNIT')).toBe(true)
    const empty = { ...result, inputTokens: '0', outputTokens: '0' }
    expect(summarizeUsageCosts([empty], empty.issues, 1, 1, false)).toMatchObject({
      knownCostUsd: null, status: 'partial', activity: 'unknown',
    })
  })

  it('exposes additional non-token meters as a missing component instead of claiming a complete model total', () => {
    const value = book([meter(24, '9 Orion Inp Gl', 2), meter(25, '9 Orion Opt Gl', 7, '1 Hour')])
    const result = calculateDeploymentCost(observation(), value, window)
    expect(result).toMatchObject({ costUsd: '2.000000000000', costUpperUsd: null, pricingStatus: 'missing' })
    expect(result.issues.map((issue) => issue.code)).toContain('ADDITIONAL_BILLING_UNITS_MISSING')
  })

  it('does not use another region or ignore historical metadata verification', () => {
    const value = contextBook()
    const item = observation()
    item.deployment.region = 'eastus'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBeNull()
    item.deployment.region = 'swedencentral'
    item.metadataVerified = false
    const result = calculateDeploymentCost(item, value, window)
    expect(result.costUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('HISTORICAL_DEPLOYMENT_UNVERIFIED')
  })

  it('distinguishes text/audio token rates and uses explicit modality evidence when available', () => {
    const value = book([
      meter(26, 'gpt aud 4 nano txt inp Gl', 2), meter(27, 'gpt aud 4 nano txt opt Gl', 7),
      meter(28, 'gpt aud 4 nano inp Gl', 5), meter(29, 'gpt aud 4 nano opt Gl', 10),
    ])
    const item = observation('gpt-audio-4-nano')
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '16.000000000000', costUpperUsd: '25.000000000000', pricingStatus: 'range', pricingUncertainty: ['modality'],
    })
    item.billingSlices = [
      { direction: 'input', tokens: '1000000', context: null, modality: 'audio', tier: 'standard' },
      { direction: 'output', tokens: '2000000', context: null, modality: 'audio', tier: 'standard' },
    ]
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('25.000000000000')
  })

  it('includes unknown cache writes in an honest upper estimate, and replaces ordinary input rather than double-charging known writes', () => {
    const value = book([meter(30, '9 Orion Inp Gl', 2), meter(31, '9 Orion Opt Gl', 7), meter(32, '9 Orion Cd Wr Gl', 2.5)])
    const item = observation()
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '16.000000000000', costUpperUsd: '18.500000000000', pricingStatus: 'range', pricingUncertainty: ['cacheWrite'],
    })
    item.cacheWriteTokens = '100000'
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '16.050000000000', costUpperUsd: '16.050000000000', pricingStatus: 'matched',
    })
    item.cacheWriteTokens = '0'
    expect(calculateDeploymentCost(item, value, window).costUsd).toBe('16.000000000000')
    item.cacheWriteTokens = '1000001'
    const invalid = calculateDeploymentCost(item, value, window)
    expect(invalid.costUsd).toBeNull()
    expect(invalid.issues[0]?.code).toBe('CACHE_WRITE_COUNT_INVALID')
  })
})

describe('safe historical repricing and threshold envelopes', () => {
  function hour() {
    return HourlyUsageSchema.parse({
      schemaVersion: 1, tenantId: guid(102), windowStartUtc: window, windowEndUtc: '2026-10-06T02:00:00.000Z',
      collectedAtUtc: '2026-10-06T02:15:00.000Z', source: 'azure-monitor', status: 'partial', activity: 'hasUsage',
      finality: 'provisional', knownCostUsd: null, estimatedCostUsd: null, thresholdUsd: '1.00',
      inputTokens: '1000000', outputTokens: '2000000', priceSnapshotId: guid(100),
      estimatePolicy: 'cached-input-at-standard-rate', pricingRuleVersion: 2, validation: 'awaiting-positive-usage-verification',
      coverage: { expectedSubscriptions: 1, successfulSubscriptions: 1, accounts: 1, expectedDeployments: 1, successfulDeployments: 1, pricedDeployments: 0 },
      issues: [{ code: 'UNSUPPORTED_PRICING_RULE', message: 'Old model whitelist', resourceId: '/mock' }],
      breakdown: [{ ...observation(), costUsd: null, prices: [], pricingStatus: 'unsupported',
        issues: [{ code: 'UNSUPPORTED_PRICING_RULE', message: 'Old model whitelist', resourceId: '/mock' }] }],
    })
  }
  it('reprices only previously missing provisional amounts using the original snapshot while preserving observed tokens, window, collection time and threshold', () => {
    const before = hour()
    const after = repriceMissingUsageHour(before, contextBook(), now)
    expect(after).toMatchObject({ knownCostUsd: '16.000000000000', knownCostUpperUsd: '28.000000000000',
      status: 'complete', pricingRuleVersion: 3, issues: [], repricedAtUtc: now.toISOString(),
      collectedAtUtc: before.collectedAtUtc, thresholdUsd: before.thresholdUsd,
      inputTokens: before.inputTokens, outputTokens: before.outputTokens, priceSnapshotId: before.priceSnapshotId })
    expect(HourlyUsageSchema.parse(after)).toEqual(after)
    expect(before.knownCostUsd).toBeNull()
    expect(() => repriceMissingUsageHour(after, contextBook())).toThrow(/previously missing/)
    expect(() => repriceMissingUsageHour({ ...before, finality: 'final' }, contextBook())).toThrow(/provisional/)
    const other = contextBook()
    other.official!.snapshotId = guid(103)
    expect(() => repriceMissingUsageHour(before, other)).toThrow(/original official/)
  })

  it('alerts only when the estimate lower bound exceeds the threshold and recovers only when the complete upper bound is below it', () => {
    const before = initialAlertState()
    const ranged = { ...hour(), knownCostUsd: '0.90', knownCostUpperUsd: '1.50', status: 'complete' as const }
    expect(evaluateAlertHour(before, ranged, null, true).kinds).toEqual([])
    const breach = evaluateAlertHour(before, { ...ranged, knownCostUsd: '1.01' }, null, true)
    expect(breach.kinds).toEqual(['cost-exceeded'])
    const next = { ...ranged, windowStartUtc: ranged.windowEndUtc, windowEndUtc: '2026-10-06T03:00:00.000Z' }
    expect(evaluateAlertHour(breach.next, next, null, true).kinds).toEqual([])
    expect(evaluateAlertHour(breach.next, { ...next, knownCostUpperUsd: null }, null, true).kinds).toEqual([])
    expect(evaluateAlertHour(breach.next, { ...next, knownCostUpperUsd: '1.00' }, null, true).kinds).toEqual(['cost-recovered'])
  })
})
