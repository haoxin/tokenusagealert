import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import {
  TenantAlreadyExistsError,
  TenantCannotBeDeletedError,
  TenantCannotBeUpdatedError,
  TenantCannotBeEnabledError,
  TenantConcurrencyError,
  TenantNotFoundError,
  type AuthenticatedActor,
  type CreateTenantResult,
  type DeleteTenantRegistrationResult,
} from '@tokenusagealert/azure'
import type { AuthorizationSyncStarter } from '@tokenusagealert/azure/authorization'
import {
  CreateTenantRequestSchema,
  EnableTenantRequestSchema,
  TenantIdSchema,
  UpdateTenantSettingsRequestSchema,
  type CreateTenantRequest,
  type TenantListItem,
  type UpdateTenantSettingsRequest,
} from '@tokenusagealert/schemas'
import { z, ZodError } from 'zod'
import { resolvePrincipal } from './auth.js'
import type { AppConfig } from './config.js'
import { registerPricingRoutes, type PricingRoutesOptions } from './pricing-routes.js'
import { registerUsageRoutes, type UsageRoutesOptions } from './usage-routes.js'
import { registerMailRoutes, type MailRoutesOptions } from './mail-routes.js'
import { registerOffboardingRoutes } from './offboarding-routes.js'
import type { OffboardingService } from '@tokenusagealert/azure/offboarding'
import { isSameOriginJson, isStrongEntityTag } from './request-safety.js'
import { StorageLeaseBusyError } from '@tokenusagealert/azure/usage'
import { registerManualPricingRoutes, type ManualPricingRoutesOptions } from './manual-pricing-routes.js'

export interface TenantRepository {
  checkReady(): Promise<void>
  listTenants(): Promise<TenantListItem[]>
  getTenant(tenantId: string): Promise<TenantListItem>
  createTenant(
    request: CreateTenantRequest,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<CreateTenantResult>
  deletePendingTenant(
    tenantId: string,
    expectedEtag: string,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<DeleteTenantRegistrationResult>
  updateTenantSettings(
    tenantId: string,
    input: UpdateTenantSettingsRequest,
    expectedEtag: string,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<TenantListItem>
  getSubscriptionInventory(
    tenantId: string,
  ): Promise<import('@tokenusagealert/schemas').SubscriptionInventoryDocument | null>
  getLatestAuthorizationSyncRun(): Promise<
    import('@tokenusagealert/schemas').AuthorizationSyncRun | null
  >
  enableTenant(
    tenantId: string,
    request: import('@tokenusagealert/schemas').EnableTenantRequest,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<TenantListItem>
}

interface BuildAppOptions {
  config: AppConfig
  repository: TenantRepository
  authorizationSyncStarter?: AuthorizationSyncStarter
  pricing?: PricingRoutesOptions
  usage?: UsageRoutesOptions
  mail?: MailRoutesOptions
  offboarding?: OffboardingService
  manualPricing?: ManualPricingRoutesOptions
}

interface ProblemOptions {
  status: number
  title: string
  detail: string
  code: string
  errors?: Record<string, string[]>
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: ProblemOptions,
) {
  return reply
    .status(problem.status)
    .type('application/problem+json')
    .send({
      type: `https://tokenusagealert.local/problems/${problem.code.toLowerCase()}`,
      title: problem.title,
      status: problem.status,
      detail: problem.detail,
      instance: request.url,
      code: problem.code,
      correlationId: request.id,
      ...(problem.errors ? { errors: problem.errors } : {}),
    })
}

function zodErrors(error: ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'request'
    errors[key] = [...(errors[key] ?? []), issue.message]
  }
  return errors
}

export async function buildApp({
  config,
  repository,
  authorizationSyncStarter,
  pricing,
  usage,
  mail,
  offboarding,
  manualPricing,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.x-ms-client-principal',
          'req.headers.x-ms-token-aad-access-token',
        ],
        censor: '[REDACTED]',
      },
    },
    requestIdHeader: 'x-correlation-id',
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id)
  })

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Unhandled request error')
    return sendProblem(request, reply, {
      status: 500,
      title: 'Internal server error',
      detail: 'The server could not complete the request.',
      code: 'INTERNAL_ERROR',
    })
  })

  app.get('/health/live', async () => ({
    status: 'ok',
  }))

  app.get('/health/ready', async (request, reply) => {
    try {
      await repository.checkReady()
      return { status: 'ready' }
    } catch (error) {
      request.log.error({ err: error }, 'Blob readiness check failed')
      return sendProblem(request, reply, {
        status: 503,
        title: 'Service unavailable',
        detail: 'Required Blob containers are not accessible.',
        code: 'STORAGE_NOT_READY',
      })
    }
  })

  app.addHook('preHandler', async (request, reply) => {
    if (
      request.url.startsWith('/health/') ||
      !request.url.startsWith('/api/')
    ) {
      return
    }

    const principal = resolvePrincipal(request, config)
    if (!principal) {
      return sendProblem(request, reply, {
        status: 401,
        title: 'Authentication required',
        detail: 'A valid Microsoft Entra session is required.',
        code: 'AUTHENTICATION_REQUIRED',
      })
    }
    request.principal = principal
  })

  app.get('/api/v1/session', async (request) => request.principal)

  app.get('/api/v1/tenants', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const query = z.object({ includeRemoved: z.enum(['true', 'false']).default('false') }).strict().safeParse(request.query)
    if (!query.success) return sendProblem(request, reply, {
      status: 400, title: 'Invalid tenant query', code: 'INVALID_TENANT_QUERY',
      detail: 'includeRemoved must be true or false.',
    })
    const items = (await repository.listTenants()).filter((tenant) =>
      query.data.includeRemoved === 'true' || tenant.status !== 'deleted')
    return { items, count: items.length }
  })

  app.get<{ Params: { tenantId: string } }>(
    '/api/v1/tenants/:tenantId',
    async (request, reply) => {
      const parsed = TenantIdSchema.safeParse(request.params.tenantId)
      if (!parsed.success) {
        return sendProblem(request, reply, {
          status: 400,
          title: 'Invalid tenant ID',
          detail: 'The tenant ID must be a valid GUID.',
          code: 'INVALID_TENANT_ID',
          errors: zodErrors(parsed.error),
        })
      }

      try {
        return { tenant: await repository.getTenant(parsed.data) }
      } catch (error) {
        if (error instanceof TenantNotFoundError) {
          return sendProblem(request, reply, {
            status: 404,
            title: 'Tenant not found',
            detail: `Tenant ${parsed.data} was not found.`,
            code: 'TENANT_NOT_FOUND',
          })
        }
        throw error
      }
    },
  )

  app.post('/api/v1/tenants', async (request, reply) => {
    const parsed = CreateTenantRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      return sendProblem(request, reply, {
        status: 400,
        title: 'Invalid tenant request',
        detail: 'One or more tenant fields are invalid.',
        code: 'VALIDATION_FAILED',
        errors: zodErrors(parsed.error),
      })
    }

    try {
      const result = await repository.createTenant(
        parsed.data,
        {
          objectId: request.principal!.objectId,
          name: request.principal!.name,
        },
        request.id,
      )
      const warnings = result.auditCompletionRecorded
        ? undefined
        : [
            {
              code: 'AUDIT_COMPLETION_WRITE_FAILED',
              message:
                'The tenant was created and the requested audit event exists, but the completion event could not be written.',
            },
          ]
      if (warnings) {
        request.log.error(
          { tenantId: result.tenant.tenantId },
          'Tenant created but audit completion event failed',
        )
      }

      return reply
        .status(201)
        .header('etag', result.tenant.etag)
        .send({
          tenant: result.tenant,
          ...(warnings ? { warnings } : {}),
        })
    } catch (error) {
      if (error instanceof TenantAlreadyExistsError) {
        return sendProblem(request, reply, {
          status: 409,
          title: 'Tenant already exists',
          detail: `Tenant ${error.tenantId} is already registered.`,
          code: 'TENANT_ALREADY_EXISTS',
        })
      }
      throw error
    }
  })

  app.patch<{ Params: { tenantId: string } }>(
    '/api/v1/tenants/:tenantId',
    async (request, reply) => {
      const reject = (problem: ProblemOptions) => {
        request.log.warn({ code: problem.code, tenantId: request.params.tenantId }, problem.detail)
        return sendProblem(request, reply, problem)
      }
      if (!isSameOriginJson(request)) return reject({
        status: 403, title: 'Tenant update rejected', code: 'TENANT_UPDATE_ORIGIN_REJECTED',
        detail: '请使用同源 JSON 请求修改租户配置。',
      })
      const tenantId = TenantIdSchema.safeParse(request.params.tenantId)
      const input = UpdateTenantSettingsRequestSchema.safeParse(request.body)
      if (!tenantId.success || !input.success) return reject({
        status: 400, title: 'Invalid tenant settings', code: 'INVALID_TENANT_SETTINGS',
        detail: '请填写 1–120 字符的名称及大于零的 USD/小时费用限额（最多 6 位小数）；不能修改授权状态。',
        ...(!input.success ? { errors: zodErrors(input.error) } : {}),
      })
      const etag = request.headers['if-match']
      if (!isStrongEntityTag(etag)) return reject({
        status: 428, title: 'Tenant version required', code: 'TENANT_UPDATE_PRECONDITION_REQUIRED',
        detail: '修改必须携带当前租户 ETag，请刷新后重试。',
      })
      try {
        const tenant = await repository.updateTenantSettings(tenantId.data, input.data, etag,
          { objectId: request.principal!.objectId, name: request.principal!.name }, request.id)
        return reply.header('etag', tenant.etag).send({ tenant })
      } catch (error) {
        if (error instanceof TenantConcurrencyError) return reject({
          status: 412, title: 'Tenant was modified', code: 'TENANT_ETAG_MISMATCH',
          detail: '租户配置或授权状态已变化，请刷新核对后再修改。',
        })
        if (error instanceof TenantCannotBeUpdatedError) return reject({
          status: 409, title: 'Tenant cannot be updated', code: 'TENANT_CANNOT_BE_UPDATED', detail: error.message,
        })
        if (error instanceof TenantNotFoundError) return reject({
          status: 404, title: 'Tenant not found', code: 'TENANT_NOT_FOUND', detail: '租户已不存在，请刷新列表。',
        })
        if (error instanceof StorageLeaseBusyError) return reject({
          status: 409, title: 'Tenant operation in progress', code: 'TENANT_OPERATION_BUSY',
          detail: '授权同步或其他租户操作正在进行，请稍后刷新核对。',
        })
        request.log.error({ err: error, tenantId: tenantId.data }, 'Tenant settings update could not be confirmed')
        return sendProblem(request, reply, {
          status: 503, title: 'Tenant update unavailable', code: 'TENANT_UPDATE_FAILED',
          detail: '未能确认完整保存结果，请刷新核对配置和审计状态；不要重复提交。',
        })
      }
    },
  )

  app.delete<{ Params: { tenantId: string } }>(
    '/api/v1/tenants/:tenantId',
    async (request, reply) => {
      const reject = (problem: ProblemOptions) => {
        request.log.warn({ code: problem.code, tenantId: request.params.tenantId }, problem.detail)
        return sendProblem(request, reply, problem)
      }
      if (!isSameOriginJson(request)) return reject({
        status: 403, title: 'Tenant deletion rejected', code: 'TENANT_DELETE_ORIGIN_REJECTED',
        detail: '请使用同源 JSON 请求删除预登记。',
      })
      const tenantId = TenantIdSchema.safeParse(request.params.tenantId)
      if (!tenantId.success || !z.object({}).strict().safeParse(request.body).success) return reject({
        status: 400, title: 'Invalid tenant deletion request', code: 'INVALID_TENANT_DELETE_REQUEST',
        detail: '请提供有效的租户 ID 和空 JSON 请求体。',
      })
      const etag = request.headers['if-match']
      if (!isStrongEntityTag(etag)) return reject({
        status: 428, title: 'Tenant version required', code: 'TENANT_DELETE_PRECONDITION_REQUIRED',
        detail: '删除必须携带当前租户的单个完整 ETag，请刷新列表后重试。',
      })
      try {
        const result = await repository.deletePendingTenant(
          tenantId.data, etag,
          { objectId: request.principal!.objectId, name: request.principal!.name },
          request.id,
        )
        const warnings = result.auditCompletionRecorded ? undefined : [{
          code: 'AUDIT_COMPLETION_WRITE_FAILED',
          message: '租户预登记已删除，删除请求审计已保存，但完成审计写入失败，请联系管理员检查日志。',
        }]
        if (warnings) request.log.error({ tenantId: result.tenantId }, 'Tenant deleted but audit completion event failed')
        else request.log.info({ tenantId: result.tenantId }, 'Pending tenant registration deleted')
        return { tenantId: result.tenantId, deleted: true, ...(warnings ? { warnings } : {}) }
      } catch (error) {
        if (error instanceof TenantConcurrencyError) return reject({
          status: 412, title: 'Tenant was modified', code: 'TENANT_ETAG_MISMATCH',
          detail: '租户配置或授权状态已变化，未执行删除。请刷新列表后核对。',
        })
        if (error instanceof TenantCannotBeDeletedError) return reject({
          status: 409, title: 'Tenant cannot be deleted', code: 'TENANT_CANNOT_BE_DELETED',
          detail: error.message,
        })
        if (error instanceof TenantNotFoundError) return reject({
          status: 404, title: 'Tenant not found', code: 'TENANT_NOT_FOUND',
          detail: '租户登记已不存在，请刷新列表。',
        })
        if (error instanceof StorageLeaseBusyError) return reject({
          status: 409, title: 'Tenant operation in progress', code: 'TENANT_OPERATION_BUSY',
          detail: '授权同步或其他租户操作正在执行，未删除登记。请稍后刷新列表再操作。',
        })
        request.log.error({ err: error, tenantId: tenantId.data }, 'Pending tenant deletion failed')
        return sendProblem(request, reply, {
          status: 503, title: 'Tenant deletion unavailable', code: 'TENANT_DELETE_FAILED',
          detail: '未能确认删除结果，请刷新列表核对，并检查存储和审计状态；不要重复提交。',
        })
      }
    },
  )

  app.post('/api/v1/authorization/sync', async (request, reply) => {
    if (!authorizationSyncStarter) {
      return sendProblem(request, reply, {
        status: 503,
        title: 'Authorization sync unavailable',
        detail: 'Authorization synchronization is not configured.',
        code: 'AUTHORIZATION_SYNC_UNAVAILABLE',
      })
    }
    const result = await authorizationSyncStarter.start()
    return reply.status(202).send({
      executionName: result.executionName,
      status: 'started',
    })
  })

  app.get('/api/v1/authorization/runs/latest', async () => ({
    run: await repository.getLatestAuthorizationSyncRun(),
  }))

  app.get<{ Params: { tenantId: string } }>(
    '/api/v1/tenants/:tenantId/subscriptions',
    async (request, reply) => {
      const parsed = TenantIdSchema.safeParse(request.params.tenantId)
      if (!parsed.success) {
        return sendProblem(request, reply, {
          status: 400,
          title: 'Invalid tenant ID',
          detail: 'The tenant ID must be a valid GUID.',
          code: 'INVALID_TENANT_ID',
        })
      }
      return {
        inventory:
          await repository.getSubscriptionInventory(parsed.data),
      }
    },
  )

  app.post<{ Params: { tenantId: string } }>(
    '/api/v1/tenants/:tenantId/enable',
    async (request, reply) => {
      const tenantId = TenantIdSchema.safeParse(request.params.tenantId)
      const body = EnableTenantRequestSchema.safeParse(request.body)
      if (!tenantId.success || !body.success) {
        const errors = body.success ? undefined : zodErrors(body.error)
        return sendProblem(request, reply, {
          status: 400,
          title: 'Invalid enable request',
          detail: 'Tenant ID or enable fields are invalid.',
          code: 'VALIDATION_FAILED',
          ...(errors ? { errors } : {}),
        })
      }
      try {
        const tenant = await repository.enableTenant(
          tenantId.data,
          body.data,
          {
            objectId: request.principal!.objectId,
            name: request.principal!.name,
          },
          request.id,
        )
        return { tenant }
      } catch (error) {
        if (error instanceof TenantConcurrencyError) {
          return sendProblem(request, reply, {
            status: 412,
            title: 'Tenant was modified',
            detail: 'Reload the tenant before enabling it.',
            code: 'TENANT_ETAG_MISMATCH',
          })
        }
        if (error instanceof TenantCannotBeEnabledError) {
          return sendProblem(request, reply, {
            status: 409,
            title: 'Tenant cannot be enabled',
            detail: error.message,
            code: 'TENANT_CANNOT_BE_ENABLED',
          })
        }
        if (error instanceof TenantNotFoundError) {
          return sendProblem(request, reply, {
            status: 404,
            title: 'Tenant not found',
            detail: error.message,
            code: 'TENANT_NOT_FOUND',
          })
        }
        throw error
      }
    },
  )

  registerPricingRoutes(app, pricing)
  registerManualPricingRoutes(app, manualPricing)
  registerUsageRoutes(app, usage)
  registerMailRoutes(app, mail)
  registerOffboardingRoutes(app, offboarding)

  if (config.NODE_ENV === 'production') {
    const clientRoot = fileURLToPath(
      new URL('../../client/dist/', import.meta.url),
    )
    await app.register(fastifyStatic, {
      root: clientRoot,
      wildcard: false,
    })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html')
      }
      return sendProblem(request, reply, {
        status: 404,
        title: 'Not found',
        detail: 'The requested resource was not found.',
        code: 'NOT_FOUND',
      })
    })
  }

  return app
}
