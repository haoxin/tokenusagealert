import { z } from 'zod'

const time = z.iso.datetime({ offset: true })
const decimal = z.string().trim().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/)
const model = z.string().trim().toLowerCase().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/)
export const PriceDeploymentSkuSchema = z.enum(['GlobalStandard', 'DataZoneStandard', 'Standard'])
export const BillingContextSchema = z.enum(['uniform', 'short', 'long'])
export const BillingTierSchema = z.enum(['standard', 'priority', 'batch', 'flex'])
export const BillingModalitySchema = z.enum(['text', 'audio', 'image', 'video', 'unspecified'])
export const CompactPriceRateSchema = z.object({
  model: z.string().min(1),
  skuName: z.string().min(1),
  sku: PriceDeploymentSkuSchema,
  tier: BillingTierSchema,
  context: BillingContextSchema,
  modelVersion: z.string().nullable().default(null),
  modality: BillingModalitySchema.default('unspecified'),
  direction: z.enum(['input', 'output', 'cachedInput', 'cacheWrite']),
  usd: z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  effectiveFromUtc: time,
  regions: z.array(z.object({ name: z.string().min(1), meterId: z.string().uuid() }).strict()).min(1),
  approvedMapping: z.boolean(),
}).strict()
export const CompactPriceCatalogSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  billingParserVersion: z.literal(3).optional(),
  kind: z.literal('compact-official'),
  snapshotId: z.string().uuid(),
  fetchedAtUtc: time,
  generatedAtUtc: time,
  currency: z.literal('USD'),
  unitTokens: z.literal('1000000'),
  models: z.array(z.string()),
  regions: z.array(z.string()),
  rates: z.array(CompactPriceRateSchema),
  scheduledRates: z.array(CompactPriceRateSchema).optional(),
  rawEntryCount: z.number().int().nonnegative(),
  unpricedUnits: z.array(z.object({
    model: z.string(), units: z.array(z.string()), effectiveFromUtc: time.optional(), regions: z.array(z.string()).optional(),
  }).strict()).optional(),
}).strict()

export const ManualPriceInputSchema = z.object({
  modelName: model,
  modelVersion: z.string().trim().max(80).nullable().default(null).transform((value) => value || null),
  deploymentSku: PriceDeploymentSkuSchema,
  regionScope: z.enum(['selected', 'all']),
  regions: z.array(z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9-]+$/)).max(100)
    .transform((values) => [...new Set(values)]),
  inputUsdPerMillion: decimal,
  outputUsdPerMillion: decimal,
  note: z.string().trim().max(500).default(''),
}).strict().superRefine((value, context) => {
  if (value.regionScope === 'selected' && value.regions.length === 0) {
    context.addIssue({ code: 'custom', path: ['regions'], message: '请选择至少一个适用区域，或明确选择所有区域。' })
  }
  if (value.regionScope === 'all' && value.regions.length > 0) {
    context.addIssue({ code: 'custom', path: ['regions'], message: '所有区域范围不应同时携带指定区域。' })
  }
  if (/^(?:sora|dall-e|tts|whisper)|(?:^|[-_.])(?:image|audio|realtime|live|embedding|embeddings|transcribe|translate|multimodal)(?:[-_.]|$)/.test(value.modelName)) {
    context.addIssue({ code: 'custom', path: ['modelName'], message: '手动简化估算只支持普通文本 token 模型，不支持图像、音频、Realtime 或 embedding 特殊计费。' })
  }
})
export const ManualPriceVersionSchema = z.object({
  ruleId: z.string().uuid(),
  revision: z.number().int().positive(),
  modelName: model,
  modelVersion: z.string().nullable(),
  deploymentSku: PriceDeploymentSkuSchema,
  regionScope: z.enum(['selected', 'all']),
  regions: z.array(z.string()),
  inputUsdPerMillion: decimal,
  outputUsdPerMillion: decimal,
  note: z.string(),
  effectiveFromUtc: time,
  effectiveToUtc: time.nullable(),
  enabled: z.boolean(),
  updatedAtUtc: time,
  updatedByObjectId: z.string(),
}).strict()
export const ManualPriceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  snapshotId: z.string().uuid().nullable(),
  versions: z.array(ManualPriceVersionSchema).max(10000),
}).strict()
export const ManualPriceListResponseSchema = z.object({
  document: ManualPriceDocumentSchema,
  items: z.array(ManualPriceVersionSchema),
  etag: z.string().nullable(),
  regionOptions: z.array(z.string()),
  officialModels: z.array(z.string()),
  preference: z.literal('official-first'),
  effectivePolicy: z.literal('next-full-hour'),
}).strict()
export const ManualPriceMutationResponseSchema = z.object({
  item: ManualPriceVersionSchema,
  etag: z.string(),
  warning: z.string().nullable(),
}).strict()
export type CompactPriceRate = z.infer<typeof CompactPriceRateSchema>
export type CompactPriceCatalog = z.infer<typeof CompactPriceCatalogSchema>
export type ManualPriceInput = z.infer<typeof ManualPriceInputSchema>
export type ManualPriceVersion = z.infer<typeof ManualPriceVersionSchema>
export type ManualPriceDocument = z.infer<typeof ManualPriceDocumentSchema>
export type ManualPriceListResponse = z.infer<typeof ManualPriceListResponseSchema>
export type ManualPriceMutationResponse = z.infer<typeof ManualPriceMutationResponseSchema>
export interface UsagePriceBook {
  kind: 'usage-price-book'
  official: CompactPriceCatalog | null
  manual: ManualPriceDocument
}
