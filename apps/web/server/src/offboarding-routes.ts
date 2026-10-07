import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  OffboardingExecuteRequestSchema, OffboardingPreviewRequestSchema, TenantIdSchema,
} from '@tokenusagealert/schemas'
import { OffboardingError, type OffboardingService } from '@tokenusagealert/azure/offboarding'
import { StorageLeaseBusyError } from '@tokenusagealert/azure/usage'
import { TenantNotFoundError } from '@tokenusagealert/azure'
import { isSameOriginJson } from './request-safety.js'

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const known = error instanceof OffboardingError
  const code = known ? error.code : error instanceof StorageLeaseBusyError ? 'OFFBOARDING_BUSY'
    : error instanceof TenantNotFoundError ? 'TENANT_NOT_FOUND' : 'OFFBOARDING_FAILED'
  const status = known ? error.httpStatus : error instanceof StorageLeaseBusyError ? 409
    : error instanceof TenantNotFoundError ? 404 : 503
  const detail = known ? error.message
    : '解除操作未能完成或状态尚未确认；请刷新操作状态，不要据此假定已解除。'
  request.log.warn({ code, status, errorType: error instanceof Error ? error.name : 'UnknownError' }, detail)
  return reply.status(status).type('application/problem+json').send({
    type: `urn:tokenusagealert:problem:${code.toLowerCase()}`, status, title: code, code, detail,
    instance: request.url, correlationId: request.id,
  })
}

export function registerOffboardingRoutes(app: FastifyInstance, service: OffboardingService | undefined) {
  app.post<{ Params: { tenantId: string } }>('/api/v1/tenants/:tenantId/offboarding/preview', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!isSameOriginJson(request)) return failure(request, reply, new OffboardingError('OFFBOARDING_ORIGIN_REJECTED', '请从同源页面发起 JSON 请求。', 403))
    const id = TenantIdSchema.safeParse(request.params.tenantId)
    const body = OffboardingPreviewRequestSchema.safeParse(request.body)
    if (!id.success || !body.success) return failure(request, reply, new OffboardingError('INVALID_OFFBOARDING_REQUEST', '请提供有效租户/订阅 ID，不接受自定义 Azure 资源路径。', 400))
    if (!service) return {
      configured: false, identity: null, operation: null,
      blockers: [{ subscriptionId: body.data.subscriptionId ?? null, code: 'OFFBOARDING_NOT_CONFIGURED', message: '独立解除管理身份尚未配置，请使用客户 Azure 操作指引。' }],
    }
    try { return await service.preview(id.data, body.data.subscriptionId ?? null, request.principal!.objectId) }
    catch (error) { return failure(request, reply, error) }
  })

  app.get<{ Params: { id: string } }>('/api/v1/authorization/offboarding/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const id = TenantIdSchema.safeParse(request.params.id)
    if (!id.success) return failure(request, reply, new OffboardingError('INVALID_OPERATION_ID', '操作 ID 无效。', 400))
    if (!service) return failure(request, reply, new OffboardingError('OFFBOARDING_NOT_CONFIGURED', '解除管理身份尚未配置。', 503))
    try { return { operation: (await service.get(id.data, request.principal!.objectId)).operation } }
    catch (error) { return failure(request, reply, error) }
  })

  app.post<{ Params: { id: string } }>('/api/v1/authorization/offboarding/:id/execute', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!isSameOriginJson(request)) return failure(request, reply, new OffboardingError('OFFBOARDING_ORIGIN_REJECTED', '请从同源页面发起 JSON 请求。', 403))
    const id = TenantIdSchema.safeParse(request.params.id)
    const body = OffboardingExecuteRequestSchema.safeParse(request.body)
    if (!id.success || !body.success) return failure(request, reply, new OffboardingError('INVALID_OFFBOARDING_CONFIRMATION', '必须输入目标租户或订阅 ID 确认。', 400))
    if (!service) return failure(request, reply, new OffboardingError('OFFBOARDING_NOT_CONFIGURED', '解除管理身份尚未配置。', 503))
    try { return { operation: await service.execute(id.data, body.data.confirmation, request.principal!.objectId) } }
    catch (error) { return failure(request, reply, error) }
  })
}
