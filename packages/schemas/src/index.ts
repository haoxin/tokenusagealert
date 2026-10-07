import { z } from 'zod'

export * from './pricing.js'
export * from './usage.js'
export * from './alerts.js'
export * from './offboarding.js'
export * from './price-book.js'

const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const usdPattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/

function normalizeUsd(value: string): string {
  const [whole, fraction = ''] = value.split('.')
  const normalizedWhole = BigInt(whole ?? '0').toString()
  const trimmedFraction = fraction.replace(/0+$/, '')
  const normalizedFraction =
    trimmedFraction.length >= 2
      ? trimmedFraction
      : trimmedFraction.padEnd(2, '0')

  return `${normalizedWhole}.${normalizedFraction}`
}

export const TenantIdSchema = z
  .string()
  .trim()
  .regex(guidPattern, 'tenantId must be a valid GUID')
  .transform((value) => value.toLowerCase())

export const HourlyThresholdUsdSchema = z
  .string()
  .trim()
  .regex(
    usdPattern,
    'hourlyThresholdUsd must be a positive USD decimal with up to 6 decimal places',
  )
  .refine((value) => Number(value) > 0, {
    message: 'hourlyThresholdUsd must be greater than zero',
  })
  .transform(normalizeUsd)

export const TenantStatusSchema = z.enum([
  'pendingAuthorization',
  'discovered',
  'active',
  'degraded',
  'disconnected',
  'disabled',
  'deleted',
])

export const AuthorizationSourceSchema = z.enum([
  'manual-preregistration',
  'lighthouse-template',
  'marketplace-managed-service',
])

export const CreateTenantRequestSchema = z
  .object({
    tenantId: TenantIdSchema,
    displayName: z.string().trim().min(1).max(120),
    hourlyThresholdUsd: HourlyThresholdUsdSchema,
    notes: z.string().trim().max(1000).optional().default(''),
  })
  .strict()

export const TenantConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    tenantId: TenantIdSchema,
    displayName: z.string().min(1).max(120),
    status: TenantStatusSchema,
    authorizationSource: AuthorizationSourceSchema,
    hourlyThresholdUsd: HourlyThresholdUsdSchema.nullable(),
    notes: z.string().max(1000),
    createdByObjectId: z.string().min(1).max(200),
    createdByName: z.string().min(1).max(320),
    createdAtUtc: z.iso.datetime({ offset: true }),
    updatedAtUtc: z.iso.datetime({ offset: true }),
    deletedAtUtc: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((tenant, context) => {
    if (
      tenant.status !== 'discovered' &&
      tenant.status !== 'deleted' &&
      tenant.hourlyThresholdUsd === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['hourlyThresholdUsd'],
        message: `hourlyThresholdUsd is required for ${tenant.status} tenants`,
      })
    }
  })

export const TenantListItemSchema = TenantConfigSchema.extend({
  etag: z.string().min(1),
})

export const ApiWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
})

export const TenantResponseSchema = z.object({
  tenant: TenantListItemSchema,
  warnings: z.array(ApiWarningSchema).optional(),
})

export const DeleteTenantRegistrationResponseSchema = z.object({
  tenantId: TenantIdSchema,
  deleted: z.literal(true),
  warnings: z.array(ApiWarningSchema).optional(),
}).strict()

export const TenantListResponseSchema = z.object({
  items: z.array(TenantListItemSchema),
  count: z.number().int().nonnegative(),
})

export const SessionSchema = z.object({
  objectId: z.string().min(1),
  name: z.string().min(1),
  authMode: z.enum(['development', 'easyauth']),
})

export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  correlationId: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
})

export const AuditEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    action: z.enum([
      'tenant.create.requested',
      'tenant.create.completed',
      'tenant.delete.requested',
      'tenant.delete.completed',
      'tenant.settings.updated',
      'tenant.authorization.synced',
      'tenant.enabled',
    ]),
    outcome: z.enum(['attempted', 'succeeded']),
    actorObjectId: z.string().min(1).max(200),
    actorName: z.string().min(1).max(320),
    targetType: z.literal('tenant'),
    targetId: TenantIdSchema,
    changedFields: z.array(z.string().min(1)).min(1),
    occurredAtUtc: z.iso.datetime({ offset: true }),
    correlationId: z.string().min(1).max(200),
  })
  .strict()

export const SubscriptionInventoryItemSchema = z
  .object({
    subscriptionId: TenantIdSchema,
    displayName: z.string().min(1).max(200),
    customerTenantId: TenantIdSchema,
    state: z.string().min(1).max(50),
    firstSeenAtUtc: z.iso.datetime({ offset: true }),
    lastSeenAtUtc: z.iso.datetime({ offset: true }),
    lastValidatedAtUtc: z.iso.datetime({ offset: true }),
  })
  .strict()

export const RemovedSubscriptionSchema = z.object({
  subscriptionId: TenantIdSchema,
  displayName: z.string().min(1).max(200),
  customerTenantId: TenantIdSchema,
  lastSeenAtUtc: z.iso.datetime({ offset: true }).nullable(),
  removedAtUtc: z.iso.datetime({ offset: true }),
  reason: z.literal('collector-access-removed'),
}).strict()

export const RemovedSubscriptionsDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: TenantIdSchema,
  items: z.array(RemovedSubscriptionSchema),
}).strict()

export const SubscriptionInventoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    tenantId: TenantIdSchema,
    expectedSubscriptionIds: z.array(TenantIdSchema),
    subscriptions: z.array(SubscriptionInventoryItemSchema),
    removedSubscriptions: z.array(RemovedSubscriptionSchema).optional(),
    observedAtUtc: z.iso.datetime({ offset: true }),
    updatedAtUtc: z.iso.datetime({ offset: true }),
  })
  .strict()

export const AuthorizationSyncRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'succeededWithWarnings',
  'failed',
])

export const AuthorizationSyncErrorSchema = z
  .object({
    tenantId: TenantIdSchema.nullable(),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict()

export const AuthorizationSyncRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    status: AuthorizationSyncRunStatusSchema,
    startedAtUtc: z.iso.datetime({ offset: true }),
    finishedAtUtc: z.iso.datetime({ offset: true }).nullable(),
    discoveredTenantCount: z.number().int().nonnegative(),
    visibleSubscriptionCount: z.number().int().nonnegative(),
    updatedTenantCount: z.number().int().nonnegative(),
    errors: z.array(AuthorizationSyncErrorSchema),
  })
  .strict()

export const EnableTenantRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    hourlyThresholdUsd: HourlyThresholdUsdSchema,
    etag: z.string().min(1),
  })
  .strict()

export const UpdateTenantSettingsRequestSchema = EnableTenantRequestSchema.omit({ etag: true }).strict()

export const AuthorizationSyncStartResponseSchema = z.object({
  executionName: z.string().min(1),
  status: z.literal('started'),
})

export const SubscriptionInventoryResponseSchema = z.object({
  inventory: SubscriptionInventoryDocumentSchema.nullable(),
})

export const AuthorizationSyncLatestResponseSchema = z.object({
  run: AuthorizationSyncRunSchema.nullable(),
})

export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>
export type UpdateTenantSettingsRequest = z.infer<typeof UpdateTenantSettingsRequestSchema>
export type TenantConfig = z.infer<typeof TenantConfigSchema>
export type TenantListItem = z.infer<typeof TenantListItemSchema>
export type TenantResponse = z.infer<typeof TenantResponseSchema>
export type DeleteTenantRegistrationResponse = z.infer<typeof DeleteTenantRegistrationResponseSchema>
export type TenantListResponse = z.infer<typeof TenantListResponseSchema>
export type Session = z.infer<typeof SessionSchema>
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>
export type AuditEvent = z.infer<typeof AuditEventSchema>
export type SubscriptionInventoryItem = z.infer<
  typeof SubscriptionInventoryItemSchema
>
export type SubscriptionInventoryDocument = z.infer<
  typeof SubscriptionInventoryDocumentSchema
>
export type RemovedSubscription = z.infer<typeof RemovedSubscriptionSchema>
export type AuthorizationSyncRun = z.infer<
  typeof AuthorizationSyncRunSchema
>
export type AuthorizationSyncError = z.infer<
  typeof AuthorizationSyncErrorSchema
>
export type EnableTenantRequest = z.infer<
  typeof EnableTenantRequestSchema
>
export type AuthorizationSyncStartResponse = z.infer<
  typeof AuthorizationSyncStartResponseSchema
>
