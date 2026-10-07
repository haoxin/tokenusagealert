import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AlertConflictError, MailPolicyError, type AlertProducer, type BlobAlertStore } from '@tokenusagealert/azure/alerts'
import { MailTestRequestSchema, OutboxResolutionSchema, TenantIdSchema, UpdateMailSettingsSchema } from '@tokenusagealert/schemas'
import { isSameOriginJson as sameOrigin } from './request-safety.js'

export interface MailRoutesOptions {
  store: BlobAlertStore
  producer: AlertProducer
  starter?: { start(): Promise<{ executionName: string }> }
}
function problem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  request.log.warn({ code, status }, detail)
  return reply.status(status).type('application/problem+json').send({
    type: `urn:tokenusagealert:problem:${code.toLowerCase()}`, title: code, status, code, detail,
    instance: request.url, correlationId: request.id,
  })
}
async function settingsResponse(
  mail: MailRoutesOptions,
  stored: Awaited<ReturnType<BlobAlertStore['settings']>>,
  warning: string | null = null,
) {
  const authorization = await mail.store.senderAuthorization(stored.settings)
  return {
    settings: stored.settings, etag: stored.etag,
    allowedRecipientDomains: mail.store.policy.allowedRecipientDomains,
    dispatcherConfigured: Boolean(mail.starter), mode: mail.store.policy.mode,
    authorizationReady: authorization.ready, graphTestAvailable: mail.store.graphTestAvailable,
    senderAuthorizationSource: authorization.source, senderVerifiedAtUtc: authorization.checkedAtUtc,
    warning,
  }
}

export function registerMailRoutes(app: FastifyInstance, mail: MailRoutesOptions | undefined) {
  app.get('/api/v1/settings/alerting', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    const settings = await mail.store.settings()
    return settingsResponse(mail, settings)
  })
  app.patch('/api/v1/settings/alerting', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    if (!sameOrigin(request)) return problem(request, reply, 403, 'MAIL_ORIGIN_REJECTED', '请使用同源 JSON 请求。')
    const body = UpdateMailSettingsSchema.safeParse(request.body)
    if (!body.success) return problem(request, reply, 400, 'INVALID_MAIL_SETTINGS', '请填写有效的发件邮箱和运维收件地址；启用时收件人不可为空。')
    if (body.data.enabled && !mail.store.policy.authorizationReady && mail.store.policy.mode === 'graph') {
      return problem(request, reply, 409, 'MAILBOX_AUTHORIZATION_REQUIRED', '管理员尚未完成 Exchange 单邮箱授权，真实邮件不能启用。')
    }
    const match = request.headers['if-match']
    const create = request.headers['if-none-match'] === '*'
    if (!create && typeof match !== 'string') return problem(request, reply, 428, 'MAIL_SETTINGS_PRECONDITION_REQUIRED', '保存必须携带当前 ETag。')
    try {
      const settings = await mail.store.saveSettings(body.data, typeof match === 'string' ? match : null, request.principal!.objectId)
      return await settingsResponse(mail, settings, settings.senderChanged ?
        '发件邮箱已更换，自动通知已关闭。请核对新邮箱的 Exchange 授权并完成真实发信测试，再手动启用通知。' : null)
    } catch (error) {
      if (error instanceof AlertConflictError) return problem(request, reply, 412, 'MAIL_SETTINGS_CONFLICT', error.message)
      if (error instanceof MailPolicyError) return problem(request, reply, 400, 'MAIL_POLICY_REJECTED', error.message)
      request.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Mail settings update failed')
      return problem(request, reply, 503, 'MAIL_SETTINGS_SAVE_FAILED', '配置保存失败，请检查存储状态并刷新重试。')
    }
  })
  app.post('/api/v1/settings/alerting/test', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    if (!sameOrigin(request)) return problem(request, reply, 403, 'MAIL_ORIGIN_REJECTED', '请使用同源 JSON 请求。')
    const body = MailTestRequestSchema.safeParse(request.body)
    if (!body.success) return problem(request, reply, 400, 'INVALID_MAIL_TEST', '请提供有效的请求 ID 和测试收件人。')
    if (!body.data.preview && !mail.store.graphTestAvailable && mail.store.policy.mode === 'graph') {
      return problem(request, reply, 409, 'MAILBOX_AUTHORIZATION_REQUIRED', '当前只能预览，专用邮件身份授权或部署绑定尚未完成。')
    }
    try {
      const mode = body.data.preview || mail.store.policy.mode === 'preview' ? 'preview' : 'graph'
      const event = await mail.producer.test(body.data.requestId, body.data.recipient, mode, body.data.senderMailbox)
      let dispatcherRequested = false
      let warning: string | null = null
      if (mail.starter) {
        try { await mail.starter.start(); dispatcherRequested = true } catch {
          warning = '测试事件已入队，但手工启动任务失败；计划任务将重试处理。'
          request.log.error('Manual mail dispatcher start failed after test event was queued')
        }
      } else warning = '测试事件已入队；请运行邮件任务后查看状态。'
      return reply.status(202).send({ event, dispatcherRequested, warning })
    } catch (error) {
      if (error instanceof MailPolicyError) return problem(request, reply, 400, 'MAIL_TEST_REJECTED', error.message)
      if (error instanceof AlertConflictError) return problem(request, reply, 409, 'MAIL_TEST_CONFLICT', error.message)
      request.log.warn({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Mail test rejected')
      return problem(request, reply, 503, 'MAIL_TEST_QUEUE_FAILED', '测试事件未能完成入队，请检查存储和运行状态。')
    }
  })
  app.get('/api/v1/operations/mail', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    return { run: await mail.store.latestRun() }
  })
  app.get('/api/v1/operations/outbox', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(200).optional() }).strict().safeParse(request.query)
    if (!query.success) return problem(request, reply, 400, 'INVALID_OUTBOX_QUERY', 'Outbox 每页最多 50 条。')
    return mail.store.listOutbox(query.data.limit, query.data.cursor)
  })
  app.get<{ Params: { id: string } }>('/api/v1/operations/outbox/:id', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    if (!/^[a-f0-9]{64}$/.test(request.params.id)) return problem(request, reply, 400, 'INVALID_EVENT_ID', '事件 ID 无效。')
    const result = await mail.store.outbox(request.params.id)
    return result ? { item: result.value, etag: result.etag } : problem(request, reply, 404, 'OUTBOX_NOT_FOUND', '事件不存在。')
  })
  app.post<{ Params: { id: string } }>('/api/v1/operations/outbox/:id/resolve', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    if (!sameOrigin(request)) return problem(request, reply, 403, 'MAIL_ORIGIN_REJECTED', '请使用同源 JSON 请求。')
    const body = OutboxResolutionSchema.safeParse(request.body)
    const etag = request.headers['if-match']
    if (!body.success || typeof etag !== 'string' || !/^[a-f0-9]{64}$/.test(request.params.id)) {
      return problem(request, reply, 400, 'INVALID_OUTBOX_RESOLUTION', '请填写人工核对原因并携带当前 ETag。')
    }
    try {
      const item = await mail.store.resolve(request.params.id, etag, body.data.action, body.data.reason, request.principal!.objectId)
      return { item }
    } catch (error) {
      if (error instanceof AlertConflictError) return problem(request, reply, 412, 'OUTBOX_CONFLICT', error.message)
      throw error
    }
  })
  app.get<{ Params: { tenantId: string } }>('/api/v1/tenants/:tenantId/alerts', async (request, reply) => {
    if (!mail) return problem(request, reply, 503, 'MAIL_NOT_CONFIGURED', '邮件模块尚未配置。')
    const id = TenantIdSchema.safeParse(request.params.tenantId)
    if (!id.success) return problem(request, reply, 400, 'INVALID_TENANT_ID', '租户 ID 无效。')
    return { items: await mail.store.timeline(`tenant-${id.data}`) }
  })
}
