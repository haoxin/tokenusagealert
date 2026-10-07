import { z } from 'zod'

const time = z.iso.datetime({ offset: true })
const money = z.string().regex(/^\d+(?:\.\d+)?$/).nullable()
export const EmailAddressSchema = z.string().trim().toLowerCase().pipe(z.email())
export const AlertSubjectSchema = z.string().regex(/^(platform|test|tenant-[a-f0-9-]{36})$/)
export const AlertKindSchema = z.enum([
  'cost-exceeded', 'cost-reminder', 'cost-recovered',
  'data-quality', 'data-reminder', 'data-recovered', 'test',
])
export const MailSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  senderMailbox: EmailAddressSchema,
  operationsRecipients: z.array(EmailAddressSchema).max(20),
  reminderIntervalHours: z.literal(6),
  recoveryPolicy: z.literal('new-complete-hour'),
  updatedAtUtc: time.nullable(),
  updatedByObjectId: z.string().nullable(),
}).strict()

export const UpdateMailSettingsSchema = z.object({
  enabled: z.boolean(),
  senderMailbox: EmailAddressSchema.optional(),
  operationsRecipients: z.array(EmailAddressSchema).max(20).transform((items) => [...new Set(items)]),
}).strict().refine((value) => !value.enabled || value.operationsRecipients.length > 0, {
  message: '启用邮件前必须填写运维收件人。',
})

export const AlertStateSchema = z.object({
  lastEvaluatedAtUtc: time.nullable(),
  costState: z.enum(['normal', 'breaching']),
  lastCostEventAtUtc: time.nullable(),
  qualitySignature: z.string().nullable(),
  lastQualityEventAtUtc: time.nullable(),
  notificationsEnabled: z.boolean(),
}).strict()

export const AlertEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  key: z.string().min(1),
  kind: AlertKindSchema,
  subject: AlertSubjectSchema,
  tenantId: z.string().uuid().nullable(),
  tenantName: z.string(),
  occurredAtUtc: time,
  windowStartUtc: time.nullable(),
  windowEndUtc: time.nullable(),
  amountUsd: money,
  amountUpperUsd: money.optional(),
  thresholdUsd: money,
  dataStatus: z.enum(['complete', 'partial', 'failed', 'none']),
  manualPriceSnapshotId: z.string().uuid().optional(),
  repricedAtUtc: time.optional(),
  issues: z.array(z.object({ code: z.string(), message: z.string() }).strict()).max(20),
  createdAtUtc: time,
}).strict()

export const OutboxStatusSchema = z.enum([
  'pending', 'claimed', 'accepted', 'failed', 'unknown', 'suppressed', 'previewed', 'closed',
])
export const OutboxRecordSchema = z.object({
  schemaVersion: z.literal(1),
  event: AlertEventSchema,
  sender: EmailAddressSchema,
  recipients: z.array(EmailAddressSchema).max(20),
  mode: z.enum(['graph', 'preview']),
  settingsRevision: z.number().int().nonnegative(),
  status: OutboxStatusSchema,
  attempts: z.number().int().nonnegative(),
  updatedAtUtc: time,
  nextAttemptAtUtc: time.nullable(),
  claimOwner: z.string().uuid().nullable(),
  claimExpiresAtUtc: time.nullable(),
  submissionStartedAtUtc: time.nullable(),
  graphRequestId: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  resolution: z.object({ actorObjectId: z.string(), reason: z.string(), atUtc: time }).nullable(),
}).strict()

export const AlertSubjectDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  subject: AlertSubjectSchema,
  current: AlertStateSchema,
  pending: z.object({ next: AlertStateSchema, events: z.array(OutboxRecordSchema) }).nullable(),
}).strict()

export const MailRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  startedAtUtc: time,
  finishedAtUtc: time,
  status: z.enum(['succeeded', 'succeededWithWarnings', 'failed']),
  mode: z.enum(['graph', 'preview']),
  processed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  previewed: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
}).strict()

export const MailSettingsResponseSchema = z.object({
  settings: MailSettingsSchema,
  etag: z.string().nullable(),
  allowedRecipientDomains: z.array(z.string()),
  dispatcherConfigured: z.boolean(),
  mode: z.enum(['graph', 'preview']),
  authorizationReady: z.boolean(),
  graphTestAvailable: z.boolean().default(false),
  senderAuthorizationSource: z.enum(['deployment', 'graph-test', 'unverified', 'preview']).default('unverified'),
  senderVerifiedAtUtc: time.nullable().default(null),
  warning: z.string().nullable().default(null),
}).strict()
export const SenderAuthorizationProofSchema = z.object({
  schemaVersion: z.literal(1),
  senderMailbox: EmailAddressSchema,
  authorizationIdentityId: z.string().uuid(),
  status: z.enum(['accepted', 'denied']),
  checkedAtUtc: time,
  eventId: z.string().regex(/^[a-f0-9]{64}$/),
  graphRequestId: z.string().nullable(),
}).strict()
export const OutboxListResponseSchema = z.object({
  items: z.array(OutboxRecordSchema),
  nextCursor: z.string().nullable(),
}).strict()
export const AlertTimelineResponseSchema = z.object({ items: z.array(AlertEventSchema) }).strict()
export const MailStatusResponseSchema = z.object({ run: MailRunSchema.nullable() }).strict()
export const MailTestRequestSchema = z.object({
  requestId: z.string().uuid(), recipient: EmailAddressSchema, preview: z.boolean().default(false),
  senderMailbox: EmailAddressSchema.optional(),
}).strict()
export const MailTestResponseSchema = z.object({
  event: OutboxRecordSchema,
  dispatcherRequested: z.boolean(),
  warning: z.string().nullable(),
}).strict()
export const OutboxResolutionSchema = z.object({
  action: z.enum(['retry', 'close']),
  reason: z.string().trim().min(5).max(500),
}).strict()
export const OutboxDetailResponseSchema = z.object({ item: OutboxRecordSchema, etag: z.string() }).strict()

export type AlertKind = z.infer<typeof AlertKindSchema>
export type AlertState = z.infer<typeof AlertStateSchema>
export type AlertEvent = z.infer<typeof AlertEventSchema>
export type MailSettings = z.infer<typeof MailSettingsSchema>
export type UpdateMailSettings = z.infer<typeof UpdateMailSettingsSchema>
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>
export type AlertSubjectDocument = z.infer<typeof AlertSubjectDocumentSchema>
export type MailRun = z.infer<typeof MailRunSchema>
export type MailSettingsResponse = z.infer<typeof MailSettingsResponseSchema>
export type OutboxListResponse = z.infer<typeof OutboxListResponseSchema>
