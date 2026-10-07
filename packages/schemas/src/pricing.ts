import { z } from 'zod'

const timestamp = z.iso.datetime({ offset: true })
const priceDecimal = z.string().regex(/^\d+(?:\.\d+)?$/)

export const RetailPriceItemSchema = z.object({
  currencyCode: z.literal('USD'),
  type: z.literal('Consumption'),
  meterId: z.string().uuid(),
  meterName: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1).refine((value) => value.includes('Azure OpenAI')),
  skuId: z.string().min(1),
  skuName: z.string().min(1),
  serviceName: z.string().min(1),
  armRegionName: z.string(),
  armSkuName: z.string().optional(),
  retailPrice: z.number().finite().nonnegative(),
  unitPrice: z.number().finite().nonnegative().optional(),
  unitOfMeasure: z.string().min(1),
  tierMinimumUnits: z.number().finite().nonnegative(),
  effectiveStartDate: timestamp,
  isPrimaryMeterRegion: z.boolean(),
}).passthrough()

export const RetailPricePageSchema = z.object({
  BillingCurrency: z.literal('USD'),
  Items: z.array(RetailPriceItemSchema),
  Count: z.number().int().nonnegative(),
  NextPageLink: z.url().nullable(),
}).refine((page) => page.Count === page.Items.length, {
  message: 'Retail Prices Count does not match the returned page length',
})

export const NormalizedPriceSchema = z.object({
  key: z.string().min(1),
  priceUsd: priceDecimal,
  unit: z.object({
    kind: z.enum(['tokens', 'hours', 'seconds', 'days', 'months', 'units', 'unknown']),
    quantity: priceDecimal.nullable(),
    sourceLabel: z.string().min(1),
  }),
  modelName: z.string().nullable(),
  modelIdentityStatus: z.enum(['identified', 'shared-service', 'unidentified']).optional(),
  modelVersion: z.string().nullable(),
  direction: z.enum(['input', 'output', 'cachedInput', 'cacheWrite', 'unknown']),
  deploymentType: z.enum(['global', 'dataZone', 'regional', 'unknown']),
  serviceTier: z.enum(['standard', 'priority', 'flex', 'batch', 'provisioned', 'unknown']),
  supportStatus: z.enum(['supported', 'unsupported']),
  supportReason: z.enum(['structural-token-rule', 'unsupported-billing-unit', 'deployment-mapping-not-validated', 'unrecognized-meter']),
  raw: RetailPriceItemSchema,
}).strict()

export const PricingChangesSchema = z.object({
  previousSnapshotId: z.string().uuid().nullable(),
  addedMeterCount: z.number().int().nonnegative(),
  removedMeterCount: z.number().int().nonnegative(),
  changedPriceCount: z.number().int().nonnegative(),
  unchangedMeterCount: z.number().int().nonnegative(),
  priceFromZeroCount: z.number().int().nonnegative(),
  largestPriceChangePercent: z.string().nullable(),
}).strict()

export const PricingSnapshotSummarySchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().uuid(),
  fetchedAtUtc: timestamp,
  source: z.enum(['azure-retail', 'fixture']),
  apiVersion: z.literal('2023-01-01-preview'),
  parserVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  normalizedAtUtc: timestamp.optional(),
  sourceSnapshotId: z.string().uuid().optional(),
  currency: z.literal('USD'),
  cloud: z.literal('AzureCloud'),
  pageCount: z.number().int().positive(),
  sourceRecordCount: z.number().int().positive(),
  meterCount: z.number().int().positive(),
  duplicateCount: z.number().int().nonnegative(),
  unsupportedMeterCount: z.number().int().nonnegative(),
  unrecognizedUnitCount: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  changes: PricingChangesSchema,
}).strict()

export const PricingSnapshotSchema = PricingSnapshotSummarySchema.extend({
  entries: z.array(NormalizedPriceSchema).min(1),
  models: z.array(z.string().min(1)).optional(),
}).refine((snapshot) => snapshot.meterCount === snapshot.entries.length, {
  message: 'Snapshot meterCount does not match its entries',
})

export const PricingSyncRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAtUtc: timestamp,
  finishedAtUtc: timestamp.nullable(),
  source: z.enum(['azure-retail', 'fixture']),
  snapshotId: z.string().uuid().nullable(),
  pageCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).nullable(),
}).strict()

export const PricingStatusResponseSchema = z.object({
  active: PricingSnapshotSummarySchema.nullable(),
  latestRun: PricingSyncRunSchema.nullable(),
  freshness: z.enum(['missing', 'fresh', 'stale', 'expired']),
  ageHours: z.number().finite().nonnegative().nullable(),
  nextScheduledAtUtc: timestamp,
  scheduleCronUtc: z.literal('0 16 * * *'),
  businessTimeZone: z.literal('Asia/Shanghai'),
  retentionDays: z.literal(90),
  automaticUpdates: z.literal(true),
}).strict()

export const PricingHistoryResponseSchema = z.object({
  items: z.array(PricingSnapshotSummarySchema),
  nextCursor: z.string().nullable(),
}).strict()

export const PricingSyncStartResponseSchema = z.object({
  executionName: z.string().min(1),
  status: z.literal('started'),
}).strict()

export type RetailPriceItem = z.infer<typeof RetailPriceItemSchema>
export type RetailPricePage = z.infer<typeof RetailPricePageSchema>
export type NormalizedPrice = z.infer<typeof NormalizedPriceSchema>
export type PricingChanges = z.infer<typeof PricingChangesSchema>
export type PricingSnapshotSummary = z.infer<typeof PricingSnapshotSummarySchema>
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>
export type PricingSyncRun = z.infer<typeof PricingSyncRunSchema>
export type PricingStatusResponse = z.infer<typeof PricingStatusResponseSchema>
export type PricingHistoryResponse = z.infer<typeof PricingHistoryResponseSchema>
export type PricingSyncStartResponse = z.infer<typeof PricingSyncStartResponseSchema>
