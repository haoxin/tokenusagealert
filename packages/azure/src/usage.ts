import { randomUUID } from 'node:crypto'
import { Decimal } from 'decimal.js'
import {
  calculateDeploymentCost, collectionWindow, indexUsagePrices, mapConcurrent, tenantShard, summarizeUsageCosts,
} from '@tokenusagealert/domain'
import {
  HourlyUsageSchema, UsageExecutionSettingsSchema,
  type HourlyUsage, type UsageIssue, type UsageRun, type UsageExecutionSettings,
  type UsageTelemetry, type UsageOverviewRow, type TenantListItem, type UsagePriceBook,
} from '@tokenusagealert/schemas'
import type { BlobTenantRepository } from './index.js'
import type { BlobPricingStore } from './pricing-store.js'
import type { BlobUsageStore } from './usage-store.js'
import type { UsageCollection, UsageSource, UsageWindow } from './usage-source.js'
import type { UsageAlertSink } from './alert-producer.js'

export * from './usage-store.js'
export * from './usage-source.js'
export { StorageLeaseBusyError } from './blob-lease.js'

function sum(values: (string | null)[], precision = 12): string | null {
  const known = values.filter((value): value is string => value !== null)
  return known.length ? known.reduce((total, value) => total.plus(value), new Decimal(0)).toFixed(precision) : null
}

export function overviewHour(hour: HourlyUsage): HourlyUsage {
  return { ...hour, breakdown: [], issues: hour.issues.slice(0, 3) }
}

type TenantStore = Pick<BlobTenantRepository, 'listTenants' | 'getTenant' | 'getSubscriptionInventory' | 'withTenantAuthorizationLease'>
type UsageStore = Pick<BlobUsageStore, 'withLease' | 'writeRun' | 'getInventory' | 'saveInventory' | 'saveHours' | 'hours' | 'saveView'>
type PriceStore = Pick<BlobPricingStore, 'getUsagePriceBook'>

export class AuthorizationScopeChangedError extends Error {
  constructor() { super('Authorization changed while collecting; the in-flight result was discarded.'); this.name = 'AuthorizationScopeChangedError' }
}

function scopeIdentity(inventory: Awaited<ReturnType<TenantStore['getSubscriptionInventory']>>): string {
  return JSON.stringify({
    expected: [...(inventory?.expectedSubscriptionIds ?? [])].sort(),
    subscriptions: (inventory?.subscriptions ?? []).map((item) =>
      `${item.subscriptionId}|${item.state}|${item.firstSeenAtUtc}`).sort(),
  })
}

export class UsageCollectionService {
  readonly execution: UsageExecutionSettings
  private readonly clock: () => Date
  private readonly alerts: UsageAlertSink | undefined

  constructor(
    private readonly tenants: TenantStore,
    private readonly usage: UsageStore,
    private readonly pricing: PriceStore,
    private readonly source: UsageSource,
    options: { execution?: Partial<UsageExecutionSettings>; now?: () => Date; alerts?: UsageAlertSink } = {},
  ) {
    this.execution = UsageExecutionSettingsSchema.parse(options.execution ?? {})
    this.clock = options.now ?? (() => new Date())
    this.alerts = options.alerts
  }

  async run(): Promise<UsageRun> {
    const now = this.clock()
    const started = Date.now()
    const window = collectionWindow(now)
    const execution = this.execution
    const workDeadline = AbortSignal.timeout(execution.timeoutSeconds * 1000)
    const stats: UsageTelemetry = {
      tenantConcurrencyPeak: 0, subscriptionConcurrencyPeak: 0, globalSubscriptionPeak: 0, httpConcurrencyPeak: 0,
      httpRequests: 0, throttledRequests: 0, retries: 0, subscriptionCount: 0,
      subscriptionCacheHits: 0, subscriptionDiscoveryRefreshes: 0,
      failedTenantCount: 0, completedHours: 0, finalizedHours: 0, durationMs: 0,
    }
    return this.usage.withLease(async (leaseSignal) => {
      const workSignal = AbortSignal.any([leaseSignal, workDeadline])
      const run: UsageRun = {
        schemaVersion: 1, runId: randomUUID(), startedAtUtc: now.toISOString(), finishedAtUtc: null,
        status: 'running', source: this.source.name, ...window, execution, telemetry: stats,
        tenantCount: 0, processedTenantCount: 0, skippedTenantCount: 0, deploymentCount: 0, issues: [],
      }
      await this.usage.writeRun(run, leaseSignal)
      try {
        const allTenants = await this.tenants.listTenants()
        const tenants = allTenants.filter((tenant) => tenant.status !== 'deleted' &&
          tenantShard(tenant.tenantId, execution.shardCount) === execution.shardId)
        run.tenantCount = tenants.length
        let snapshot: UsagePriceBook | null = null
        let priceFailure: UsageIssue | null = null
        try { snapshot = await this.pricing.getUsagePriceBook() } catch {
          priceFailure = { code: 'PRICE_READ_FAILED', message: '价格快照读取失败，不会以零价计算。', resourceId: null }
        }
        const priceIndex = indexUsagePrices(snapshot)
        let activeTenants = 0
        const results = await mapConcurrent(tenants, execution.tenantConcurrency, async (tenant): Promise<UsageOverviewRow> => {
          activeTenants += 1
          stats.tenantConcurrencyPeak = Math.max(stats.tenantConcurrencyPeak, activeTenants)
          try {
            if (!['active', 'degraded'].includes(tenant.status)) {
              run.skippedTenantCount += 1
              if (tenant.status === 'disconnected' && this.alerts) {
                try { await this.alerts.disconnected(tenant, window) } catch {
                  run.issues.push({ code: 'ALERT_EVALUATION_FAILED', message: `${tenant.displayName} 的授权告警未完成；费用历史未更改。`, resourceId: tenant.tenantId })
                }
              }
              return this.row(tenant, window.windowStartUtc, now)
            }
            const issues: UsageIssue[] = priceFailure ? [priceFailure] : []
            const subscriptions = await this.tenants.getSubscriptionInventory(tenant.tenantId)
            const initialScope = scopeIdentity(subscriptions)
            stats.subscriptionCount += subscriptions?.subscriptions.length ?? 0
            if (!subscriptions || subscriptions.subscriptions.length === 0 ||
              now.getTime() - Date.parse(subscriptions.observedAtUtc) > 2 * 3_600_000) {
              issues.push({ code: 'AUTHORIZATION_INVENTORY_UNAVAILABLE', message: '授权清单缺失或超过 2 小时未刷新。', resourceId: null })
            }
            if (tenant.status === 'degraded' || subscriptions?.expectedSubscriptionIds.some((id) =>
              !subscriptions.subscriptions.some((item) => item.subscriptionId === id && item.state.toLowerCase() === 'enabled'))) {
              issues.push({ code: 'AUTHORIZATION_PARTIAL', message: '部分预期订阅不可见，当前结果不是租户完整总额。', resourceId: null })
            }
            if (snapshot?.official && now.getTime() - Date.parse(snapshot.official.fetchedAtUtc) > 72 * 3_600_000) {
              issues.push({ code: 'PRICE_EXPIRED', message: '价格快照超过 72 小时，结果不能确认完整。', resourceId: null })
            }
            let collected: UsageCollection = {
              inventory: { schemaVersion: 1, tenantId: tenant.tenantId, observedAtUtc: now.toISOString(), accounts: [], deployments: [], issues: [] },
              observations: [], successfulSubscriptions: 0,
            }
            let inventoryRead = false
            if (subscriptions && !issues.some((issue) => issue.code === 'AUTHORIZATION_INVENTORY_UNAVAILABLE')) {
              try {
                const previous = await this.usage.getInventory(tenant.tenantId)
                collected = await this.source.collect(tenant.tenantId, subscriptions, previous, window, workSignal)
                inventoryRead = true
              } catch {
                issues.push({
                  code: workSignal.aborted ? 'USAGE_DEADLINE_EXCEEDED' : 'TENANT_COLLECTION_FAILED',
                  message: '该租户采集未完整完成，其他租户继续处理；缺失数据不会填零。',
                  resourceId: tenant.tenantId,
                })
              }
            }
            const hour = this.calculateHour(
              tenant, window, collected, subscriptions?.expectedSubscriptionIds.length ?? 0,
              snapshot, priceIndex, [...issues, ...collected.inventory.issues], this.clock(),
            )
            const row = await this.tenants.withTenantAuthorizationLease(tenant.tenantId, async (authorizationSignal) => {
              const [currentTenant, currentScope] = await Promise.all([
                this.tenants.getTenant(tenant.tenantId), this.tenants.getSubscriptionInventory(tenant.tenantId),
              ])
              if (!['active', 'degraded'].includes(currentTenant.status) || scopeIdentity(currentScope) !== initialScope) {
                throw new AuthorizationScopeChangedError()
              }
              const commitSignal = AbortSignal.any([leaseSignal, authorizationSignal])
              commitSignal.throwIfAborted()
              if (inventoryRead) await this.usage.saveInventory(collected.inventory, commitSignal)
              await this.usage.saveHours([hour], commitSignal)
              const currentRow = await this.row(currentTenant, window.windowStartUtc, now)
              if (this.alerts) {
                try {
                  await this.alerts.evaluate(currentTenant, {
                    ...hour, thresholdUsd: currentRow.latest ? currentRow.latest.thresholdUsd : hour.thresholdUsd,
                  })
                } catch {
                  run.issues.push({ code: 'ALERT_EVALUATION_FAILED', message: `${tenant.displayName} 的费用已保存，但告警决策需要重试。`, resourceId: tenant.tenantId })
                }
              }
              return currentRow
            })
            stats.completedHours += 1
            run.processedTenantCount += 1
            run.deploymentCount += collected.inventory.deployments.length
            const errors = [...new Set(hour.issues.map((issue) => issue.code))]
            if (errors.length) run.issues.push({
              code: 'TENANT_USAGE_INCOMPLETE', message: `${tenant.displayName}：${errors.join(', ')}`, resourceId: tenant.tenantId,
            })
            return row
          } finally { activeTenants -= 1 }
        }, workSignal)
        const rows: UsageOverviewRow[] = results.map((result, index) => {
          if (result.status === 'fulfilled') return result.value
          stats.failedTenantCount += 1
          const tenant = tenants[index]!
          run.issues.push({
            code: result.reason instanceof AuthorizationScopeChangedError ? 'AUTHORIZATION_SCOPE_CHANGED'
              : workSignal.aborted ? 'USAGE_DEADLINE_EXCEEDED' : 'TENANT_PROCESSING_FAILED',
            message: `${tenant.displayName} 未完成，未写入伪零费用；原有历史保留。`, resourceId: tenant.tenantId,
          })
          return { tenantId: tenant.tenantId, displayName: tenant.displayName, status: tenant.status, thresholdUsd: tenant.hourlyThresholdUsd, latest: null, hours: [] }
        })
        const telemetry = this.source.telemetry?.()
        if (telemetry) Object.assign(stats, telemetry)
        stats.durationMs = Date.now() - started
        run.capacityWarning = stats.durationMs > 12 * 60_000 || workDeadline.aborted
        if (run.capacityWarning) run.issues.push({
          code: 'CAPACITY_REVIEW_REQUIRED', message: '本轮超过 12 分钟或达到截止时间；增加客户前应评估分片和 API 限流。', resourceId: null,
        })
        run.status = workDeadline.aborted ? 'failed' : run.issues.length ? 'succeededWithWarnings' : 'succeeded'
        await this.usage.saveView({
          schemaVersion: 1, runId: run.runId, shardId: execution.shardId, shardCount: execution.shardCount,
          generatedAtUtc: this.clock().toISOString(), ...window, tenants: rows.filter((tenant) => tenant.status !== 'deleted'),
        }, leaseSignal)
      } catch (error) {
        run.status = 'failed'
        run.issues.push({
          code: 'USAGE_JOB_FAILED',
          message: `采集未完成 (${error instanceof Error ? error.name : 'UnknownError'})；检查私网存储与运行配置。`,
          resourceId: null,
        })
      }
      stats.durationMs = Date.now() - started
      run.finishedAtUtc = this.clock().toISOString()
      await this.usage.writeRun(run, leaseSignal)
      return run
    }, AbortSignal.timeout((execution.timeoutSeconds + 90) * 1000))
  }

  private async row(tenant: TenantListItem, currentWindow: string, now: Date): Promise<UsageOverviewRow> {
    const hours = (await this.usage.hours(tenant.tenantId, 24, now)).map(overviewHour)
    return {
      tenantId: tenant.tenantId, displayName: tenant.displayName, status: tenant.status,
      thresholdUsd: tenant.hourlyThresholdUsd, hours,
      latest: hours.find((hour) => hour.windowStartUtc === currentWindow) ?? null,
    }
  }

  private calculateHour(
    tenant: TenantListItem,
    window: UsageWindow,
    collected: UsageCollection,
    expectedSubscriptions: number,
    snapshot: UsagePriceBook | null,
    index: ReturnType<typeof indexUsagePrices>,
    issues: UsageIssue[],
    now: Date,
  ): HourlyUsage {
    const breakdown = collected.observations.map((observation) =>
      calculateDeploymentCost(observation, snapshot, window.windowStartUtc, index))
    issues.push(...breakdown.flatMap((item) => item.issues))
    const observed = breakdown.filter((item) => item.metricsStatus !== 'failed')
    const noDeployments = collected.inventory.deployments.length === 0 &&
      collected.successfulSubscriptions > 0 && collected.inventory.issues.length === 0
    const summary = summarizeUsageCosts(breakdown, issues, collected.successfulSubscriptions, expectedSubscriptions, noDeployments)
    return HourlyUsageSchema.parse({
      schemaVersion: 1, tenantId: tenant.tenantId, windowStartUtc: window.windowStartUtc, windowEndUtc: window.windowEndUtc,
      collectedAtUtc: now.toISOString(), source: this.source.name, status: summary.status, activity: summary.activity,
      ...(this.source.metricFamily ? { metricFamily: this.source.metricFamily } : {}),
      finality: 'provisional', finalizedAtUtc: null,
      estimatedCostUsd: summary.estimatedCostUsd, knownCostUsd: summary.knownCostUsd,
      knownCostUpperUsd: summary.knownCostUpperUsd, thresholdUsd: tenant.hourlyThresholdUsd,
      inputTokens: sum(observed.map((item) => item.inputTokens), 0) ?? (noDeployments ? '0' : null),
      outputTokens: sum(observed.map((item) => item.outputTokens), 0) ?? (noDeployments ? '0' : null),
      priceSnapshotId: snapshot?.official?.snapshotId ?? null,
      manualPriceSnapshotId: breakdown.some((item) => item.prices.some((price) => price.source === 'manual')) ? snapshot?.manual.snapshotId ?? null : null,
      estimatePolicy: 'model-independent-retail-range',
      pricingRuleVersion: 3, validation: 'awaiting-positive-usage-verification',
      coverage: {
        expectedSubscriptions, successfulSubscriptions: collected.successfulSubscriptions,
        accounts: collected.inventory.accounts.length, expectedDeployments: collected.inventory.deployments.length,
        successfulDeployments: observed.length, pricedDeployments: summary.pricedDeployments,
      },
      breakdown, issues,
    })
  }
}

export class InlineUsageStarter {
  constructor(private readonly service: UsageCollectionService) {}
  async start() {
    const run = await this.service.run()
    if (run.status === 'failed') throw new Error('Usage collection failed; inspect the recorded run.')
    return { executionName: run.runId }
  }
}

export class ShardedUsageStarter {
  constructor(private readonly starters: Array<{ start(): Promise<{ executionName: string }> }>) {}
  async start() {
    const results = await mapConcurrent(this.starters, 4, (starter) => starter.start())
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('One or more usage shards failed to start; check shard execution status before retrying.')
    }
    return { executionName: results.flatMap((result) => result.status === 'fulfilled' ? [result.value.executionName] : []).join(', ') }
  }
}
