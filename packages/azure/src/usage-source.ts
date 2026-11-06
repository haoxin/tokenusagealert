import { DefaultAzureCredential } from '@azure/identity'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { mapConcurrent, RequestLimiter } from '@tokenusagealert/domain'
import { UsageExecutionSettingsSchema } from '@tokenusagealert/schemas'
import type {
  DeploymentInventory, ResourceInventory, SubscriptionInventoryDocument,
  TokenObservation, UsageIssue, UsageExecutionSettings, TokenBillingSlice,
  BillingMetricCapabilities,
} from '@tokenusagealert/schemas'

export interface UsageWindow { windowStartUtc: string; windowEndUtc: string }
export interface UsageCollection {
  inventory: ResourceInventory
  observations: TokenObservation[]
  successfulSubscriptions: number
}
export interface UsageSource {
  readonly name: 'azure-monitor' | 'fixture'
  readonly metricFamily?: 'azure-openai-usage' | 'models-usage'
  collect(tenantId: string, subscriptions: SubscriptionInventoryDocument, previous: ResourceInventory | null, window: UsageWindow, signal: AbortSignal): Promise<UsageCollection>
  telemetry?(): UsageSourceTelemetry
}

export interface UsageSourceTelemetry {
  httpConcurrencyPeak: number
  subscriptionConcurrencyPeak: number
  globalSubscriptionPeak: number
  httpRequests: number
  throttledRequests: number
  retries: number
  subscriptionCacheHits: number
  subscriptionDiscoveryRefreshes: number
}

interface ArmUsageOptions {
  execution?: Partial<UsageExecutionSettings>
  fetcher?: typeof fetch
  credential?: { getToken(scope: string): Promise<{ token: string } | null> }
}

export class UsageReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UsageReadError' }
}

const accountSchema = z.object({
  id: z.string(), name: z.string(), kind: z.string(), location: z.string(),
}).passthrough()
const deploymentSchema = z.object({
  id: z.string(), name: z.string(),
  sku: z.object({ name: z.string() }).passthrough().optional(),
  properties: z.object({
    model: z.object({
      name: z.string(), version: z.string().optional(), format: z.string().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough()
const definitionSchema = z.object({
  value: z.array(z.object({
    name: z.object({ value: z.string() }),
    dimensions: z.array(z.object({ value: z.string() })).optional(),
    supportedAggregationTypes: z.array(z.string()).optional(),
    unit: z.string().optional(),
  }).passthrough()),
})
const metricsSchema = z.object({
  value: z.array(z.object({
    name: z.object({ value: z.string() }),
    errorCode: z.string().optional(),
    unit: z.string().optional(),
    timeseries: z.array(z.object({
      metadatavalues: z.array(z.object({
        name: z.object({ value: z.string() }), value: z.string(),
      })).optional(),
      data: z.array(z.object({
        timeStamp: z.iso.datetime({ offset: true }),
        total: z.number().finite().nonnegative().refine(Number.isSafeInteger).nullish(),
        average: z.number().finite().nonnegative().nullish(),
      })),
    })),
  })),
})
const requiredMetrics = ['InputTokens', 'OutputTokens'] as const
const tierMetrics = ['ProcessedPromptTokens', 'GeneratedTokens'] as const
const cacheRateMetric = 'AzureOpenAIContextTokensCacheMatchRate'
const cacheTokenMetrics = ['cacheReadInputTokens', 'ephemeral5mInputTokens', 'ephemeral1hInputTokens'] as const
const billingMetricNames = [...requiredMetrics, ...tierMetrics, cacheRateMetric, ...cacheTokenMetrics]
const identityDimensions = ['ModelDeploymentName', 'ModelName', 'ModelVersion']
const accountType = 'Microsoft.CognitiveServices/accounts'
const TOP_SERIES = 10000

function sameDeployment(a: DeploymentInventory, b: DeploymentInventory): boolean {
  return a.modelName === b.modelName && a.modelVersion === b.modelVersion &&
    a.sku === b.sku && a.region === b.region && !a.deleted
}

export class ArmUsageSource implements UsageSource {
  readonly name = 'azure-monitor' as const
  readonly metricFamily = 'models-usage' as const
  private readonly credential: { getToken(scope: string): Promise<{ token: string } | null> }
  private readonly execution: UsageExecutionSettings
  private readonly limiter: RequestLimiter
  private readonly fetcher: typeof fetch
  private token: Promise<{ token: string } | null> | undefined
  private readonly cooldowns = new Map<string, number>()
  private readonly activeSubscriptions = new Map<string, number>()
  private globalSubscriptions = 0
  private readonly stats: UsageSourceTelemetry = {
    httpConcurrencyPeak: 0, subscriptionConcurrencyPeak: 0, globalSubscriptionPeak: 0,
    httpRequests: 0, throttledRequests: 0, retries: 0,
    subscriptionCacheHits: 0, subscriptionDiscoveryRefreshes: 0,
  }
  constructor(clientId?: string, options: ArmUsageOptions = {}) {
    this.credential = options.credential ??
      (clientId ? new DefaultAzureCredential({ managedIdentityClientId: clientId }) : new DefaultAzureCredential())
    this.execution = UsageExecutionSettingsSchema.parse(options.execution ?? {})
    this.limiter = new RequestLimiter(Math.floor(this.execution.totalRequestConcurrency / this.execution.shardCount))
    this.fetcher = options.fetcher ?? fetch
  }

  telemetry(): UsageSourceTelemetry {
    return { ...this.stats, httpConcurrencyPeak: this.limiter.peak }
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, 'https://management.azure.com')
    if (url.origin !== 'https://management.azure.com') throw new UsageReadError('INVALID_ARM_PAGE', 'ARM 分页地址无效。')
    this.token ??= this.credential.getToken('https://management.azure.com/.default')
    const token = await this.token
    if (!token) throw new UsageReadError('ARM_AUTHENTICATION_FAILED', '无法取得管理面令牌。')
    const subscriptionKey = /\/subscriptions\/([^/]+)/i.exec(url.pathname)?.[1]?.toLowerCase() ?? 'tenant'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal.throwIfAborted()
      try {
        const result = await this.limiter.run(async () => {
          const wait = (this.cooldowns.get(subscriptionKey) ?? 0) - Date.now()
          if (wait > 0) await delay(wait, undefined, { signal })
          this.stats.httpRequests += 1
          const response = await this.fetcher(url, {
            headers: { authorization: `Bearer ${token.token}` },
            redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          })
          if (response.ok) return { ok: true as const, value: await response.json() as unknown }
          const retryAfter = response.headers.get('retry-after')
          await response.body?.cancel()
          return { ok: false as const, status: response.status, retryAfter }
        }, signal)
        if (result.ok) return result.value
        if (result.status === 429) this.stats.throttledRequests += 1
        if (attempt === 2 || ![429, 500, 502, 503, 504].includes(result.status)) {
          throw new UsageReadError('ARM_READ_FAILED', `Azure 管理面读取返回 HTTP ${result.status}；未将失败作为零用量。`)
        }
        const retryAfter = result.retryAfter
        const milliseconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - Date.now())
            : 1000 * 2 ** attempt + Math.floor(Math.random() * 250)
        if (result.status === 429) this.cooldowns.set(subscriptionKey, Date.now() + milliseconds)
        this.stats.retries += 1
        await delay(milliseconds, undefined, { signal })
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof UsageReadError || error instanceof SyntaxError) throw error
        if (attempt === 2) throw new UsageReadError('ARM_CONNECTION_FAILED', '管理面网络请求重试后仍失败。')
        this.stats.retries += 1
        await delay(1000 * 2 ** attempt, undefined, { signal })
      }
    }
    throw new UsageReadError('ARM_READ_FAILED', 'Azure 管理面重试耗尽。')
  }

  private async list<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
    const result: T[] = []
    const seen = new Set<string>()
    let next: string | null = path
    while (next) {
      if (seen.has(next) || seen.size >= 1000) throw new UsageReadError('INVALID_ARM_PAGE', 'ARM 分页重复或超过安全上限。')
      seen.add(next)
      const page: { value: unknown[]; nextLink?: string | null | undefined } = z.object({
        value: z.array(z.unknown()), nextLink: z.string().nullish(),
      }).parse(await this.get(next, signal))
      result.push(...page.value.map((item) => schema.parse(item)))
      next = page.nextLink ?? null
    }
    return result
  }

  async collect(tenantId: string, subscriptions: SubscriptionInventoryDocument, previous: ResourceInventory | null, window: UsageWindow, signal: AbortSignal): Promise<UsageCollection> {
    if (Date.parse(window.windowEndUtc) - Date.parse(window.windowStartUtc) !== 3_600_000) {
      throw new UsageReadError('INVALID_HOURLY_WINDOW', '每轮必须且只能查询一个完整小时。')
    }
    const now = new Date().toISOString()
    const inventory: ResourceInventory = {
      schemaVersion: 1, tenantId, observedAtUtc: now, accounts: [], deployments: [], issues: [], subscriptionDiscovery: [],
    }
    const observations: TokenObservation[] = []
    let successfulSubscriptions = 0
    const activeSubscriptions = subscriptions.subscriptions.filter((item) => item.state.toLowerCase() === 'enabled')
    const permittedIds = new Set(activeSubscriptions.map((item) => item.subscriptionId))
    const authorizationStarted = new Map(activeSubscriptions.map((item) => [item.subscriptionId, Date.parse(item.firstSeenAtUtc)]))
    const removedIds = new Set(subscriptions.removedSubscriptions?.map((item) => item.subscriptionId) ?? [])
    if (activeSubscriptions.some((item) => removedIds.has(item.subscriptionId))) {
      throw new UsageReadError('INCONSISTENT_AUTHORIZATION', '授权清单同时标记了采集与移出状态，停止本次采集。')
    }
    const old = new Map((previous?.deployments ?? []).filter((item) => permittedIds.has(item.subscriptionId) &&
      Date.parse(item.observedAtUtc) >= (authorizationStarted.get(item.subscriptionId) ?? Infinity))
      .map((item) => [item.id.toLowerCase(), item]))
    const oldByAccount = new Map<string, DeploymentInventory[]>()
    for (const deployment of old.values()) {
      const key = deployment.accountId.toLowerCase()
      const group = oldByAccount.get(key) ?? []
      group.push(deployment); oldByAccount.set(key, group)
    }
    const discoveries = new Map(previous?.subscriptionDiscovery?.map((item) => [item.subscriptionId, item.discoveredAtUtc]) ?? [])
    const accountsBySubscription = new Map<string, ResourceInventory['accounts']>()
    for (const account of previous?.accounts ?? []) {
      const accounts = accountsBySubscription.get(account.subscriptionId) ?? []
      accounts.push(account); accountsBySubscription.set(account.subscriptionId, accounts)
    }
    const unique = new Set<string>()
    for (const subscription of subscriptions.subscriptions) {
      if (subscription.customerTenantId !== tenantId) {
        throw new UsageReadError('TENANT_SCOPE_MISMATCH', '订阅 inventory 与客户租户不匹配。')
      }
      if (unique.has(subscription.subscriptionId)) throw new UsageReadError('DUPLICATE_SUBSCRIPTION', '授权清单包含重复订阅，不能重复计算费用。')
      unique.add(subscription.subscriptionId)
    }
    const results = await mapConcurrent(activeSubscriptions, this.execution.subscriptionConcurrency, async (subscription) => {
      this.globalSubscriptions += 1
      const active = (this.activeSubscriptions.get(tenantId) ?? 0) + 1
      this.activeSubscriptions.set(tenantId, active)
      this.stats.subscriptionConcurrencyPeak = Math.max(this.stats.subscriptionConcurrencyPeak, active)
      this.stats.globalSubscriptionPeak = Math.max(this.stats.globalSubscriptionPeak, this.globalSubscriptions)
      try {
        const scope = `/subscriptions/${subscription.subscriptionId}`
        const discoveredAt = discoveries.get(subscription.subscriptionId)
        const age = discoveredAt ? Date.parse(now) - Date.parse(discoveredAt) : Infinity
        const cached = age >= 0 && age < 2 * 3_600_000 &&
          Date.parse(discoveredAt!) >= Date.parse(subscription.firstSeenAtUtc)
        const relevant: ResourceInventory['accounts'] = cached
          ? (accountsBySubscription.get(subscription.subscriptionId) ?? []).map((account) => ({ ...account }))
          : (await this.list(`${scope}/providers/${accountType}?api-version=2026-05-01`, accountSchema, signal))
            .filter((item) => ['OpenAI', 'AIServices'].includes(item.kind))
            .map((account) => ({
              id: account.id, name: account.name, kind: account.kind, region: account.location,
              subscriptionId: subscription.subscriptionId,
            }))
        if (cached) this.stats.subscriptionCacheHits += 1
        else this.stats.subscriptionDiscoveryRefreshes += 1
        successfulSubscriptions += 1
        let cacheHealthy = true
        const accountResults = await mapConcurrent(relevant, this.execution.accountConcurrency, async (account) => {
          if (!account.id.toLowerCase().startsWith(`${scope.toLowerCase()}/`)) {
            throw new UsageReadError('RESOURCE_SCOPE_MISMATCH', '资源不属于授权订阅。')
          }
          inventory.accounts.push(account)
          let accountDeployments = oldByAccount.get(account.id.toLowerCase()) ?? []
          try {
            if (!cached) {
              const deployments = await this.list(`${account.id}/deployments?api-version=2026-05-01`, deploymentSchema, signal)
              const next: DeploymentInventory[] = deployments.map((item) => {
                const deployment: DeploymentInventory = {
                  id: item.id, subscriptionId: subscription.subscriptionId,
                  accountId: account.id, accountName: account.name, accountKind: account.kind,
                  region: account.region, name: item.name, modelName: item.properties.model.name,
                  modelVersion: item.properties.model.version ?? null, modelFormat: item.properties.model.format ?? null,
                  sku: item.sku?.name ?? null, firstObservedAtUtc: now, observedAtUtc: now, deleted: false,
                }
                const prior = old.get(item.id.toLowerCase())
                if (prior && sameDeployment(prior, deployment)) deployment.firstObservedAtUtc = prior.firstObservedAtUtc
                return deployment
              })
              const currentIds = new Set(next.map((item) => item.id.toLowerCase()))
              for (const prior of accountDeployments) {
                if (!currentIds.has(prior.id.toLowerCase()) && Date.parse(prior.observedAtUtc) >= Date.parse(now) - 240 * 3_600_000) {
                  next.push({ ...prior, deleted: true })
                }
              }
              accountDeployments = next
            }
            const capabilities = cached && account.modelsMetricDimensions && account.billingMetricCapabilities
              ? { dimensions: account.modelsMetricDimensions, billing: account.billingMetricCapabilities }
              : await this.metricCapabilities(account.id, signal)
            const dimensions = capabilities.dimensions
            account.modelsMetricDimensions = dimensions
            account.billingMetricCapabilities = capabilities.billing
            const points = await this.observeAccount(account.id, accountDeployments, window, dimensions, signal)
            await this.enrichBilling(account.id, accountDeployments, points, window, capabilities.billing, dimensions, signal)
            observations.push(...points)
            if (points.some((item) => item.issues.some((issue) => issue.code === 'DEPLOYMENT_METADATA_CHANGED'))) cacheHealthy = false
          } catch (error) {
            cacheHealthy = false
            const issue = this.issue(error, account.id)
            inventory.issues.push(issue)
            for (const deployment of accountDeployments) observations.push({
              deployment, inputTokens: null, outputTokens: null, metricsStatus: 'failed',
              metadataVerified: false, issues: [issue],
            })
          }
          inventory.deployments.push(...accountDeployments)
        }, signal)
        accountResults.forEach((result, index) => {
          if (result.status === 'rejected') {
            cacheHealthy = false
            inventory.issues.push(this.issue(result.reason, relevant[index]!.id))
          }
        })
        if (cacheHealthy) inventory.subscriptionDiscovery!.push({
          subscriptionId: subscription.subscriptionId,
          discoveredAtUtc: cached ? discoveredAt! : now,
        })
      } finally {
        this.globalSubscriptions -= 1
        this.activeSubscriptions.set(tenantId, (this.activeSubscriptions.get(tenantId) ?? 1) - 1)
      }
    }, signal)
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return
      const subscriptionId = activeSubscriptions[index]!.subscriptionId
      inventory.issues.push(this.issue(result.reason, `/subscriptions/${subscriptionId}`))
      // Preserve prior metadata on a read failure instead of losing it on the next run.
      inventory.accounts.push(...(previous?.accounts.filter((item) => item.subscriptionId === subscriptionId) ?? []))
      inventory.deployments.push(...(previous?.deployments.filter((item) => item.subscriptionId === subscriptionId) ?? []))
    })
    // A previously seen account that vanishes may still have charged usage in this window.
    const visibleAccountIds = new Set(inventory.accounts.map((item) => item.id.toLowerCase()))
    for (const account of previous?.accounts ?? []) {
      if (permittedIds.has(account.subscriptionId) && !visibleAccountIds.has(account.id.toLowerCase())) {
        inventory.issues.push({ code: 'PREVIOUS_RESOURCE_MISSING', message: '上次发现的资源已不可见，无法确认该小时是否有费用。', resourceId: account.id })
      }
    }
    inventory.accounts.sort((a, b) => a.id.localeCompare(b.id))
    inventory.deployments.sort((a, b) => a.id.localeCompare(b.id))
    return { inventory, observations, successfulSubscriptions }
  }

  private async metricCapabilities(accountId: string, signal: AbortSignal) {
    const definitions = definitionSchema.parse(await this.get(
      `${accountId}/providers/microsoft.insights/metricDefinitions?api-version=2018-01-01`, signal,
    ))
    const relevant = requiredMetrics.map((name) => definitions.value.find((item) => item.name.value === name))
    if (relevant.some((item) => ['ModelDeploymentName', 'ModelName', 'ModelVersion']
      .some((name) => !item?.dimensions?.some((dimension) => dimension.value === name)))) {
      throw new UsageReadError('METRIC_DEFINITION_MISSING', '缺少 Models InputTokens/OutputTokens 或部署/模型/版本维度；不会静默切回旧指标或补零。')
    }
    const dimensions = ['ModelDeploymentName', 'ModelVersion', 'ModelName', 'Region', 'ApiName',
      'ServiceTierRequest', 'ServiceTierResponse', 'ContextLength', 'ContextType', 'Modality', 'TokenType']
      .filter((name) => relevant.every((item) => item?.dimensions?.some((dimension) => dimension.value === name)))
    const billing: BillingMetricCapabilities = {
      version: 1,
      definitions: definitions.value.filter((item) => billingMetricNames.includes(item.name.value)).map((item) => ({
        name: item.name.value, dimensions: item.dimensions?.map((dimension) => dimension.value) ?? [],
        unit: item.unit ?? null, aggregations: item.supportedAggregationTypes ?? [],
      })),
    }
    return { dimensions, billing }
  }

  private async queryMetrics(accountId: string, names: readonly string[], aggregation: 'Total' | 'Average',
    window: UsageWindow, dimensions: string[], signal: AbortSignal) {
    const url = new URL(`https://management.azure.com${accountId}/providers/microsoft.insights/metrics`)
    url.searchParams.set('api-version', '2023-10-01')
    url.searchParams.set('metricnamespace', accountType)
    url.searchParams.set('metricnames', names.join(','))
    url.searchParams.set('aggregation', aggregation)
    url.searchParams.set('interval', 'PT1H')
    url.searchParams.set('timespan', `${window.windowStartUtc}/${window.windowEndUtc}`)
    url.searchParams.set('ValidateDimensions', 'true')
    url.searchParams.set('AutoAdjustTimegrain', 'false')
    url.searchParams.set('top', String(TOP_SERIES))
    url.searchParams.set('$filter', dimensions.map((name) => `${name} eq '*'`).join(' and '))
    return metricsSchema.parse(await this.get(url.href, signal))
  }

  private async observeAccount(accountId: string, deployments: DeploymentInventory[], window: UsageWindow, dimensions: string[], signal: AbortSignal): Promise<TokenObservation[]> {
    const metrics = await this.queryMetrics(accountId, requiredMetrics, 'Total', window, dimensions, signal)
    return this.observationsForWindow(metrics, deployments, window)
  }

  private observationsForWindow(metrics: z.infer<typeof metricsSchema>, deployments: DeploymentInventory[], window: UsageWindow,
    family: 'models' | 'tier' = 'models'): TokenObservation[] {
    const results = new Map(deployments.map((deployment) => [deployment.name, {
      deployment, input: 0n, output: 0n, points: 0,
      verified: !deployment.deleted && Date.parse(deployment.firstObservedAtUtc) <= Date.parse(window.windowStartUtc),
      issues: [] as UsageIssue[],
      slices: [] as TokenBillingSlice[],
    }]))
    for (const [direction, metricName] of (family === 'models' ? requiredMetrics : tierMetrics).entries()) {
      const metric = metrics.value.find((item) => item.name.value === metricName)
      if (!metric || (metric.errorCode && metric.errorCode !== 'Success') || (metric.unit && metric.unit !== 'Count')) {
        throw new UsageReadError('METRIC_QUERY_FAILED', `指标 ${metricName} 未成功返回。`)
      }
      if (metric.timeseries.length >= TOP_SERIES) throw new UsageReadError('METRICS_TRUNCATED', '指标序列达到响应上限，不能确认数据完整性。')
      for (const series of metric.timeseries) {
        const metadata = new Map(series.metadatavalues?.map((item) => [item.name.value.toLowerCase(), item.value]) ?? [])
        const name = metadata.get('modeldeploymentname')
        if (!name) throw new UsageReadError('DEPLOYMENT_DIMENSION_MISSING', '返回的指标序列缺少部署名称。')
        const result = results.get(name)
        if (!result) throw new UsageReadError('UNKNOWN_METRIC_DEPLOYMENT', `指标中出现未发现的部署 ${name}；可能在采集间隔内发生变更。`)
        const validPoints = series.data.filter((point) => point.total !== null && point.total !== undefined &&
          Date.parse(point.timeStamp) >= Date.parse(window.windowStartUtc) &&
          Date.parse(point.timeStamp) < Date.parse(window.windowEndUtc))
        const count = validPoints.reduce((sum, point) => sum + BigInt(point.total!), 0n)
        if (direction === 0) result.input += count
        else result.output += count
        result.points += validPoints.length
        const context = (metadata.get('contexttype') ?? metadata.get('contextlength') ?? '').toLowerCase().replace(/[-_ ]/g, '')
        const modality = (metadata.get('modality') ?? metadata.get('tokentype') ?? '').toLowerCase()
        const tier = (metadata.get('servicetierresponse') ?? '').toLowerCase()
        result.slices.push({
          direction: direction === 0 ? 'input' : 'output', tokens: count.toString(),
          context: ['short', 'shortco', 'shortcontext', 'shco'].includes(context) ? 'short'
            : ['long', 'longco', 'longcontext', 'loco'].includes(context) ? 'long' : null,
          modality: ['text', 'audio', 'image', 'video'].includes(modality)
            ? modality === 'text' ? 'text' : modality === 'audio' ? 'audio' : modality === 'image' ? 'image' : 'video' : null,
          tier: tier === 'default' || tier === 'standard' ? 'standard'
            : tier === 'priority' ? 'priority' : tier === 'batch' ? 'batch' : tier === 'flex' ? 'flex' : null,
        })
        if (count > 0n) {
          const model = metadata.get('modelname')
          if (metadata.get('modelversion') !== result.deployment.modelVersion ||
            (family === 'models' ? model !== result.deployment.modelName : model !== undefined && model !== result.deployment.modelName)) {
            result.verified = false
            result.issues.push({ code: 'DEPLOYMENT_METADATA_CHANGED', message: '指标中的模型/版本与缓存清单不同，下一轮提前刷新，不套用旧价格。', resourceId: result.deployment.id })
          }
          if (tier && !['default', 'standard', 'priority', 'batch', 'flex'].includes(tier)) {
            result.verified = false
            result.issues.push({ code: 'UNSUPPORTED_SERVICE_TIER', message: `无法匹配返回的服务档位 ${tier}，不套用普通价格。`, resourceId: result.deployment.id })
          }
        }
      }
    }
    return [...results.values()].map((result) => ({
      deployment: result.deployment, inputTokens: result.input.toString(), outputTokens: result.output.toString(),
      metricsStatus: result.points === 0 ? 'noData' : 'success',
      metadataVerified: result.verified, issues: result.issues,
      billingSlices: result.slices,
      metricFamily: this.metricFamily,
    }))
  }

  private async enrichBilling(accountId: string, deployments: DeploymentInventory[], observations: TokenObservation[],
    window: UsageWindow, capabilities: BillingMetricCapabilities, dimensions: string[], signal: AbortSignal) {
    const definition = (name: string, required: string[], unit: string, aggregation: string) =>
      capabilities.definitions.find((item) => item.name === name &&
        required.every((dimension) => item.dimensions.includes(dimension)) &&
        (item.unit === null || item.unit === unit) &&
        (item.aggregations.length === 0 || item.aggregations.includes(aggregation)))
    const openai = observations.filter((item) => item.deployment.modelFormat?.toLowerCase() === 'openai')
    const anthropic = observations.filter((item) => item.deployment.modelFormat?.toLowerCase() === 'anthropic')
    for (const item of observations) item.billingTelemetry = {
      tierSource: dimensions.includes('ServiceTierResponse') &&
        item.billingSlices?.some((slice) => BigInt(slice.tokens) > 0n) &&
        item.billingSlices.every((slice) => slice.tier !== null) ? 'models' : 'unknown',
      cache: { source: item.deployment.modelFormat?.toLowerCase() === 'anthropic' ? 'anthropic-cache-tokens' : 'unavailable',
        status: 'unsupported', matchRatePercent: null,
        readTokens: null, write5mTokens: null, write1hTokens: null },
    }
    const guarded = async (rows: TokenObservation[], code: string, message: string, work: () => Promise<void>, cache = false) => {
      try { await work() }
      catch (error) {
        signal.throwIfAborted()
        const detail = error instanceof UsageReadError ? ` ${error.code}: ${error.message}` : ''
        for (const item of rows) {
          item.issues.push({ code, message: `${message}${detail}`, resourceId: item.deployment.id })
          if (cache) item.billingTelemetry!.cache.status = 'failed'
        }
      }
    }
    const tasks: Promise<void>[] = []
    const tierDefinitions = tierMetrics.map((name) =>
      definition(name, ['ModelDeploymentName', 'ModelVersion', 'ServiceTierResponse'], 'Count', 'Total'))
    const tierRows = openai.filter((item) => item.billingTelemetry!.tierSource === 'unknown' &&
      !item.deployment.sku?.includes('Batch'))
    if (tierRows.length && tierDefinitions.every((item) => item !== undefined)) {
      tasks.push(guarded(tierRows, 'SERVICE_TIER_QUERY_FAILED', '实际服务档位补充读取失败；保留 Models 总量和档位不确定估算。', async () => {
        const split = ['ModelDeploymentName', 'ModelVersion', 'ModelName', 'ApiName', 'Region', 'ServiceTierResponse',
          'ContextLength', 'ContextType', 'Modality', 'TokenType']
          .filter((name) => tierDefinitions.every((item) => item!.dimensions.includes(name)))
        const metrics = await this.queryMetrics(accountId, tierMetrics, 'Total', window, split, signal)
        const supplemental = this.observationsForWindow(metrics, deployments, window, 'tier')
        for (const item of tierRows) {
          const other = supplemental.find((row) => row.deployment.id === item.deployment.id)!
          if (other.inputTokens !== item.inputTokens || other.outputTokens !== item.outputTokens ||
            !other.metadataVerified || other.issues.length) {
            item.issues.push({ code: 'SERVICE_TIER_TOTAL_MISMATCH',
              message: '实际服务档位指标与 Models 同小时模型/版本或输入输出总量不一致；未相加或覆盖，保留档位不确定估算。',
              resourceId: item.deployment.id })
          } else if (other.billingSlices?.length && other.billingSlices.every((slice) => slice.tier !== null)) {
            item.billingSlices = other.billingSlices
            item.billingTelemetry!.tierSource = 'azure-openai-usage'
          } else if (BigInt(item.inputTokens ?? '0') + BigInt(item.outputTokens ?? '0') > 0n) {
            item.issues.push({ code: 'SERVICE_TIER_RESPONSE_MISSING',
              message: '补充指标未给出实际响应档位，不以请求档位推断费用。', resourceId: item.deployment.id })
          }
        }
      }))
    }
    const rateDefinition = definition(cacheRateMetric, identityDimensions, 'Percent', 'Average')
    if (openai.length && rateDefinition) {
      for (const item of openai) item.billingTelemetry!.cache.source = 'openai-cache-match-rate'
      tasks.push(guarded(openai, 'CACHE_METRIC_QUERY_FAILED', '缓存命中率读取失败；未转换为缓存 token 数或补零。', async () => {
        const metrics = await this.queryMetrics(accountId, [cacheRateMetric], 'Average', window, identityDimensions, signal)
        const values = this.supplementalValues(metrics, cacheRateMetric, deployments, window, 'Percent', 'average')
        for (const item of openai) {
          const value = values.get(item.deployment.name)
          item.billingTelemetry!.cache.matchRatePercent = value === undefined ? null : String(value)
          item.billingTelemetry!.cache.status = value === undefined ? 'noData' : 'available'
        }
      }, true))
    }
    const cacheDefinitions = cacheTokenMetrics.map((name) => definition(name, identityDimensions, 'Count', 'Total'))
    const cacheNames = cacheTokenMetrics.filter((_, index) => cacheDefinitions[index] !== undefined)
    if (anthropic.length && cacheNames.length) {
      for (const item of anthropic) item.billingTelemetry!.cache.source = 'anthropic-cache-tokens'
      tasks.push(guarded(anthropic, 'CACHE_METRIC_QUERY_FAILED', 'Anthropic 缓存读写计数读取失败；缺失不作为零费用。', async () => {
        const metrics = await this.queryMetrics(accountId, cacheNames, 'Total', window, identityDimensions, signal)
        const values = new Map(cacheNames.map((name) => [name,
          this.supplementalValues(metrics, name, deployments, window, 'Count', 'total')]))
        for (const item of anthropic) {
          const cache = item.billingTelemetry!.cache
          const read = values.get('cacheReadInputTokens')?.get(item.deployment.name)
          const write5m = values.get('ephemeral5mInputTokens')?.get(item.deployment.name)
          const write1h = values.get('ephemeral1hInputTokens')?.get(item.deployment.name)
          cache.readTokens = read === undefined ? null : String(read)
          cache.write5mTokens = write5m === undefined ? null : String(write5m)
          cache.write1hTokens = write1h === undefined ? null : String(write1h)
          cache.status = [read, write5m, write1h].some((value) => value !== undefined) ? 'available' : 'noData'
        }
      }, true))
    }
    await Promise.all(tasks)
  }

  private supplementalValues(metrics: z.infer<typeof metricsSchema>, name: string, deployments: DeploymentInventory[],
    window: UsageWindow, unit: 'Count' | 'Percent', aggregation: 'total' | 'average') {
    const metric = metrics.value.find((item) => item.name.value === name)
    if (!metric || (metric.errorCode && metric.errorCode !== 'Success') || (metric.unit && metric.unit !== unit)) {
      throw new UsageReadError('CACHE_METRIC_INVALID', `缓存指标 ${name} 失败或单位不符。`)
    }
    if (metric.timeseries.length >= TOP_SERIES) throw new UsageReadError('METRICS_TRUNCATED', '缓存指标达到序列上限。')
    const values = new Map<string, number>()
    for (const series of metric.timeseries) {
      const metadata = new Map(series.metadatavalues?.map((item) => [item.name.value.toLowerCase(), item.value]) ?? [])
      const deployment = deployments.find((item) => item.name === metadata.get('modeldeploymentname'))
      if (!deployment || metadata.get('modelname') !== deployment.modelName ||
        metadata.get('modelversion') !== deployment.modelVersion || deployment.deleted) {
        throw new UsageReadError('CACHE_METRIC_IDENTITY_MISMATCH', '缓存指标部署/模型/版本与当前清单不一致。')
      }
      const points = series.data.filter((point) => point[aggregation] !== null && point[aggregation] !== undefined &&
        Date.parse(point.timeStamp) >= Date.parse(window.windowStartUtc) && Date.parse(point.timeStamp) < Date.parse(window.windowEndUtc))
      if (points.length > 1 || (points.length && values.has(deployment.name))) {
        throw new UsageReadError('CACHE_METRIC_DUPLICATE', '缓存指标分组或小时数据重复，未在应用中合并平均值。')
      }
      if (points.length) {
        const value = points[0]![aggregation]!
        if (unit === 'Percent' && value > 100) throw new UsageReadError('CACHE_RATE_INVALID', '缓存命中率必须在 0 到 100 之间。')
        values.set(deployment.name, value)
      }
    }
    return values
  }

  private issue(error: unknown, resourceId: string): UsageIssue {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return { code: 'USAGE_DEADLINE_EXCEEDED', message: '本次采集达到截止时间；尚未读取的数据没有填零。', resourceId }
    }
    return error instanceof UsageReadError
      ? { code: error.code, message: error.message, resourceId }
      : { code: 'USAGE_READ_FAILED', message: 'Azure 资源/指标响应无法读取或校验；保留为缺失数据。', resourceId }
  }
}

export class EmptyUsageSource implements UsageSource {
  readonly name = 'fixture' as const
  readonly metricFamily = 'models-usage' as const
  async collect(tenantId: string, subscriptions: SubscriptionInventoryDocument): Promise<UsageCollection> {
    return {
      inventory: { schemaVersion: 1, tenantId, observedAtUtc: new Date().toISOString(), accounts: [], deployments: [], issues: [] },
      observations: [],
      successfulSubscriptions: subscriptions.subscriptions.length,
    }
  }
}
