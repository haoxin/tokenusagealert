import {
  AuthorizationSyncLatestResponseSchema,
  AuthorizationSyncStartResponseSchema,
  EnableTenantRequestSchema,
  DeleteTenantRegistrationResponseSchema,
  PricingHistoryResponseSchema,
  PricingStatusResponseSchema,
  PricingSyncStartResponseSchema,
  ProblemDetailsSchema,
  SessionSchema,
  SubscriptionInventoryResponseSchema,
  TenantListResponseSchema,
  TenantResponseSchema,
  TenantUsageResponseSchema,
  UsageOverviewSchema,
  UsageStatusResponseSchema,
  AlertTimelineResponseSchema, MailSettingsResponseSchema, MailStatusResponseSchema, MailTestResponseSchema,
  OutboxDetailResponseSchema, OutboxListResponseSchema,
  OffboardingOperationResponseSchema, OffboardingPreviewResponseSchema,
  type UpdateMailSettings,
  type CreateTenantRequest,
  type EnableTenantRequest,
  type UpdateTenantSettingsRequest,
  type ProblemDetails,
  type PricingHistoryResponse,
  type PricingStatusResponse,
  type PricingSyncStartResponse,
  type Session,
  type TenantListResponse,
  type TenantResponse,
} from '@tokenusagealert/schemas'

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail)
    this.name = 'ApiError'
  }
}

async function request(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      accept: 'application/json, application/problem+json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  const body = await response.json()
  if (!response.ok) {
    const parsed = ProblemDetailsSchema.safeParse(body)
    if (parsed.success) throw new ApiError(parsed.data)
    throw new Error(`API returned ${response.status}`)
  }
  return body
}

export async function getSession(): Promise<Session> {
  return SessionSchema.parse(await request('/api/v1/session'))
}

export async function listTenants(includeRemoved = false): Promise<TenantListResponse> {
  return TenantListResponseSchema.parse(
    await request(`/api/v1/tenants${includeRemoved ? '?includeRemoved=true' : ''}`, { cache: 'no-store' }),
  )
}

export async function createTenant(
  input: CreateTenantRequest,
): Promise<TenantResponse> {
  return TenantResponseSchema.parse(
    await request('/api/v1/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

export async function updateTenantSettings(tenantId: string, input: UpdateTenantSettingsRequest, etag: string) {
  return TenantResponseSchema.parse(await request(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
    method: 'PATCH', body: JSON.stringify(input), headers: { 'if-match': etag },
    signal: AbortSignal.timeout(30_000),
  }))
}

export async function deletePendingTenant(tenantId: string, etag: string) {
  return DeleteTenantRegistrationResponseSchema.parse(
    await request(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
      method: 'DELETE', body: '{}', headers: { 'if-match': etag },
      signal: AbortSignal.timeout(30_000),
    }),
  )
}

export async function startAuthorizationSync() {
  return AuthorizationSyncStartResponseSchema.parse(
    await request('/api/v1/authorization/sync', {
      method: 'POST',
    }),
  )
}

export async function getLatestAuthorizationSyncRun() {
  return AuthorizationSyncLatestResponseSchema.parse(
    await request('/api/v1/authorization/runs/latest'),
  )
}

export async function getTenantSubscriptions(tenantId: string) {
  return SubscriptionInventoryResponseSchema.parse(
    await request(`/api/v1/tenants/${tenantId}/subscriptions`),
  )
}

export async function enableTenant(
  tenantId: string,
  input: EnableTenantRequest,
) {
  const parsed = EnableTenantRequestSchema.parse(input)
  return TenantResponseSchema.parse(
    await request(`/api/v1/tenants/${tenantId}/enable`, {
      method: 'POST',
      body: JSON.stringify(parsed),
    }),
  )
}

function pricingSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function getPricingStatus(
  signal?: AbortSignal,
): Promise<PricingStatusResponse> {
  return PricingStatusResponseSchema.parse(
    await request('/api/v1/pricing/status', {
      signal: pricingSignal(signal),
      cache: 'no-store',
    }),
  )
}

export async function getPricingHistory(
  cursor?: string,
  signal?: AbortSignal,
): Promise<PricingHistoryResponse> {
  const query = new URLSearchParams({ limit: '10' })
  if (cursor) query.set('cursor', cursor)
  return PricingHistoryResponseSchema.parse(
    await request(`/api/v1/pricing/history?${query.toString()}`, {
      signal: pricingSignal(signal),
      cache: 'no-store',
    }),
  )
}

export async function startPricingSync(
  signal?: AbortSignal,
): Promise<PricingSyncStartResponse> {
  return PricingSyncStartResponseSchema.parse(
    await request('/api/v1/pricing/sync', {
      method: 'POST',
      body: JSON.stringify({}),
      signal: pricingSignal(signal),
    }),
  )
}

export async function getUsageDashboard(signal?: AbortSignal) {
  return UsageOverviewSchema.parse(await request('/api/v1/dashboard', { signal: pricingSignal(signal), cache: 'no-store' }))
}

export async function getTenantUsage(tenantId: string, hours = 240, signal?: AbortSignal) {
  return TenantUsageResponseSchema.parse(await request(`/api/v1/tenants/${encodeURIComponent(tenantId)}/usage?hours=${hours}`, {
    signal: pricingSignal(signal), cache: 'no-store',
  }))
}

export async function getTenantConfig(tenantId: string, signal?: AbortSignal) {
  return TenantResponseSchema.parse(await request(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, { signal: pricingSignal(signal) }))
}

export async function getUsageStatus(signal?: AbortSignal) {
  return UsageStatusResponseSchema.parse(await request('/api/v1/usage/status', { signal: pricingSignal(signal), cache: 'no-store' }))
}

export async function startUsageCollection() {
  return PricingSyncStartResponseSchema.parse(await request('/api/v1/usage/collect', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(45_000),
  }))
}

export async function getMailSettings(signal?: AbortSignal) {
  return MailSettingsResponseSchema.parse(await request('/api/v1/settings/alerting', { signal: pricingSignal(signal), cache: 'no-store' }))
}
export async function saveMailSettings(settings: UpdateMailSettings, etag: string | null) {
  return MailSettingsResponseSchema.parse(await request('/api/v1/settings/alerting', {
    method: 'PATCH', body: JSON.stringify(settings), headers: etag ? { 'if-match': etag } : { 'if-none-match': '*' },
  }))
}
export async function enqueueMailTest(requestId: string, recipient: string, preview: boolean, senderMailbox?: string) {
  return MailTestResponseSchema.parse(await request('/api/v1/settings/alerting/test', {
    method: 'POST', body: JSON.stringify({ requestId, recipient, preview, ...(senderMailbox ? { senderMailbox } : {}) }), signal: AbortSignal.timeout(45_000),
  }))
}

export async function downloadPricingSnapshot(format: 'compact' | 'raw' = 'compact'): Promise<Blob> {
  const response = await fetch(`/api/v1/pricing/download?format=${format}`, {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(120_000),
    headers: { accept: 'application/json, application/problem+json' },
  })
  if (!response.ok) {
    const parsed = ProblemDetailsSchema.safeParse(await response.json())
    if (parsed.success) throw new ApiError(parsed.data)
    throw new Error(`价格下载失败（HTTP ${response.status}）。`)
  }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    throw new Error('未收到 JSON 价格文件，请检查登录状态后重试。')
  }
  const file = await response.blob()
  if (!file.size) throw new Error('价格文件为空，未启动下载。')
  return file
}
export async function getMailStatus(signal?: AbortSignal) {
  return MailStatusResponseSchema.parse(await request('/api/v1/operations/mail', { signal: pricingSignal(signal), cache: 'no-store' }))
}
export async function getOutbox(cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '20' })
  if (cursor) query.set('cursor', cursor)
  return OutboxListResponseSchema.parse(await request(`/api/v1/operations/outbox?${query}`, { signal: pricingSignal(signal), cache: 'no-store' }))
}
export async function getOutboxItem(id: string) {
  return OutboxDetailResponseSchema.parse(await request(`/api/v1/operations/outbox/${id}`, { cache: 'no-store' }))
}
export async function resolveOutbox(id: string, etag: string, action: 'retry' | 'close', reason: string) {
  await request(`/api/v1/operations/outbox/${id}/resolve`, {
    method: 'POST', body: JSON.stringify({ action, reason }), headers: { 'if-match': etag },
  })
}
export async function getTenantAlerts(id: string, signal?: AbortSignal) {
  return AlertTimelineResponseSchema.parse(await request(`/api/v1/tenants/${id}/alerts`, { signal: pricingSignal(signal), cache: 'no-store' }))
}

export async function previewOffboarding(tenantId: string, subscriptionId?: string) {
  return OffboardingPreviewResponseSchema.parse(await request(`/api/v1/tenants/${encodeURIComponent(tenantId)}/offboarding/preview`, {
    method: 'POST', body: JSON.stringify(subscriptionId ? { subscriptionId } : {}),
    signal: AbortSignal.timeout(125_000),
  }))
}
export async function executeOffboarding(id: string, confirmation: string) {
  return OffboardingOperationResponseSchema.parse(await request(`/api/v1/authorization/offboarding/${encodeURIComponent(id)}/execute`, {
    method: 'POST', body: JSON.stringify({ confirmation }), signal: AbortSignal.timeout(170_000),
  }))
}
export async function getOffboardingOperation(id: string) {
  return OffboardingOperationResponseSchema.parse(await request(`/api/v1/authorization/offboarding/${encodeURIComponent(id)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(20_000),
  }))
}
