import { z } from 'zod'
import { BillingContextSchema, BillingModalitySchema, BillingTierSchema } from './price-book.js'

const time = z.iso.datetime({ offset: true })
const amount = z.string().regex(/^\d+(?:\.\d+)?$/)
const identifier = z.string().uuid().transform((value) => value.toLowerCase())

export const UsageExecutionSettingsSchema = z.object({
  tenantConcurrency: z.number().int().min(1).max(64).default(8),
  subscriptionConcurrency: z.number().int().min(1).max(64).default(8),
  accountConcurrency: z.number().int().min(1).max(8).default(2),
  totalRequestConcurrency: z.number().int().min(1).max(256).default(32),
  shardCount: z.number().int().min(1).max(16).default(1),
  shardId: z.number().int().min(0).max(15).default(0),
  timeoutSeconds: z.number().int().min(1).max(2400).default(1200),
}).superRefine((value, context) => {
  if (value.shardId >= value.shardCount || value.shardCount > value.totalRequestConcurrency) {
    context.addIssue({ code: 'custom', message: 'Shard ID/count and total request concurrency are inconsistent.' })
  }
})

export function usageExecutionFromEnvironment(environment: Record<string, unknown>) {
  const number = (name: string) => environment[name] === undefined ? undefined : Number(environment[name])
  return UsageExecutionSettingsSchema.parse({
    tenantConcurrency: number('USAGE_TENANT_CONCURRENCY'),
    subscriptionConcurrency: number('USAGE_SUBSCRIPTION_CONCURRENCY'),
    accountConcurrency: number('USAGE_ACCOUNT_CONCURRENCY'),
    totalRequestConcurrency: number('USAGE_REQUEST_CONCURRENCY'),
    shardId: number('USAGE_SHARD_ID'), shardCount: number('USAGE_SHARD_COUNT'),
    timeoutSeconds: number('USAGE_TIMEOUT_SECONDS'),
  })
}

export const UsageTelemetrySchema = z.object({
  tenantConcurrencyPeak: z.number().int().nonnegative(),
  subscriptionConcurrencyPeak: z.number().int().nonnegative(),
  globalSubscriptionPeak: z.number().int().nonnegative(),
  httpConcurrencyPeak: z.number().int().nonnegative(),
  httpRequests: z.number().int().nonnegative(),
  throttledRequests: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  subscriptionCacheHits: z.number().int().nonnegative(),
  subscriptionDiscoveryRefreshes: z.number().int().nonnegative(),
  subscriptionCount: z.number().int().nonnegative(),
  failedTenantCount: z.number().int().nonnegative(),
  completedHours: z.number().int().nonnegative(),
  finalizedHours: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
}).strict()

export const UsageIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  resourceId: z.string().nullable(),
}).strict()

export const DeploymentInventorySchema = z.object({
  id: z.string().min(1),
  subscriptionId: identifier,
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  accountKind: z.string().min(1),
  region: z.string().min(1),
  name: z.string().min(1),
  modelName: z.string().nullable(),
  modelVersion: z.string().nullable(),
  modelFormat: z.string().nullable(),
  sku: z.string().nullable(),
  firstObservedAtUtc: time,
  observedAtUtc: time,
  deleted: z.boolean(),
}).strict()

export const ResourceInventorySchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: identifier,
  observedAtUtc: time,
  accounts: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.string(), region: z.string(),
    subscriptionId: identifier,
    metricDimensions: z.array(z.string()).optional(),
    modelsMetricDimensions: z.array(z.string()).optional(),
  }).strict()),
  subscriptionDiscovery: z.array(z.object({
    subscriptionId: identifier, discoveredAtUtc: time,
  }).strict()).optional(),
  deployments: z.array(DeploymentInventorySchema),
  issues: z.array(UsageIssueSchema),
}).strict()

export const TokenBillingSliceSchema = z.object({
  direction: z.enum(['input', 'output']),
  tokens: amount,
  context: BillingContextSchema.nullable(),
  modality: BillingModalitySchema.nullable(),
  tier: BillingTierSchema.nullable(),
}).strict()

export const TokenObservationSchema = z.object({
  deployment: DeploymentInventorySchema,
  inputTokens: amount.nullable(),
  outputTokens: amount.nullable(),
  metricsStatus: z.enum(['success', 'noData', 'failed']),
  metadataVerified: z.boolean(),
  billingSlices: z.array(TokenBillingSliceSchema).optional(),
  cacheWriteTokens: amount.nullable().optional(),
  metricFamily: z.enum(['azure-openai-usage', 'models-usage']).optional(),
  issues: z.array(UsageIssueSchema),
}).strict()

export const UsagePriceReferenceSchema = z.object({
  direction: z.enum(['input', 'output', 'cacheWrite']),
  meterId: z.string().uuid().nullable(),
  source: z.enum(['official', 'manual']).optional(),
  manualPriceId: z.string().uuid().optional(),
  manualPriceRevision: z.number().int().positive().optional(),
  unitQuantity: amount,
  unitPriceUsd: amount,
  effectiveStartUtc: time,
  snapshotId: z.string().uuid(),
  context: BillingContextSchema.optional(),
  modality: BillingModalitySchema.optional(),
  tier: BillingTierSchema.optional(),
  modelVersion: z.string().nullable().optional(),
  skuName: z.string().optional(),
  bound: z.enum(['lower', 'upper', 'both']).optional(),
}).strict().superRefine((value, context) => {
  if (value.source === 'manual') {
    if (value.meterId !== null || !value.manualPriceId || !value.manualPriceRevision) {
      context.addIssue({ code: 'custom', message: '手动价格必须保留价格 ID/版本，不能伪造官方 meter。' })
    }
  } else if (value.meterId === null || value.manualPriceId !== undefined || value.manualPriceRevision !== undefined) {
    context.addIssue({ code: 'custom', message: '官方价格必须有真实 meter，不能混入手动来源字段。' })
  }
})

export const DeploymentUsageSchema = TokenObservationSchema.extend({
  costUsd: amount.nullable(),
  costUpperUsd: amount.nullable().optional(),
  pricingStatus: z.enum(['matched', 'range', 'unsupported', 'missing', 'ambiguous']),
  pricingUncertainty: z.array(z.enum(['context', 'modality', 'version', 'variant', 'cacheWrite', 'tier'])).optional(),
  prices: z.array(UsagePriceReferenceSchema),
}).strict()

export const HourlyUsageSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: identifier,
  windowStartUtc: time,
  windowEndUtc: time,
  collectedAtUtc: time,
  metricFamily: z.enum(['azure-openai-usage', 'models-usage']).optional(),
  repricedAtUtc: time.optional(),
  pricingRepairAuditId: identifier.optional(),
  source: z.enum(['azure-monitor', 'fixture']),
  status: z.enum(['complete', 'partial', 'failed']),
  activity: z.enum(['noDeployments', 'noUsage', 'hasUsage', 'unknown']),
  finality: z.enum(['provisional', 'final']),
  revision: z.number().int().positive().optional(),
  finalizedAtUtc: time.nullable().optional(),
  estimatedCostUsd: amount.nullable(),
  knownCostUsd: amount.nullable(),
  knownCostUpperUsd: amount.nullable().optional(),
  thresholdUsd: amount.nullable(),
  inputTokens: amount.nullable(),
  outputTokens: amount.nullable(),
  priceSnapshotId: z.string().uuid().nullable(),
  manualPriceSnapshotId: z.string().uuid().nullable().optional(),
  estimatePolicy: z.enum(['cached-input-at-standard-rate', 'model-independent-retail-range']),
  pricingRuleVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  validation: z.literal('awaiting-positive-usage-verification'),
  coverage: z.object({
    expectedSubscriptions: z.number().int().nonnegative(),
    successfulSubscriptions: z.number().int().nonnegative(),
    accounts: z.number().int().nonnegative(),
    expectedDeployments: z.number().int().nonnegative(),
    successfulDeployments: z.number().int().nonnegative(),
    pricedDeployments: z.number().int().nonnegative(),
  }).strict(),
  breakdown: z.array(DeploymentUsageSchema),
  issues: z.array(UsageIssueSchema),
}).strict()

export const TenantDailyUsageSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: identifier,
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.array(HourlyUsageSchema).max(24),
}).strict()

export const UsageRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  startedAtUtc: time,
  finishedAtUtc: time.nullable(),
  status: z.enum(['running', 'succeeded', 'succeededWithWarnings', 'failed']),
  source: z.enum(['azure-monitor', 'fixture']),
  windowStartUtc: time,
  windowEndUtc: time,
  tenantCount: z.number().int().nonnegative(),
  processedTenantCount: z.number().int().nonnegative(),
  skippedTenantCount: z.number().int().nonnegative(),
  deploymentCount: z.number().int().nonnegative(),
  execution: UsageExecutionSettingsSchema.optional(),
  telemetry: UsageTelemetrySchema.optional(),
  capacityWarning: z.boolean().optional(),
  issues: z.array(UsageIssueSchema),
}).strict()

export const TenantUsageResponseSchema = z.object({
  tenantId: identifier,
  hours: z.array(HourlyUsageSchema).max(240),
  inventory: ResourceInventorySchema.nullable(),
  latestRun: UsageRunSchema.nullable(),
}).strict()

export const UsageStatusResponseSchema = z.object({
  run: UsageRunSchema.nullable(),
  runs: z.array(UsageRunSchema).optional(),
  shardCount: z.number().int().positive().optional(),
}).strict()

export const UsageOverviewRowSchema = z.object({
    tenantId: identifier,
    displayName: z.string(),
    status: z.string(),
    thresholdUsd: amount.nullable(),
    latest: HourlyUsageSchema.nullable(),
    hours: z.array(HourlyUsageSchema).max(24),
  }).strict()

export const UsageOverviewSchema = z.object({
  generatedAtUtc: time,
  windowStartUtc: time,
  windowEndUtc: time,
  latestRun: UsageRunSchema.nullable(),
  tenants: z.array(UsageOverviewRowSchema),
  shardCoverage: z.object({
    expected: z.number().int().positive(), available: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  }).optional(),
  runs: z.array(UsageRunSchema).optional(),
}).strict()

export const UsageShardViewSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  shardId: z.number().int().nonnegative(),
  shardCount: z.number().int().positive(),
  generatedAtUtc: time,
  windowStartUtc: time,
  windowEndUtc: time,
  tenants: z.array(UsageOverviewRowSchema),
}).strict()

export type UsageIssue = z.infer<typeof UsageIssueSchema>
export type DeploymentInventory = z.infer<typeof DeploymentInventorySchema>
export type ResourceInventory = z.infer<typeof ResourceInventorySchema>
export type TokenObservation = z.infer<typeof TokenObservationSchema>
export type TokenBillingSlice = z.infer<typeof TokenBillingSliceSchema>
export type UsagePriceReference = z.infer<typeof UsagePriceReferenceSchema>
export type DeploymentUsage = z.infer<typeof DeploymentUsageSchema>
export type HourlyUsage = z.infer<typeof HourlyUsageSchema>
export type TenantDailyUsage = z.infer<typeof TenantDailyUsageSchema>
export type UsageRun = z.infer<typeof UsageRunSchema>
export type TenantUsageResponse = z.infer<typeof TenantUsageResponseSchema>
export type UsageOverview = z.infer<typeof UsageOverviewSchema>
export type UsageExecutionSettings = z.infer<typeof UsageExecutionSettingsSchema>
export type UsageTelemetry = z.infer<typeof UsageTelemetrySchema>
export type UsageOverviewRow = z.infer<typeof UsageOverviewRowSchema>
export type UsageShardView = z.infer<typeof UsageShardViewSchema>
