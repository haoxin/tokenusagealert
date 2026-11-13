import { describe, expect, it } from 'vitest'
import { Decimal } from 'decimal.js'
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

  it('prices the reference as equal short/long contexts instead of choosing price extrema', () => {
    const result = calculateDeploymentCost(observation(), contextBook(), window)
    expect(result).toMatchObject({ costUsd: '22.000000000000', costUpperUsd: '22.000000000000',
      pricingStatus: 'matched', pricingUncertainty: ['context'], issues: [] })
    expect(result.prices).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: 'short', bound: 'both' }),
      expect.objectContaining({ context: 'long', bound: 'both' }),
    ]))
  })

  it('keeps actual context slices intact while using the declared fixed reference scenario', () => {
    const item = observation()
    item.billingSlices = [
      { direction: 'input', tokens: '250000', context: 'short', modality: null, tier: 'standard' },
      { direction: 'input', tokens: '750000', context: 'long', modality: null, tier: 'standard' },
      { direction: 'output', tokens: '500000', context: 'short', modality: null, tier: 'standard' },
      { direction: 'output', tokens: '1500000', context: 'long', modality: null, tier: 'standard' },
    ]
    const result = calculateDeploymentCost(item, contextBook(), window)
    expect(result).toMatchObject({ costUsd: '22.000000000000', costUpperUsd: '22.000000000000', pricingStatus: 'matched' })
    expect(result.billingSlices).toEqual(item.billingSlices)
  })

  it('does not truncate odd token quantities when allocating the two context halves', () => {
    const item = { ...observation(), inputTokens: '1', outputTokens: '3' }
    const result = calculateDeploymentCost(item, contextBook(), window)
    expect(result).toMatchObject({ costUsd: '0.000031500000', costUpperUsd: '0.000031500000' })
    expect(result.inputTokens).toBe('1')
    expect(result.outputTokens).toBe('3')
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
      costUsd: '16.000000000000', costUpperUsd: '16.500000000000', pricingStatus: 'range', pricingUncertainty: ['cacheWrite'],
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

describe('hourly cache-ratio estimation', () => {
  const prices = () => book([
    meter(70, '9 Orion Inp Gl', 2), meter(71, '9 Orion Opt Gl', 7),
    meter(72, '9 Orion Cd Inp Gl', 0.2), meter(73, '9 Orion Cd Wr Gl', 2.5),
  ])
  const cached = (percent: string | null = '25'): TokenObservation => ({
    ...observation(), billingTelemetry: {
      tierSource: 'unknown', cache: { source: 'openai-cache-match-rate',
        status: percent === null ? 'noData' : 'available', matchRatePercent: percent,
        readTokens: null, write5mTokens: null, write1hTokens: null },
    },
  })

  it('weights cached reads and known writes by context without charging ordinary input twice', () => {
    const value = book([
      meter(90, '9 Orion ShortCo Inp Std Gl', 2), meter(91, '9 Orion ShortCo Opt Std Gl', 7),
      meter(92, '9 Orion ShortCo Cd Inp Std Gl', 0.2), meter(93, '9 Orion ShortCo Cd Wr Std Gl', 2.5),
      meter(94, '9 Orion LongCo Inp Std Gl', 4), meter(95, '9 Orion LongCo Opt Std Gl', 12),
      meter(96, '9 Orion LongCo Cd Inp Std Gl', 0.4), meter(97, '9 Orion LongCo Cd Wr Std Gl', 5),
    ])
    const item = { ...cached('25'), inputTokens: '100', outputTokens: '0' }
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '0.000232500000', costUpperUsd: '0.000288750000',
    })
    const known = calculateDeploymentCost({ ...item, cacheWriteTokens: '10' }, value, window)
    expect(known).toMatchObject({ costUsd: '0.000240000000', costUpperUsd: '0.000240000000' })
    expect(known.billingTelemetry).toEqual(item.billingTelemetry)
  })

  describe('independent native hourly cost', () => {
    it('sums complete native coverage but never presents missing deployments or subscriptions as a full amount', () => {
      const item = observation()
      item.foundryEstimatedCost = {
        metricName: 'FoundryModelEstimatedCost', currency: 'USD', status: 'available',
        costUsd: '2.855756600000', retrievedAtUtc: now.toISOString(), issue: null,
      }
      const first = calculateDeploymentCost(item, contextBook(), window)
      const second = calculateDeploymentCost({
        ...item, deployment: { ...item.deployment, id: '/fixture/second', name: 'second' },
        foundryEstimatedCost: { ...item.foundryEstimatedCost, costUsd: '0.606792000000' },
      }, contextBook(), window)
      expect(summarizeUsageCosts([first, second], [], 1, 1, false).foundryEstimatedCost)
        .toMatchObject({ status: 'available', costUsd: '3.462548600000' })
      const missing = { ...second, foundryEstimatedCost: { ...item.foundryEstimatedCost, status: 'noData' as const, costUsd: null } }
      const partial = summarizeUsageCosts([first, missing], [], 1, 1, false)
      expect(partial.foundryEstimatedCost).toMatchObject({ status: 'partial', costUsd: null })
      expect(partial.status).toBe('complete')
      expect(summarizeUsageCosts([first, second], [], 0, 1, false).foundryEstimatedCost)
        .toMatchObject({ status: 'partial', costUsd: null })
    })
  })

  it('splits input by the observed ratio, uses the cached price and does not fabricate measured counters', () => {
    const item = cached()
    const result = calculateDeploymentCost(item, prices(), window)
    expect(result).toMatchObject({
      costUsd: '15.550000000000', costUpperUsd: '15.925000000000', pricingStatus: 'range',
      pricingUncertainty: ['cacheRead', 'cacheWrite'],
      cacheReadEstimate: { method: 'hourly-match-rate', matchRatePercent: '25',
        estimatedReadTokens: '250000', estimatedNonCachedInputTokens: '750000', tierAllocation: 'same-ratio-per-tier' },
    })
    expect(result.billingTelemetry).toEqual(item.billingTelemetry)
    expect(result.billingTelemetry!.cache.readTokens).toBeNull()
    expect(result.prices).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'cachedInput', unitPriceUsd: '0.2', tier: 'standard' }),
      expect.objectContaining({ direction: 'cacheWrite', unitPriceUsd: '2.5', bound: 'upper' }),
    ]))
    expect(DeploymentUsageSchema.parse(result)).toEqual(result)
  })

  it.each([
    ['0', '16.000000000000', '16.500000000000', '0'],
    ['100', '14.200000000000', '14.200000000000', '1000000'],
  ])('handles %s percent without allocating the same input to cache reads and writes', (percent, lower, upper, reads) => {
    const result = calculateDeploymentCost(cached(percent), prices(), window)
    expect(result.costUsd).toBe(lower)
    expect(result.costUpperUsd).toBe(upper)
    expect(result.cacheReadEstimate!.estimatedReadTokens).toBe(reads)
  })

  it('keeps fractional estimated tokens through pricing rather than rounding them into an exact count', () => {
    const result = calculateDeploymentCost({
      ...cached('0.8065233094404624'), inputTokens: '7034', outputTokens: '0', cacheWriteTokens: '0',
    }, prices(), window)
    expect(result.cacheReadEstimate).toMatchObject({
      estimatedReadTokens: '56.730849586042125216', estimatedNonCachedInputTokens: '6977.269150413957874784',
    })
    expect(result.costUsd).toBe('0.013965884471')
    expect(result.costUpperUsd).toBe(result.costUsd)
  })

  it('replaces only noncached ordinary input for a known write count', () => {
    const result = calculateDeploymentCost({ ...cached(), cacheWriteTokens: '100000' }, prices(), window)
    expect(result).toMatchObject({ costUsd: '15.600000000000', costUpperUsd: '15.600000000000',
      pricingStatus: 'matched', pricingUncertainty: ['cacheRead'] })
  })

  it.each(['750001', '-1', '0.5'])('rejects invalid or overlapping write quantities %s', (cacheWriteTokens) => {
    const result = calculateDeploymentCost({ ...cached(), cacheWriteTokens }, prices(), window)
    expect(result.costUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('CACHE_WRITE_COUNT_INVALID')
  })

  it.each(['-1', '100.1', 'NaN'])('rejects invalid cache rates %s explicitly', (percent) => {
    const result = calculateDeploymentCost(cached(percent), prices(), window)
    expect(result.costUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('CACHE_MATCH_RATE_INVALID')
  })

  it.each(['noData', 'failed', 'unsupported'] as const)('does not turn a %s ratio into a measured zero or apply a discount', (status) => {
    const item = cached(null)
    item.billingTelemetry!.cache.status = status
    const result = calculateDeploymentCost(item, prices(), window)
    expect(result.cacheReadEstimate).toBeUndefined()
    expect(result.costUsd).toBe('16.000000000000')
    expect(result.prices.some((price) => price.direction === 'cachedInput')).toBe(false)
  })

  it('preserves a partial known subtotal and unknown upper bound when the discounted read price is missing', () => {
    const value = book([meter(70, '9 Orion Inp Gl', 2), meter(71, '9 Orion Opt Gl', 7)])
    const result = calculateDeploymentCost(cached(), value, window)
    expect(result).toMatchObject({ costUsd: '15.500000000000', costUpperUsd: null, pricingStatus: 'missing' })
    expect(result.issues[0]?.code).toBe('CACHE_READ_PRICE_MISSING')
    expect(calculateDeploymentCost(cached('0'), value, window).issues).toEqual([])
    const writes = calculateDeploymentCost({ ...cached('0'), cacheWriteTokens: '1' }, value, window)
    expect(writes.costUsd).toBeNull()
    expect(writes.issues[0]?.code).toBe('CACHE_WRITE_PRICE_MISSING')
  })

  it('uses the deployment ratio per actual tier and the fixed context mix for cache-write bounds', () => {
    const value = book([
      meter(70, '9 Orion Inp Gl', 2), meter(71, '9 Orion Opt Gl', 7), meter(72, '9 Orion Cd Inp Gl', 0.2),
      meter(73, '9 Orion Cd Wr Gl', 2.5), meter(74, '9 Orion Inp Priority Gl', 6),
      meter(75, '9 Orion Opt Priority Gl', 21), meter(76, '9 Orion Cd Inp Priority Gl', 0.6),
      meter(77, '9 Orion Cd Wr Priority Gl', 7.5), meter(78, '9 Orion LongCo Cd Wr Priority Gl', 100),
    ])
    const item = cached('20')
    item.billingSlices = [
      { direction: 'input', tokens: '400000', tier: 'standard', context: 'short', modality: null },
      { direction: 'input', tokens: '600000', tier: 'priority', context: 'short', modality: null },
      { direction: 'output', tokens: '800000', tier: 'standard', context: 'short', modality: null },
      { direction: 'output', tokens: '1200000', tier: 'priority', context: 'short', modality: null },
    ]
    expect(calculateDeploymentCost(item, value, window)).toMatchObject({
      costUsd: '34.408000000000', costUpperUsd: '57.488000000000',
    })
    expect(calculateDeploymentCost({ ...item, cacheWriteTokens: '100000' }, value, window)).toMatchObject({
      costUsd: '34.458000000000', costUpperUsd: '39.183000000000',
    })
    const incomplete = { ...value, official: { ...value.official!,
      rates: value.official!.rates.filter((price) => price.direction !== 'cachedInput' || price.tier !== 'priority') } }
    expect(calculateDeploymentCost(item, incomplete, window).issues[0]?.code).toBe('CACHE_READ_PRICE_MISSING')
  })

  it('bounds every write allocation under the same cache-ratio assumption', () => {
    const item = { ...cached('25'), inputTokens: '20', outputTokens: '0' }
    for (let writes = 0; writes <= 15; writes += 1) {
      const actual = new Decimal(15 - writes).times(2).plus(1).plus(new Decimal(writes).times(2.5)).div(1000000)
      const unknown = calculateDeploymentCost(item, prices(), window)
      const known = calculateDeploymentCost({ ...item, cacheWriteTokens: String(writes) }, prices(), window)
      expect(new Decimal(unknown.costUsd!).lte(actual)).toBe(true)
      expect(new Decimal(unknown.costUpperUsd!).gte(actual)).toBe(true)
      expect(new Decimal(known.costUsd!).eq(actual)).toBe(true)
      expect(known.costUpperUsd).toBe(known.costUsd)
    }
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
    expect(after).toMatchObject({ knownCostUsd: '22.000000000000', knownCostUpperUsd: '22.000000000000',
      status: 'complete', pricingRuleVersion: 5, issues: [], repricedAtUtc: now.toISOString(),
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

  it('uses served priority token prices in the same existing hourly cost alert', () => {
    const value = book([
      meter(51, '9 Orion Inp Gl', 2), meter(52, '9 Orion Opt Gl', 7),
      meter(53, '9 Orion Inp Priority Gl', 6), meter(54, '9 Orion Opt Priority Gl', 21),
    ])
    const item = observation()
    item.metricFamily = 'models-usage'
    item.billingSlices = [
      { direction: 'input', tokens: '400000', tier: 'standard', context: null, modality: null },
      { direction: 'input', tokens: '600000', tier: 'priority', context: null, modality: null },
      { direction: 'output', tokens: '800000', tier: 'standard', context: null, modality: null },
      { direction: 'output', tokens: '1200000', tier: 'priority', context: null, modality: null },
    ]
    const costs = calculateDeploymentCost(item, value, window)
    expect(costs).toMatchObject({ costUsd: '35.200000000000', costUpperUsd: '35.200000000000', pricingStatus: 'matched' })
    expect(evaluateAlertHour(initialAlertState(), {
      ...hour(), knownCostUsd: costs.costUsd, knownCostUpperUsd: costs.costUpperUsd, thresholdUsd: '20', status: 'complete',
    }, null, true).kinds).toEqual(['cost-exceeded'])
    const downgraded = calculateDeploymentCost({
      ...item, billingSlices: item.billingSlices.map((slice) => ({ ...slice, tier: 'standard' })),
    }, value, window)
    expect(downgraded.costUsd).toBe('16.000000000000')
    expect(evaluateAlertHour(initialAlertState(), {
      ...hour(), knownCostUsd: downgraded.costUsd, thresholdUsd: '20', status: 'complete',
    }, null, true).kinds).toEqual([])
  })

  it('does not silently assume standard when Models has totals but no slices', () => {
    const value = book([
      meter(55, '9 Orion Inp Gl', 2), meter(56, '9 Orion Opt Gl', 7),
      meter(57, '9 Orion Inp Priority Gl', 6), meter(58, '9 Orion Opt Priority Gl', 21),
    ])
    expect(calculateDeploymentCost({ ...observation(), metricFamily: 'models-usage' }, value, window)).toMatchObject({
      costUsd: '16.000000000000', costUpperUsd: '48.000000000000', pricingStatus: 'range', pricingUncertainty: ['tier'],
    })
  })

  it('keeps the raw percentage separate from the estimate and does not invent a missing discounted price', () => {
    const item: TokenObservation = { ...observation(), billingTelemetry: {
      tierSource: 'unknown', cache: { source: 'openai-cache-match-rate', status: 'available', matchRatePercent: '99',
        readTokens: null, write5mTokens: null, write1hTokens: null },
    } }
    const result = calculateDeploymentCost(item, contextBook(), window)
    expect(result.costUsd).toBe('19.030000000000')
    expect(result.costUpperUsd).toBeNull()
    expect(result.issues[0]?.code).toBe('CACHE_READ_PRICE_MISSING')
    expect(result.cacheReadEstimate!.estimatedReadTokens).toBe('990000')
    expect(result.prices.some((price) => price.direction === 'cacheWrite')).toBe(false)
    expect(result.billingTelemetry).toEqual(item.billingTelemetry)
    const before = hour()
    before.breakdown[0]!.billingTelemetry = item.billingTelemetry
    expect(repriceMissingUsageHour(before, contextBook(), now).breakdown[0]!.billingTelemetry).toEqual(item.billingTelemetry)
  })

  it.each([['60', '4', '6'], [null, null, null]] as const)(
    'does not claim complete zero cost for unpriced Anthropic cache-only or unavailable usage %s', (readTokens, write5mTokens, write1hTokens) => {
      const item: TokenObservation = { ...observation(), inputTokens: '0', outputTokens: '0', metricsStatus: 'noData',
        billingTelemetry: { tierSource: 'unknown', cache: { source: 'anthropic-cache-tokens',
          status: readTokens === null ? 'noData' : 'available', matchRatePercent: null, readTokens, write5mTokens, write1hTokens } } }
      item.deployment.modelFormat = 'Anthropic'
      const result = calculateDeploymentCost(item, contextBook(), window)
      expect(result.issues.some((issue) => issue.code === 'CACHE_BILLING_UNVERIFIED')).toBe(true)
      expect(result.costUpperUsd).toBeNull()
      const summary = summarizeUsageCosts([result], result.issues, 1, 1, false)
      expect(summary.status).toBe('partial')
      expect(summary.estimatedCostUsd).toBeNull()
      expect(summary.activity).toBe(readTokens === null ? 'unknown' : 'hasUsage')
    },
  )

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

  it('compares the ratio-adjusted amount rather than the old undiscounted input estimate to the alert threshold', () => {
    const item = { ...observation(), billingTelemetry: {
      tierSource: 'unknown' as const, cache: { source: 'openai-cache-match-rate' as const, status: 'available' as const,
        matchRatePercent: '25', readTokens: null, write5mTokens: null, write1hTokens: null },
    } }
    const costs = calculateDeploymentCost(item, book([
      meter(70, '9 Orion Inp Gl', 2), meter(71, '9 Orion Opt Gl', 7),
      meter(72, '9 Orion Cd Inp Gl', 0.2), meter(73, '9 Orion Cd Wr Gl', 2.5),
    ]), window)
    expect(evaluateAlertHour(initialAlertState(), { ...hour(), status: 'complete', thresholdUsd: '15.7',
      knownCostUsd: costs.costUsd, knownCostUpperUsd: costs.costUpperUsd }, null, true).kinds).toEqual([])
    expect(evaluateAlertHour(initialAlertState(), { ...hour(), status: 'complete', thresholdUsd: '15.5',
      knownCostUsd: costs.costUsd, knownCostUpperUsd: costs.costUpperUsd }, null, true).kinds).toEqual(['cost-exceeded'])
  })
})
