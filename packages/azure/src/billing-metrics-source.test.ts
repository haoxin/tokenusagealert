import { describe, expect, it, vi } from 'vitest'
import {
  BillingTelemetrySchema, CompactPriceCatalogSchema, DeploymentUsageSchema,
  type ResourceInventory, type SubscriptionInventoryDocument, type UsagePriceBook,
} from '@tokenusagealert/schemas'
import { calculateDeploymentCost, evaluateAlertHour, initialAlertState, summarizeUsageCosts } from '@tokenusagealert/domain'
import { ArmUsageSource } from './usage-source.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const subscription = '22222222-2222-4222-8222-222222222222'
const account = `/subscriptions/${subscription}/resourceGroups/fixture/providers/Microsoft.CognitiveServices/accounts/mock`
const window = { windowStartUtc: '2026-11-06T00:00:00.000Z', windowEndUtc: '2026-11-06T01:00:00.000Z' }
const identity = ['ModelDeploymentName', 'ModelName', 'ModelVersion']
const now = new Date().toISOString()
const subscriptions: SubscriptionInventoryDocument = {
  schemaVersion: 1, revision: 1, tenantId: tenant, expectedSubscriptionIds: [subscription], observedAtUtc: now, updatedAtUtc: now,
  subscriptions: [{ subscriptionId: subscription, displayName: 'Fixture', customerTenantId: tenant, state: 'Enabled',
    firstSeenAtUtc: '2026-10-01T00:00:00Z', lastSeenAtUtc: now, lastValidatedAtUtc: now }],
}
interface Options {
  tier?: boolean
  rate?: boolean
  counts?: boolean
  format?: 'OpenAI' | 'Anthropic' | 'xAI'
  mismatch?: boolean
  responseTier?: string
  requestOnly?: boolean
  directTier?: boolean
  missingResponse?: boolean
  fail?: 'tier' | 'cache' | 'cost'
  cost?: boolean
  costValue?: number
  costUnit?: string
  emptyCost?: boolean
  emptyCache?: boolean
  rateValue?: number
  rateUnit?: string
  duplicate?: boolean
  wrongVersion?: boolean
  unsafeCount?: boolean
  wrongCacheVersion?: boolean
  nullCache?: boolean
  truncatedCache?: boolean
}
function fixture(options: Options = {}) {
  const inventory: ResourceInventory = {
    schemaVersion: 1, tenantId: tenant, observedAtUtc: now, issues: [],
    subscriptionDiscovery: [{ subscriptionId: subscription, discoveredAtUtc: now }],
    accounts: [{ id: account, name: 'mock', kind: 'AIServices', region: 'swedencentral', subscriptionId: subscription,
      modelsMetricDimensions: [...identity] }],
    deployments: [{ id: `${account}/deployments/chat`, subscriptionId: subscription, accountId: account, accountName: 'mock',
      accountKind: 'AIServices', region: 'swedencentral', name: 'chat', modelName: 'gpt-fixture',
      modelVersion: '2026-01-01', modelFormat: options.format ?? 'OpenAI', sku: 'GlobalStandard',
      firstObservedAtUtc: '2026-10-01T00:00:00Z', observedAtUtc: now, deleted: false }],
  }
  const requests: URL[] = []
  const metadata = (legacy: boolean, tier?: string) => [
    { name: { value: 'ModelDeploymentName' }, value: 'chat' },
    ...legacy ? [] : [{ name: { value: 'ModelName' }, value: 'gpt-fixture' }],
    { name: { value: 'ModelVersion' }, value: options.wrongVersion && !legacy ? 'wrong-version' : '2026-01-01' },
    ...tier === undefined ? [] : [{ name: { value: 'ServiceTierResponse' }, value: tier }],
    { name: { value: 'ServiceTierRequest' }, value: 'priority' },
  ]
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/metricDefinitions')) {
      const definitions = ['InputTokens', 'OutputTokens'].map((name) => ({
        name: { value: name }, unit: 'Count', supportedAggregationTypes: ['Total'],
        dimensions: [...identity, ...options.directTier ? ['ServiceTierResponse'] : [],
          ...options.requestOnly ? ['ServiceTierRequest'] : []].map((value) => ({ value })),
      }))
      if (options.tier) definitions.push(...['ProcessedPromptTokens', 'GeneratedTokens'].map((name) => ({
        name: { value: name }, unit: 'Count', supportedAggregationTypes: ['Total'],
        dimensions: ['ModelDeploymentName', 'ModelVersion', ...options.requestOnly
          ? ['ServiceTierRequest'] : ['ServiceTierResponse']].map((value) => ({ value })),
      })))
      if (options.rate) definitions.push({
        name: { value: 'AzureOpenAIContextTokensCacheMatchRate' }, unit: 'Percent', supportedAggregationTypes: ['Average'],
        dimensions: [...identity, 'Region'].map((value) => ({ value })),
      })
      if (options.counts) definitions.push(...['cacheReadInputTokens', 'ephemeral5mInputTokens', 'ephemeral1hInputTokens'].map((name) => ({
        name: { value: name }, unit: 'Count', supportedAggregationTypes: ['Total'], dimensions: identity.map((value) => ({ value })),
      })))
      if (options.cost) definitions.push({
        name: { value: 'FoundryModelEstimatedCost' }, unit: 'Unspecified', supportedAggregationTypes: ['Total'],
        dimensions: identity.map((value) => ({ value })),
      })
      return Response.json({ value: definitions })
    }
    if (!url.pathname.endsWith('/metrics')) throw new Error('Resource discovery must remain cached.')
    expect(url.searchParams.get('interval')).toBe('PT1H')
    expect(url.searchParams.get('timespan')).toBe(`${window.windowStartUtc}/${window.windowEndUtc}`)
    expect(url.searchParams.get('metricnamespace')).toBe('Microsoft.CognitiveServices/accounts')
    const names = url.searchParams.get('metricnames')!.split(',')
    const legacy = names.includes('ProcessedPromptTokens')
    const cost = names.includes('FoundryModelEstimatedCost')
    const cache = !legacy && !cost && !names.includes('InputTokens')
    if ((legacy && options.fail === 'tier') || (cache && options.fail === 'cache') ||
      (cost && options.fail === 'cost')) return new Response(null, { status: 403 })
    return Response.json({ value: names.map((name) => {
      const rate = name === 'AzureOpenAIContextTokensCacheMatchRate'
      const output = name === 'OutputTokens' || name === 'GeneratedTokens'
      const points = (count: number) => [{ timeStamp: window.windowStartUtc, ...rate ? { average: count } : { total: count } },
        { timeStamp: window.windowEndUtc, ...rate ? { average: 100 } : { total: 9999 } }]
      const series = legacy ? [
        { metadatavalues: metadata(true, options.missingResponse ? undefined : 'default'), data: points(output ? 8 : 40) },
        { metadatavalues: metadata(true, options.missingResponse ? undefined : options.responseTier ?? 'priority'),
          data: points(output ? 12 : options.mismatch ? 59 : 60) },
      ] : [{ metadatavalues: metadata(false, options.directTier ? 'priority' : undefined),
        data: points(cost ? options.costValue ?? 2.855756600000002 : rate ? options.rateValue ?? 42.5 : name === 'cacheReadInputTokens'
          ? options.unsafeCount ? Number.MAX_SAFE_INTEGER + 1 : 60
          : name === 'ephemeral5mInputTokens' ? 4 : name === 'ephemeral1hInputTokens' ? 6 : output ? 20 : 100) }]
      if (cache && options.wrongCacheVersion) {
        series[0]!.metadatavalues.find((item) => item.name.value === 'ModelVersion')!.value = 'other-version'
      }
      if (cache && options.nullCache) series[0]!.data = [{ timeStamp: window.windowStartUtc }]
      if (options.duplicate && cache) series.push(structuredClone(series[0]!))
      return { name: { value: name }, unit: cost ? options.costUnit ?? 'Unspecified' : rate ? options.rateUnit ?? 'Percent' : 'Count', errorCode: 'Success',
        timeseries: cost && options.emptyCost || cache && options.emptyCache ? [] : cache && options.truncatedCache
          ? Array.from({ length: 10000 }, () => series[0]!) : series }
    }) })
  })
  const source = new ArmUsageSource(undefined, { fetcher,
    credential: { async getToken() { return { token: 'local-fixture-not-a-real-token' } } } })
  return { source, requests, inventory, collect: () => source.collect(tenant, subscriptions, inventory, window, AbortSignal.timeout(10_000)) }
}

describe('same-hour served tier and provider-specific cache telemetry', () => {
  it.each([
    [2.855756600000002, '2.855756600000'],
    [0.0000001, '0.000000100000'],
  ])('reads native USD %s independently without token rounding or exponent strings', async (costValue, costUsd) => {
    const result = await fixture({ cost: true, costValue }).collect()
    expect(result.observations[0]).toMatchObject({
      inputTokens: '100', outputTokens: '20', issues: [],
      foundryEstimatedCost: { metricName: 'FoundryModelEstimatedCost', currency: 'USD',
        status: 'available', costUsd, issue: null },
    })
  })

  it.each([
    [{ emptyCost: true }, 'noData'],
    [{ fail: 'cost' as const }, 'failed'],
    [{ costUnit: 'Count' }, 'failed'],
  ])('preserves unknown native cost and reference inputs for %j', async (options, status) => {
    const result = await fixture({ cost: true, ...options }).collect()
    const row = result.observations[0]!
    expect(row).toMatchObject({ inputTokens: '100', outputTokens: '20', metricsStatus: 'success', issues: [],
      foundryEstimatedCost: { status, costUsd: null } })
    if (status === 'failed') expect(row.foundryEstimatedCost?.issue?.code).toBe('FOUNDRY_ESTIMATED_COST_QUERY_FAILED')
  })

  it('refreshes a version-one capability cache before reading the newly supported native metric', async () => {
    const f = fixture({ cost: true })
    f.inventory.accounts[0]!.billingMetricCapabilities = { version: 1, definitions: [] }
    const result = await f.collect()
    expect(result.inventory.accounts[0]?.billingMetricCapabilities).toMatchObject({ version: 2 })
    expect(f.requests[0]?.pathname).toContain('/metricDefinitions')
    expect(result.observations[0]?.foundryEstimatedCost?.status).toBe('available')
  })

  it.each([true, false])('carries source cache and tier slices through estimation and alerts (cached prices available: %s)', async (cachedPrices) => {
    const collected = await fixture({ tier: true, rate: true }).collect()
    const rates = [
      ['input', 'standard', '2'], ['output', 'standard', '7'],
      ['input', 'priority', '6'], ['output', 'priority', '21'],
      ...cachedPrices ? [
        ['cachedInput', 'standard', '0.2'], ['cachedInput', 'priority', '0.6'],
        ['cacheWrite', 'standard', '2.5'], ['cacheWrite', 'priority', '7.5'],
      ] : [],
    ]
    const book: UsagePriceBook = {
      kind: 'usage-price-book',
      official: CompactPriceCatalogSchema.parse({
        schemaVersion: 2, kind: 'compact-official', snapshotId: tenant, fetchedAtUtc: window.windowStartUtc,
        generatedAtUtc: window.windowStartUtc, currency: 'USD', unitTokens: '1000000',
        models: ['gpt-fixture'], regions: ['swedencentral'], rawEntryCount: rates.length,
        rates: rates.map(([direction, tier, usd], index) => ({
          model: 'gpt-fixture', skuName: `fixture ${direction} ${tier} Gl`, sku: 'GlobalStandard',
          direction, tier, usd, context: 'uniform', modality: 'text', modelVersion: null, approvedMapping: true,
          effectiveFromUtc: '2026-01-01T00:00:00Z',
          regions: [{ name: 'swedencentral', meterId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }],
        })),
      }),
      manual: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] },
    }
    const priced = calculateDeploymentCost(collected.observations[0]!, book, window.windowStartUtc)
    expect(priced).toMatchObject({
      costUsd: cachedPrices ? '0.000579700000' : '0.000561000000',
      costUpperUsd: cachedPrices ? '0.000642950000' : null,
      pricingStatus: cachedPrices ? 'range' : 'missing',
      cacheReadEstimate: { method: 'hourly-match-rate', matchRatePercent: '42.5',
        estimatedReadTokens: '42.5', estimatedNonCachedInputTokens: '57.5', tierAllocation: 'same-ratio-per-tier' },
    })
    expect(DeploymentUsageSchema.parse(priced)).toEqual(priced)
    if (cachedPrices) {
      expect(priced.issues).toEqual([])
      expect(priced.prices.filter((price) => price.direction === 'cachedInput').map((price) => price.tier).sort())
        .toEqual(['priority', 'standard'])
    } else {
      expect(priced.issues.map((issue) => issue.code)).toEqual(Array(4).fill('CACHE_READ_PRICE_MISSING'))
    }
    const summary = summarizeUsageCosts([priced], priced.issues, 1, 1, false)
    expect(summary.status).toBe(cachedPrices ? 'complete' : 'partial')
    const hour = {
      ...window, status: summary.status, knownCostUsd: summary.knownCostUsd,
      knownCostUpperUsd: summary.knownCostUpperUsd, thresholdUsd: '0.0005',
    }
    expect(evaluateAlertHour(initialAlertState(), hour, null, true).kinds).toEqual(['cost-exceeded'])
    expect(evaluateAlertHour(initialAlertState(), { ...hour, thresholdUsd: '0.0006' }, null, true).kinds).toEqual([])
    expect(priced.billingTelemetry!.cache.matchRatePercent).toBe('42.5')
    expect(priced.billingTelemetry!.cache.readTokens).toBeNull()
  })

  it('replaces only verified billing slices without adding legacy token totals to Models', async () => {
    const f = fixture({ tier: true })
    const result = await f.collect()
    expect(result.observations[0]).toMatchObject({
      inputTokens: '100', outputTokens: '20', metricFamily: 'models-usage',
      billingTelemetry: { tierSource: 'azure-openai-usage' }, issues: [],
    })
    expect(result.observations[0]!.billingSlices).toEqual([
      expect.objectContaining({ direction: 'input', tokens: '40', tier: 'standard' }),
      expect.objectContaining({ direction: 'input', tokens: '60', tier: 'priority' }),
      expect.objectContaining({ direction: 'output', tokens: '8', tier: 'standard' }),
      expect.objectContaining({ direction: 'output', tokens: '12', tier: 'priority' }),
    ])
    const request = f.requests.find((url) => url.searchParams.get('metricnames')?.includes('ProcessedPromptTokens'))!
    expect(request.searchParams.get('$filter')).toContain("ServiceTierResponse eq '*'")
    expect(request.searchParams.get('$filter')).not.toContain('ServiceTierRequest')
  })

  it('prices a priority request served as default using the response tier, not the request', async () => {
    const result = await fixture({ tier: true, responseTier: 'default' }).collect()
    expect(result.observations[0]!.billingSlices!.every((slice) => slice.tier === 'standard')).toBe(true)
  })

  it('uses a directly advertised Models response tier without an extra legacy query', async () => {
    const f = fixture({ tier: true, directTier: true })
    const result = await f.collect()
    expect(result.observations[0]!.billingTelemetry!.tierSource).toBe('models')
    expect(result.observations[0]!.billingSlices!.every((slice) => slice.tier === 'priority')).toBe(true)
    expect(f.requests).toHaveLength(2)
  })

  it('never treats request-only priority dimensions as the billed tier', async () => {
    const f = fixture({ tier: true, requestOnly: true })
    const result = await f.collect()
    expect(result.observations[0]!.billingTelemetry!.tierSource).toBe('unknown')
    expect(result.observations[0]!.billingSlices!.every((slice) => slice.tier === null)).toBe(true)
    expect(f.requests).toHaveLength(2)
  })

  it.each([
    [{ mismatch: true }, 'SERVICE_TIER_TOTAL_MISMATCH'],
    [{ missingResponse: true }, 'SERVICE_TIER_RESPONSE_MISSING'],
    [{ responseTier: 'unexpected' }, 'SERVICE_TIER_TOTAL_MISMATCH'],
    [{ fail: 'tier' as const }, 'SERVICE_TIER_QUERY_FAILED'],
  ])('retains authoritative totals and marks incomplete tier supplements %s', async (options, code) => {
    const result = await fixture({ tier: true, ...options }).collect()
    expect(result.observations[0]).toMatchObject({
      inputTokens: '100', outputTokens: '20', metricsStatus: 'success',
      billingTelemetry: { tierSource: 'unknown' }, issues: [expect.objectContaining({ code })],
    })
  })

  it('records an hourly cache-hit percentage without manufacturing an exact cached token count', async () => {
    const f = fixture({ rate: true })
    const result = await f.collect()
    expect(result.observations[0]!.billingTelemetry!.cache).toEqual({
      source: 'openai-cache-match-rate', status: 'available', matchRatePercent: '42.5',
      readTokens: null, write5mTokens: null, write1hTokens: null,
    })
    const request = f.requests.find((url) => url.searchParams.get('aggregation') === 'Average')!
    expect(request.searchParams.get('$filter')).toBe(identity.map((name) => `${name} eq '*'`).join(' and '))
    expect(result.observations[0]!.inputTokens).toBe('100')
  })

  it.each([
    [0.0000001, '0.0000001'],
    [0.0000001234567890123456, '0.0000001234567890123456'],
  ] as const)('preserves a small cache percentage %s in the persisted decimal contract', async (rateValue, expected) => {
    const result = await fixture({ rate: true, rateValue }).collect()
    const telemetry = BillingTelemetrySchema.parse(result.observations[0]!.billingTelemetry)
    expect(telemetry.cache).toMatchObject({ status: 'available', matchRatePercent: expected, readTokens: null })
    expect(result.observations[0]!.issues).toEqual([])
  })

  it('keeps zero-percent cache observations distinct from unavailable or empty data', async () => {
    const result = await fixture({ rate: true, rateValue: 0 }).collect()
    expect(result.observations[0]!.billingTelemetry!.cache).toMatchObject({ status: 'available', matchRatePercent: '0' })
    const empty = await fixture({ rate: true, emptyCache: true }).collect()
    expect(empty.observations[0]!.billingTelemetry!.cache).toMatchObject({ status: 'noData', matchRatePercent: null })
    const missing = await fixture().collect()
    expect(missing.observations[0]!.billingTelemetry!.cache).toMatchObject({ status: 'unsupported', matchRatePercent: null })
  })

  it.each([{ rateValue: 101 }, { duplicate: true }, { rateUnit: 'Count' }, { fail: 'cache' as const },
    { wrongCacheVersion: true }, { truncatedCache: true }])(
    'rejects invalid cache telemetry without discarding Models totals (%s)', async (options) => {
      const result = await fixture({ rate: true, ...options }).collect()
      expect(result.observations[0]).toMatchObject({
        inputTokens: '100', outputTokens: '20',
        billingTelemetry: { cache: { status: 'failed', matchRatePercent: null } },
        issues: [expect.objectContaining({ code: 'CACHE_METRIC_QUERY_FAILED' })],
      })
    },
  )

  it('retains Anthropic cache-read and TTL-specific write counts separately from the Models input counter', async () => {
    const f = fixture({ format: 'Anthropic', counts: true, rate: true, tier: true })
    const result = await f.collect()
    expect(result.observations[0]).toMatchObject({
      inputTokens: '100', outputTokens: '20', billingTelemetry: { tierSource: 'unknown', cache: {
        source: 'anthropic-cache-tokens', status: 'available', matchRatePercent: null,
        readTokens: '60', write5mTokens: '4', write1hTokens: '6',
      } },
    })
    expect(f.requests).toHaveLength(3)
    expect(f.requests.filter((url) => url.searchParams.get('metricnames')?.includes('ProcessedPromptTokens'))).toHaveLength(0)
  })

  it.each(['OpenAI', 'xAI'] as const)('does not apply Anthropic cache counters to %s', async (format) => {
    const f = fixture({ format, counts: true })
    const result = await f.collect()
    expect(result.observations[0]!.billingTelemetry!.cache.status).toBe('unsupported')
    expect(f.requests).toHaveLength(2)
  })

  it('does not convert unsafe cache counter values to rounded token counts', async () => {
    const result = await fixture({ format: 'Anthropic', counts: true, unsafeCount: true }).collect()
    expect(result.observations[0]!.billingTelemetry!.cache).toMatchObject({ status: 'failed', readTokens: null })
    expect(result.observations[0]!.inputTokens).toBe('100')
  })

  it('keeps null cache counters unknown instead of reporting a measured zero', async () => {
    const result = await fixture({ format: 'Anthropic', counts: true, nullCache: true }).collect()
    expect(result.observations[0]!.billingTelemetry!.cache).toMatchObject({
      status: 'noData', readTokens: null, write5mTokens: null, write1hTokens: null,
    })
  })

  it('preserves verified served-tier slices when an independent cache query fails', async () => {
    const result = await fixture({ tier: true, rate: true, fail: 'cache' }).collect()
    expect(result.observations[0]!.billingTelemetry).toMatchObject({
      tierSource: 'azure-openai-usage', cache: { status: 'failed' },
    })
    expect(result.observations[0]!.billingSlices!.some((slice) => slice.tier === 'priority')).toBe(true)
  })

  it('reuses versioned billing capabilities without refreshing the two-hour resource inventory', async () => {
    const f = fixture({ tier: true, rate: true })
    const first = await f.collect()
    await f.source.collect(tenant, subscriptions, first.inventory, window, AbortSignal.timeout(10_000))
    expect(f.requests.filter((url) => url.pathname.endsWith('/metricDefinitions'))).toHaveLength(1)
    expect(f.source.telemetry().subscriptionCacheHits).toBe(2)
  })
})
