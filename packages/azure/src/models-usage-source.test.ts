import { describe, expect, it, vi } from 'vitest'
import type { ResourceInventory, SubscriptionInventoryDocument } from '@tokenusagealert/schemas'
import { ArmUsageSource } from './usage-source.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const subscription = '22222222-2222-4222-8222-222222222222'
const account = `/subscriptions/${subscription}/resourceGroups/mock/providers/Microsoft.CognitiveServices/accounts/foundry`
const window = { windowStartUtc: '2026-10-06T01:00:00.000Z', windowEndUtc: '2026-10-06T02:00:00.000Z' }
const now = new Date().toISOString()
const subscriptions: SubscriptionInventoryDocument = {
  schemaVersion: 1, revision: 1, tenantId: tenant, expectedSubscriptionIds: [subscription],
  subscriptions: [{ subscriptionId: subscription, displayName: 'Local fixture', customerTenantId: tenant, state: 'Enabled',
    firstSeenAtUtc: '2026-10-01T00:00:00.000Z', lastSeenAtUtc: now, lastValidatedAtUtc: now }],
  observedAtUtc: now, updatedAtUtc: now,
}
const previous: ResourceInventory = {
  schemaVersion: 1, tenantId: tenant, observedAtUtc: now, issues: [],
  subscriptionDiscovery: [{ subscriptionId: subscription, discoveredAtUtc: now }],
  accounts: [{ id: account, name: 'foundry', kind: 'AIServices', region: 'swedencentral', subscriptionId: subscription,
    metricDimensions: ['ModelDeploymentName', 'FeatureName', 'ModelVersion', 'UsageChannel'] }],
  deployments: [{ id: `${account}/deployments/custom-name`, subscriptionId: subscription, accountId: account,
    accountName: 'foundry', accountKind: 'AIServices', region: 'swedencentral', name: 'custom-name',
    modelName: 'grok-future', modelVersion: 'future-version', modelFormat: 'xAI', sku: 'GlobalStandard',
    firstObservedAtUtc: '2026-10-01T00:00:00.000Z', observedAtUtc: now, deleted: false }],
}
function fixture(options: { missingDefinition?: boolean; failedMetric?: boolean; wrongModel?: boolean; empty?: boolean } = {}) {
  const requests: URL[] = []
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/metricDefinitions')) return Response.json({ value: ['InputTokens', 'OutputTokens'].map((name) => ({
      name: { value: name }, dimensions: (options.missingDefinition ? ['ModelDeploymentName']
        : ['ApiName', 'Region', 'ModelDeploymentName', 'ModelName', 'ModelVersion']).map((value) => ({ value })),
    })) })
    if (!url.pathname.endsWith('/metrics')) throw new Error('The two-hour cached resource discovery must not be repeated')
    expect(url.searchParams.get('metricnames')).toBe('InputTokens,OutputTokens')
    expect(url.searchParams.get('interval')).toBe('PT1H')
    expect(url.searchParams.get('timespan')).toBe(`${window.windowStartUtc}/${window.windowEndUtc}`)
    expect(url.searchParams.get('$filter')).toContain("ModelName eq '*'")
    expect(url.searchParams.get('$filter')).not.toContain('FeatureName')
    return Response.json({ value: ['InputTokens', 'OutputTokens'].map((name) => ({
      name: { value: name }, unit: 'Count', errorCode: options.failedMetric ? 'InternalError' : 'Success',
      timeseries: options.empty ? [] : [{
        metadatavalues: [{ name: { value: 'ModelDeploymentName' }, value: 'custom-name' },
          { name: { value: 'ModelName' }, value: options.wrongModel ? 'unexpected-model' : 'grok-future' },
          { name: { value: 'ModelVersion' }, value: 'future-version' }],
        data: [{ timeStamp: window.windowStartUtc, total: name === 'InputTokens' ? 200 : 300 },
          { timeStamp: window.windowEndUtc, total: 99999 }],
      }],
    })) })
  })
  return { requests, source: new ArmUsageSource(undefined, { fetcher,
    credential: { async getToken() { return { token: 'local-fixture-only' } } } }) }
}

describe('Models Usage generic resource collection', () => {
  it('collects AIServices/xAI by real ModelName, refreshes only the new metric cache and never adds old/new metric totals together', async () => {
    const f = fixture()
    const result = await f.source.collect(tenant, subscriptions, previous, window, AbortSignal.timeout(10_000))
    expect(result.inventory.issues).toEqual([])
    expect(result.observations).toEqual([expect.objectContaining({
      inputTokens: '200', outputTokens: '300', metricFamily: 'models-usage', metricsStatus: 'success', metadataVerified: true,
      billingSlices: [expect.objectContaining({ direction: 'input', tokens: '200', tier: null }),
        expect.objectContaining({ direction: 'output', tokens: '300', tier: null })],
    })])
    expect(result.inventory.accounts[0]?.metricDimensions).toEqual(previous.accounts[0]?.metricDimensions)
    expect(result.inventory.accounts[0]?.modelsMetricDimensions).toContain('ModelName')
    expect(f.requests).toHaveLength(2)
    expect(f.source.telemetry().subscriptionCacheHits).toBe(1)
    await f.source.collect(tenant, subscriptions, result.inventory, window, AbortSignal.timeout(10_000))
    expect(f.requests.filter((url) => url.pathname.endsWith('/metricDefinitions'))).toHaveLength(1)
    expect(f.requests.filter((url) => url.pathname.endsWith('/metrics'))).toHaveLength(2)
  })

  it('does not fallback to old token metrics or zero when Models dimensions are missing', async () => {
    const f = fixture({ missingDefinition: true })
    const result = await f.source.collect(tenant, subscriptions, previous, window, AbortSignal.timeout(10_000))
    expect(result.inventory.issues[0]?.code).toBe('METRIC_DEFINITION_MISSING')
    expect(result.observations[0]).toMatchObject({ inputTokens: null, outputTokens: null, metricsStatus: 'failed' })
    expect(f.requests).toHaveLength(1)
  })

  it('keeps metric-level errors as missing input/output rather than success-shaped no-usage', async () => {
    const f = fixture({ failedMetric: true })
    const result = await f.source.collect(tenant, subscriptions, previous, window, AbortSignal.timeout(10_000))
    expect(result.inventory.issues[0]?.code).toBe('METRIC_QUERY_FAILED')
    expect(result.observations[0]).toMatchObject({ inputTokens: null, outputTokens: null, metricsStatus: 'failed' })
  })

  it('preserves a model/version mismatch instead of deriving the model from a custom deployment name', async () => {
    const f = fixture({ wrongModel: true })
    const result = await f.source.collect(tenant, subscriptions, previous, window, AbortSignal.timeout(10_000))
    expect(result.observations[0]?.metadataVerified).toBe(false)
    expect(result.observations[0]?.issues[0]?.code).toBe('DEPLOYMENT_METADATA_CHANGED')
    expect(result.inventory.subscriptionDiscovery).toEqual([])
  })

  it('distinguishes a successful empty Models series from a failed API and keeps its metric-family marker', async () => {
    const f = fixture({ empty: true })
    const result = await f.source.collect(tenant, subscriptions, previous, window, AbortSignal.timeout(10_000))
    expect(result.observations[0]).toMatchObject({
      inputTokens: '0', outputTokens: '0', metricsStatus: 'noData', billingSlices: [], metricFamily: 'models-usage',
    })
  })
})
