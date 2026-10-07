import { createHash } from 'node:crypto'
import { ManagedIdentityCredential } from '@azure/identity'
import { z } from 'zod'
import { OffboardingIdentitySchema, type OffboardingIdentity, type OffboardingTarget } from '@tokenusagealert/schemas'

export const LIGHTHOUSE_DELETE_ROLE = '91c1777a-f3dc-4fae-b103-61d183457e46'
const READER_ROLE = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
const API_VERSION = '2022-10-01'
const lowerId = z.string().uuid().transform((value) => value.toLowerCase())
const assignmentSchema = z.object({
  id: z.string(),
  properties: z.object({
    registrationDefinitionId: z.string(),
    provisioningState: z.string(),
    registrationDefinition: z.object({
      id: z.string(),
      properties: z.object({
        registrationDefinitionName: z.string(),
        managedByTenantId: lowerId,
        manageeTenantId: lowerId,
        authorizations: z.array(z.object({
          principalId: lowerId, roleDefinitionId: lowerId,
        }).passthrough()),
        eligibleAuthorizations: z.array(z.unknown()).optional(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough()
type Assignment = z.infer<typeof assignmentSchema>

export class OffboardingError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) {
    super(message); this.name = 'OffboardingError'
  }
}

export interface DelegationRemovalClient {
  readonly identity: OffboardingIdentity
  inspect(tenantId: string, subscriptionId: string, displayName: string, signal: AbortSignal): Promise<OffboardingTarget>
  remove(tenantId: string, target: OffboardingTarget, beforeDelete: () => Promise<void>, signal: AbortSignal): Promise<OffboardingTarget>
}

function validSubscriptionResourcePath(
  id: string,
  type: 'registrationAssignments' | 'registrationDefinitions',
  expectedSubscriptionId?: string,
): boolean {
  const parts = id.toLowerCase().split('/')
  return parts.length === 7 && parts[0] === '' && parts[1] === 'subscriptions' &&
    lowerId.safeParse(parts[2]).success && parts[3] === 'providers' &&
    parts[4] === 'microsoft.managedservices' && parts[5] === type.toLowerCase() &&
    lowerId.safeParse(parts[6]).success &&
    (expectedSubscriptionId === undefined || parts[2] === expectedSubscriptionId.toLowerCase())
}

export class ArmDelegationRemovalClient implements DelegationRemovalClient {
  readonly identity: OffboardingIdentity
  private readonly credential: { getToken(scope: string): Promise<{ token: string } | null> }
  private readonly fetcher: typeof fetch

  constructor(identity: OffboardingIdentity, options: {
    credential?: { getToken(scope: string): Promise<{ token: string } | null> }
    fetcher?: typeof fetch
  } = {}) {
    this.identity = OffboardingIdentitySchema.parse(identity)
    if (this.identity.principalId.toLowerCase() === this.identity.collectorPrincipalId.toLowerCase()) {
      throw new OffboardingError('OFFBOARDING_IDENTITY_NOT_SEPARATE', '解除管理身份不能与 Collector 共用。')
    }
    this.credential = options.credential ?? new ManagedIdentityCredential({ clientId: this.identity.clientId })
    this.fetcher = options.fetcher ?? fetch
  }

  private async request(url: URL, method: 'GET' | 'DELETE', signal: AbortSignal): Promise<Response> {
    if (url.origin !== 'https://management.azure.com' || url.username || url.password || url.hash) {
      throw new OffboardingError('UNSAFE_ARM_URL', '拒绝非 Azure 管理面请求。')
    }
    const token = await this.credential.getToken('https://management.azure.com/.default')
    if (!token) throw new OffboardingError('OFFBOARDING_AUTH_FAILED', '无法取得解除管理身份的令牌。', 503)
    signal.throwIfAborted()
    return this.fetcher(url, {
      method, headers: { authorization: `Bearer ${token.token}` },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    })
  }

  private async assignments(subscriptionId: string, signal: AbortSignal): Promise<unknown[]> {
    lowerId.parse(subscriptionId)
    const path = `/subscriptions/${subscriptionId}/providers/Microsoft.ManagedServices/registrationAssignments`
    const first = new URL(`https://management.azure.com${path}`)
    first.searchParams.set('api-version', API_VERSION)
    first.searchParams.set('$expandRegistrationDefinition', 'true')
    const seen = new Set<string>()
    const values: unknown[] = []
    let next: string | null = first.href
    while (next) {
      const url = new URL(next)
      if (url.pathname.toLowerCase() !== path.toLowerCase() || seen.has(url.href) || seen.size >= 100) {
        throw new OffboardingError('DELEGATION_LIST_INCOMPLETE', '委派分页无法完整校验，请重试预览。')
      }
      seen.add(url.href)
      url.searchParams.set('api-version', API_VERSION)
      url.searchParams.set('$expandRegistrationDefinition', 'true')
      const response = await this.request(url, 'GET', signal)
      if (!response.ok) {
        await response.body?.cancel()
        if ([401, 403].includes(response.status)) throw new OffboardingError(
          'CUSTOMER_REAUTHORIZATION_REQUIRED',
          '独立解除管理身份尚无该订阅的权限；请客户使用新版模板重新授权，并等待权限生效。',
        )
        throw new OffboardingError('DELEGATION_READ_FAILED', `读取委派失败（HTTP ${response.status}），未执行删除。`, 503)
      }
      const page = z.object({ value: z.array(z.unknown()), nextLink: z.string().nullish() }).parse(await response.json())
      values.push(...page.value)
      next = page.nextLink ?? null
    }
    return values
  }

  private isOurOffer(item: Assignment, tenantId: string, subscriptionId: string): boolean {
    const definition = item.properties.registrationDefinition
    const properties = definition.properties
    return properties.managedByTenantId === this.identity.managingTenantId.toLowerCase() &&
      properties.manageeTenantId === tenantId &&
      properties.registrationDefinitionName === this.identity.offerName &&
      validSubscriptionResourcePath(item.id, 'registrationAssignments', subscriptionId) &&
      // Azure can reuse a definition from another subscription in the verified customer tenant.
      validSubscriptionResourcePath(item.properties.registrationDefinitionId, 'registrationDefinitions') &&
      definition.id.toLowerCase() === item.properties.registrationDefinitionId.toLowerCase()
  }

  async inspect(tenantIdInput: string, subscriptionIdInput: string, displayName: string, signal: AbortSignal): Promise<OffboardingTarget> {
    const tenantId = lowerId.parse(tenantIdInput)
    const subscriptionId = lowerId.parse(subscriptionIdInput)
    if (tenantId === this.identity.managingTenantId.toLowerCase()) throw new OffboardingError('INVALID_CUSTOMER_SCOPE', '不允许解除管理租户自身订阅。')
    const raw = await this.assignments(subscriptionId, signal)
    const assignments = raw.map((item) => {
      const parsed = assignmentSchema.safeParse(item)
      if (!parsed.success) throw new OffboardingError(
        'DELEGATION_METADATA_UNAVAILABLE', '委派列表缺少完整的套餐、租户或授权主体信息，无法安全确认删除范围。',
      )
      return parsed.data
    })
    const hasCollector = (item: Assignment) => item.properties.registrationDefinition.properties.authorizations.some((auth) =>
      auth.principalId === this.identity.collectorPrincipalId.toLowerCase() && auth.roleDefinitionId === READER_ROLE)
    const matches = assignments.filter((item) => this.isOurOffer(item, tenantId, subscriptionId) && hasCollector(item))
    if (matches.length !== 1) throw new OffboardingError(
      'DELEGATION_NOT_UNIQUE', `无法唯一确认本应用的订阅级委派（找到 ${matches.length} 条）；请客户核对授权，不会猜测删除目标。`,
    )
    const assignment = matches[0]!
    const definition = assignment.properties.registrationDefinition.properties
    const expected = new Set([
      `${this.identity.collectorPrincipalId.toLowerCase()}:${READER_ROLE}`,
      `${this.identity.principalId.toLowerCase()}:${LIGHTHOUSE_DELETE_ROLE}`,
    ])
    const authorizations = definition.authorizations.map((auth) => `${auth.principalId}:${auth.roleDefinitionId}`).sort()
    if (authorizations.length !== 2 || new Set(authorizations).size !== 2 || authorizations.some((auth) => !expected.has(auth)) ||
      (definition.eligibleAuthorizations?.length ?? 0) > 0) {
      throw new OffboardingError('DELEGATION_AUTHORIZATIONS_MISMATCH', '该委派不是预期的“Collector Reader + 独立解除身份”范围，请客户更新或手工核对。')
    }
    if (assignments.some((item) => item.id !== assignment.id && hasCollector(item))) {
      throw new OffboardingError('SHARED_COLLECTOR_DELEGATION', '同一订阅有其他委派共用 Collector。为避免影响其他授权，必须由客户核对后处理。')
    }
    if (assignment.properties.provisioningState !== 'Succeeded') {
      throw new OffboardingError('DELEGATION_NOT_READY', '委派尚未完成部署，请稍后重新预览。')
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      assignmentId: assignment.id.toLowerCase(),
      definitionId: assignment.properties.registrationDefinitionId.toLowerCase(),
      managedByTenantId: definition.managedByTenantId, tenantId, offerName: definition.registrationDefinitionName, authorizations,
    })).digest('hex')
    return {
      subscriptionId, displayName,
      assignmentId: assignment.id.toLowerCase(), definitionId: assignment.properties.registrationDefinitionId.toLowerCase(),
      fingerprint, state: 'ready', message: null,
    }
  }

  async remove(tenantId: string, target: OffboardingTarget, beforeDelete: () => Promise<void>, signal: AbortSignal): Promise<OffboardingTarget> {
    const current = await this.inspect(tenantId, target.subscriptionId, target.displayName, signal)
    if (current.fingerprint !== target.fingerprint || current.assignmentId !== target.assignmentId) {
      throw new OffboardingError('DELEGATION_CHANGED', '预览后的委派范围已变化，请重新预览，不执行旧确认。')
    }
    await beforeDelete()
    let response: Response
    try {
      response = await this.request(new URL(`https://management.azure.com${current.assignmentId}?api-version=${API_VERSION}`), 'DELETE', signal)
    } catch {
      return { ...target, state: 'unknown', message: '删除请求可能已经提交但未收到确定响应；请同步授权核对，不要盲目重复。' }
    }
    await response.body?.cancel()
    if ([200, 202, 204].includes(response.status)) {
      return { ...target, state: 'submitted', message: 'Azure 已接受解除请求，仍需授权同步确认 Collector 已失去访问权。' }
    }
    if (response.status === 404) {
      return { ...target, state: 'unknown', message: '删除时委派已不可见；请同步授权确认，不将 404 伪装为本次删除成功。' }
    }
    return {
      ...target, state: 'failed',
      message: `Azure 拒绝解除请求（HTTP ${response.status}）；未确认解除，客户业务资源未被删除。`,
    }
  }
}
