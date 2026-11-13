import { Decimal } from 'decimal.js'
import type { DeploymentUsage, FoundryEstimatedCost, HourlyUsage, UsageIssue, UsagePriceBook } from '@tokenusagealert/schemas'
import { calculateDeploymentCost, hasAdditionalCacheTokens, indexUsagePrices, USAGE_PRICING_RULE_VERSION } from './usage.js'

export function overviewHour(hour: HourlyUsage): HourlyUsage {
  return { ...hour, breakdown: [], issues: hour.issues.slice(0, 3) }
}

export function summarizeUsageCosts(
  breakdown: DeploymentUsage[],
  issues: UsageIssue[],
  successfulSubscriptions: number,
  expectedSubscriptions: number,
  noDeployments: boolean,
) {
  const observed = breakdown.filter((item) => item.metricsStatus !== 'failed')
  const hasUsage = observed.some((item) =>
    new Decimal(item.inputTokens ?? 0).plus(item.outputTokens ?? 0).gt(0) || hasAdditionalCacheTokens(item))
  const unknownUnits = issues.some((issue) =>
    ['UNSUPPORTED_BILLING_UNIT', 'ADDITIONAL_BILLING_UNITS_MISSING', 'CACHE_BILLING_UNVERIFIED'].includes(issue.code))
  const noUsage = observed.length > 0 && observed.length === breakdown.length && !hasUsage && !unknownUnits
  const priced = breakdown.filter((item) => item.costUsd !== null &&
    ['matched', 'range'].includes(item.pricingStatus))
  const sum = (amounts: (string | null)[]) => {
    const known = amounts.filter((value): value is string => value !== null)
    return known.length ? known.reduce((total, value) => total.plus(value), new Decimal(0)).toFixed(12) : null
  }
  const fallbackZero = noDeployments || noUsage ? '0.000000000000' : null
  const knownCostUsd = sum(breakdown.map((item) => item.costUsd)) ?? fallbackZero
  const knownCostUpperUsd = breakdown.some((item) => item.costUsd !== null && item.costUpperUsd === null)
    ? null : sum(breakdown.map((item) => item.costUpperUsd === undefined ? item.costUsd : item.costUpperUsd)) ?? fallbackZero
  const status = issues.length === 0 && (noDeployments || priced.length === breakdown.length) &&
    successfulSubscriptions === expectedSubscriptions && expectedSubscriptions > 0
    ? 'complete' as const : observed.length > 0 || noDeployments ? 'partial' as const : 'failed' as const
  const native = breakdown.flatMap((item) => item.foundryEstimatedCost ? [item.foundryEstimatedCost] : [])
  let foundryEstimatedCost: FoundryEstimatedCost | undefined
  if (native.length) {
    const available = native.filter((item) => item.status === 'available' && item.costUsd !== null)
    const complete = available.length === breakdown.length &&
      successfulSubscriptions === expectedSubscriptions && expectedSubscriptions > 0
    const nativeStatus: FoundryEstimatedCost['status'] = complete ? 'available'
      : available.length ? 'partial' : native.some((item) => item.status === 'failed') ? 'failed'
        : native.length === breakdown.length && native.every((item) => item.status === 'unsupported') ? 'unsupported' : 'noData'
    foundryEstimatedCost = {
      metricName: 'FoundryModelEstimatedCost', currency: 'USD', status: nativeStatus,
      costUsd: complete ? sum(available.map((item) => item.costUsd)) : null,
      retrievedAtUtc: native.map((item) => item.retrievedAtUtc).sort().at(-1)!,
      issue: complete ? null : native.find((item) => item.issue)?.issue ?? (nativeStatus === 'partial' ? {
        code: 'FOUNDRY_ESTIMATED_COST_INCOMPLETE',
        message: `原生费用仅覆盖 ${available.length}/${breakdown.length} 个部署及 ${successfulSubscriptions}/${expectedSubscriptions} 个订阅；未把已知部分当完整金额。`,
        resourceId: null,
      } : null),
    }
  }
  return {
    status, activity: noDeployments ? 'noDeployments' as const : hasUsage ? 'hasUsage' as const
      : noUsage ? 'noUsage' as const : 'unknown' as const,
    knownCostUsd, knownCostUpperUsd, estimatedCostUsd: status === 'complete' ? knownCostUsd : null,
    foundryEstimatedCost,
    observedDeployments: observed.length, pricedDeployments: priced.length,
  }
}

const obsoletePricingIssues = new Set([
  'UNSUPPORTED_PRICING_RULE', 'UNSUPPORTED_OFFICIAL_MAPPING', 'PRICE_MATCH_FAILED',
  'PRICE_MODEL_NOT_FOUND', 'PRICE_SNAPSHOT_MISSING', 'MANUAL_PRICE_AMBIGUOUS',
])

export function repriceMissingUsageHour(hour: HourlyUsage, book: UsagePriceBook, now = new Date()): HourlyUsage {
  if (hour.finality === 'final' || hour.knownCostUsd !== null || hour.source !== 'azure-monitor') {
    throw new Error('Only provisional real usage with a previously missing amount can be repriced.')
  }
  return repriceUsageHour(hour, book, now)
}

export function repriceUsageHourForContextMix(hour: HourlyUsage, book: UsagePriceBook, now = new Date()): HourlyUsage {
  if (hour.source !== 'azure-monitor' || hour.status !== 'complete' || hour.knownCostUsd === null ||
    Date.parse(hour.windowEndUtc) > now.getTime()) {
    throw new Error('Context-estimate backfill requires a completed, confirmed real usage amount.')
  }
  if (hour.manualPriceSnapshotId && hour.manualPriceSnapshotId !== book.manual.snapshotId) {
    throw new Error('Historical usage requires its original manual price snapshot.')
  }
  const repriced = repriceUsageHour(hour, book, now)
  if (repriced.status !== 'complete' || repriced.knownCostUsd === null) {
    throw new Error('The context scenario could not be fully priced; original history must remain unchanged.')
  }
  return { ...repriced, revision: (hour.revision ?? 1) + 1 }
}

function repriceUsageHour(hour: HourlyUsage, book: UsagePriceBook, now: Date): HourlyUsage {
  if (hour.priceSnapshotId !== book.official?.snapshotId) throw new Error('Historical usage requires its original official price snapshot.')
  if (Date.parse(hour.windowEndUtc) - Date.parse(hour.windowStartUtc) !== 3_600_000) {
    throw new Error('Historical repricing requires an original single natural hour.')
  }
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    if (hour[key] !== null && !hour.breakdown.reduce((total, row) =>
      total.plus(row.metricsStatus === 'failed' ? 0 : row[key] ?? 0), new Decimal(0)).eq(hour[key]!)) {
      throw new Error('The original hourly token total is inconsistent with its deployment breakdown.')
    }
  }
  const index = indexUsagePrices(book)
  const breakdown = hour.breakdown.map((item) => calculateDeploymentCost({
    deployment: item.deployment, inputTokens: item.inputTokens, outputTokens: item.outputTokens,
    metadataVerified: item.metadataVerified, metricsStatus: item.metricsStatus,
    ...(item.billingSlices ? { billingSlices: item.billingSlices } : {}),
    ...(item.cacheWriteTokens !== undefined ? { cacheWriteTokens: item.cacheWriteTokens } : {}),
    ...(item.metricFamily ? { metricFamily: item.metricFamily } : {}),
    ...(item.billingTelemetry ? { billingTelemetry: item.billingTelemetry } : {}),
    ...(item.foundryEstimatedCost ? { foundryEstimatedCost: item.foundryEstimatedCost } : {}),
    issues: item.issues.filter((issue) => !obsoletePricingIssues.has(issue.code)),
  }, book, hour.windowStartUtc, index))
  const issues = [...hour.issues.filter((issue) => !obsoletePricingIssues.has(issue.code)),
    ...breakdown.flatMap((item) => item.issues)]
  const unique = [...new Map(issues.map((issue) => [`${issue.code}|${issue.resourceId}|${issue.message}`, issue])).values()]
  const summary = summarizeUsageCosts(breakdown, unique, hour.coverage.successfulSubscriptions,
    hour.coverage.expectedSubscriptions, hour.activity === 'noDeployments')
  return {
    ...hour, status: summary.status, activity: summary.activity,
    knownCostUsd: summary.knownCostUsd, knownCostUpperUsd: summary.knownCostUpperUsd,
    estimatedCostUsd: summary.estimatedCostUsd, breakdown, issues: unique, repricedAtUtc: now.toISOString(),
    ...(summary.foundryEstimatedCost ? { foundryEstimatedCost: summary.foundryEstimatedCost } : {}),
    estimatePolicy: 'equal-context-retail-range', pricingRuleVersion: USAGE_PRICING_RULE_VERSION,
    coverage: { ...hour.coverage, pricedDeployments: summary.pricedDeployments },
  }
}
