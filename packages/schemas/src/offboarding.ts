import { z } from 'zod'

export const OffboardingIdentitySchema = z.object({
  clientId: z.string().uuid(),
  principalId: z.string().uuid(),
  collectorPrincipalId: z.string().uuid(),
  managingTenantId: z.string().uuid(),
  offerName: z.string().min(1).default('AOAI Cost Usage Monitoring'),
}).strict()

export const OffboardingTargetSchema = z.object({
  subscriptionId: z.string().uuid(),
  displayName: z.string(),
  assignmentId: z.string(),
  definitionId: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(['ready', 'submitted', 'failed', 'unknown', 'notAttempted']),
  message: z.string().nullable(),
}).strict()

export const OffboardingOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  subscriptionId: z.string().uuid().nullable(),
  requestedByObjectId: z.string(),
  scopeGeneration: z.string().uuid(),
  createdAtUtc: z.iso.datetime({ offset: true }),
  expiresAtUtc: z.iso.datetime({ offset: true }),
  updatedAtUtc: z.iso.datetime({ offset: true }),
  status: z.enum(['prepared', 'executing', 'submitted', 'partial', 'failed', 'unknown']),
  targets: z.array(OffboardingTargetSchema).min(1).max(1000),
  synchronizationRequested: z.boolean(),
  synchronizationError: z.string().nullable(),
}).strict()

export const OffboardingPreviewRequestSchema = z.object({
  subscriptionId: z.string().uuid().transform((value) => value.toLowerCase()).optional(),
}).strict()
export const OffboardingExecuteRequestSchema = z.object({
  confirmation: z.string().trim().uuid().transform((value) => value.toLowerCase()),
}).strict()
export const OffboardingPreviewResponseSchema = z.object({
  configured: z.boolean(),
  identity: OffboardingIdentitySchema.nullable(),
  operation: OffboardingOperationSchema.nullable(),
  blockers: z.array(z.object({
    subscriptionId: z.string().uuid().nullable(),
    code: z.string(),
    message: z.string(),
  }).strict()),
}).strict()
export const OffboardingOperationResponseSchema = z.object({ operation: OffboardingOperationSchema }).strict()
export type OffboardingIdentity = z.infer<typeof OffboardingIdentitySchema>
export type OffboardingTarget = z.infer<typeof OffboardingTargetSchema>
export type OffboardingOperation = z.infer<typeof OffboardingOperationSchema>
export type OffboardingPreviewResponse = z.infer<typeof OffboardingPreviewResponseSchema>
