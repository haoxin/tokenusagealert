import { randomUUID } from 'node:crypto'
import { DefaultAzureCredential } from '@azure/identity'
import { alertEmailSuppression, mapConcurrent } from '@tokenusagealert/domain'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import type { AlertKind, MailRun, OutboxRecord } from '@tokenusagealert/schemas'
import { AlertProducer } from './alert-producer.js'
import { BlobAlertStore, MailPolicyError, terminalOutboxStatuses } from './alert-store.js'

const labels: Record<AlertKind, string> = {
  'cost-exceeded': '估算费用超限', 'cost-reminder': '估算费用持续超限',
  'cost-recovered': '估算费用已恢复', 'data-quality': '数据质量异常',
  'data-reminder': '数据质量异常持续', 'data-recovered': '数据质量已恢复', test: '发信授权测试',
}
const date = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value)) : '—'

function amountText(value: string): string {
  const amount = new Decimal(value)
  if (amount.gt(0) && amount.lt('0.000001')) return '<0.000001'
  const [whole, fraction = ''] = amount.toFixed(6, Decimal.ROUND_HALF_EVEN).split('.')
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`
}

export function mailMessage(record: OutboxRecord, publicUrl: string) {
  const event = record.event
  const costAlert = event.kind === 'cost-exceeded' || event.kind === 'cost-reminder'
  const range = event.amountUsd !== null && event.amountUpperUsd !== undefined &&
    (event.amountUpperUsd === null || !new Decimal(event.amountUsd).eq(event.amountUpperUsd))
  const amount = event.amountUsd === null ? '—' : event.amountUpperUsd === null
    ? `USD ${amountText(event.amountUsd)} 起（完整上限未知）`
    : range && event.amountUpperUsd !== undefined
      ? `USD ${amountText(event.amountUsd)}–${amountText(event.amountUpperUsd)}`
      : `USD ${amountText(event.amountUsd)}`
  const dataStatus = {
    complete: '完整', partial: '部分数据（存在缺失）', failed: '采集失败', none: '无可用数据',
  }[event.dataStatus]
  const lines = [
    'Azure OpenAI 用量费用告警平台',
    `事件：${labels[event.kind]}`,
    '',
    `租户：${event.tenantName}`,
    `${event.dataStatus === 'partial' ? '已知估算小计（部分数据）' : '估算费用'}：${amount}`,
    `小时阈值：${event.thresholdUsd === null ? '—' : `USD ${amountText(event.thresholdUsd)}`}`,
    `北京时间窗口：${date(event.windowStartUtc)} 至 ${date(event.windowEndUtc)}`,
    `数据状态：${dataStatus}`,
    '',
    event.repricedAtUtc
      ? `历史补算：${date(event.repricedAtUtc)} 补齐该小时缺价；不是当前小时超限，也没有改变当前告警状态。` : null,
    event.manualPriceSnapshotId
      ? '价格策略：官方优先；手动单价仅用于缺价备用，按统一输入/输出 token 价估算，不区分上下文档位。'
      : null,
    '说明：所有金额均为 USD 公开零售价估算，不是 Azure 实际账单；无法区分的缓存读取按普通输入价保守估算。',
    range ? '区间说明：小时指标未区分全部上下文、模态、服务档位或缓存写入条件；估算区间不是额外消费。' : null,
    event.kind === 'test' ? '本邮件仅用于发信链路验证，不代表真实模型用量或告警。' : null,
    ...(event.issues.length ? ['', '数据问题：', ...event.issues.map((issue) => `- ${issue.code}：${issue.message}`)] : []),
    '',
    `详情：${publicUrl.replace(/\/$/, '')}${event.tenantId ? `/tenants/${event.tenantId}/usage` : '/operations'}`,
    `事件 ID：${event.id}`,
    event.manualPriceSnapshotId ? `手动价格快照引用：${event.manualPriceSnapshotId}` : null,
  ].filter((line): line is string => line !== null)
  return {
    subject: `[AOAI][${labels[event.kind]}${event.repricedAtUtc ? '·历史补算' : ''}][${event.id.slice(0, 10)}] ${costAlert ? `${amount} · ` : ''}${event.tenantName}`.replace(/[\r\n]/g, ' ').slice(0, 220),
    body: { contentType: 'Text', content: lines.join('\n') },
    toRecipients: record.recipients.map((address) => ({ emailAddress: { address } })),
    internetMessageHeaders: [{ name: 'x-aoai-alert-id', value: event.id }],
  }
}

export type MailAttemptResult =
  | { status: 'accepted' | 'previewed'; requestId: string | null }
  | { status: 'failed' | 'unknown' | 'retry'; code: string; message: string; retryAtUtc?: string; authorizationRejected?: boolean }
export interface MailSender {
  attempt(record: OutboxRecord, beforeSubmission: () => Promise<void>, signal: AbortSignal): Promise<MailAttemptResult>
}

export class GraphMailSender implements MailSender {
  private readonly credential: { getToken(scope: string): Promise<{ token: string } | null> }
  constructor(private readonly options: {
    clientId?: string
    authorizationReady: boolean
    publicUrl: string
    fetcher?: typeof fetch
    credential?: { getToken(scope: string): Promise<{ token: string } | null> }
  }) {
    this.credential = options.credential ??
      (options.clientId ? new DefaultAzureCredential({ managedIdentityClientId: options.clientId }) : new DefaultAzureCredential())
  }
  async attempt(record: OutboxRecord, beforeSubmission: () => Promise<void>, signal: AbortSignal): Promise<MailAttemptResult> {
    if (record.mode === 'preview') return { status: 'previewed', requestId: null }
    if (!this.options.authorizationReady) {
      return { status: 'failed', code: 'MAILBOX_AUTHORIZATION_REQUIRED', message: '邮箱应用授权尚未完成，没有请求 Graph 发信。' }
    }
    let token: { token: string } | null
    try { token = await this.credential.getToken('https://graph.microsoft.com/.default') }
    catch { return { status: 'failed', code: 'GRAPH_AUTHENTICATION_FAILED', message: '无法取得 Graph 应用令牌；尚未提交邮件。' } }
    if (!token) return { status: 'failed', code: 'GRAPH_AUTHENTICATION_FAILED', message: '未取得 Graph 令牌。' }
    await beforeSubmission()
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(record.sender)}/sendMail`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: mailMessage(record, this.options.publicUrl), saveToSentItems: true }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      })
    } catch {
      return { status: 'unknown', code: 'GRAPH_RESULT_UNKNOWN', message: '邮件已开始提交但未收到确定响应；禁止自动重发，请核对 Exchange 消息跟踪。' }
    }
    if (response.status === 202) return { status: 'accepted', requestId: response.headers.get('request-id') }
    if (response.ok) return { status: 'unknown', code: 'GRAPH_UNEXPECTED_SUCCESS_STATUS', message: `Graph 返回非预期 HTTP ${response.status}，需人工核对，不自动重发。` }
    let code = `GRAPH_HTTP_${response.status}`
    let message = `Graph 返回 HTTP ${response.status}。`
    try {
      const body = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(await response.json())
      if (body.success) { code = body.data.error.code; message = body.data.error.message.slice(0, 500) }
    } catch { /* The HTTP failure status is still authoritative without a JSON error body. */ }
    if ([429, 500, 502, 503, 504].includes(response.status)) {
      const after = response.headers.get('retry-after')
      const delay = after && /^\d+$/.test(after) ? Number(after) * 1000
        : after && Number.isFinite(Date.parse(after)) ? Math.max(0, Date.parse(after) - Date.now())
          : Math.min(300_000, 30_000 * 2 ** record.attempts)
      return { status: 'retry', code, message, retryAtUtc: new Date(Date.now() + delay).toISOString() }
    }
    return { status: 'failed', code, message, ...([401, 403, 404].includes(response.status) ? { authorizationRejected: true } : {}) }
  }
}

class MailConfigurationChangedError extends Error {
  constructor(readonly suppression: { code: string; message: string }) { super(suppression.message) }
}

export class MailDispatcher {
  constructor(
    private readonly store: BlobAlertStore,
    private readonly sender: MailSender,
    private readonly platformIssues?: () => Promise<Array<{ code: string; message: string }>>,
  ) {}

  async run(): Promise<MailRun> {
    const started = new Date().toISOString()
    return this.store.dispatchLease(async (signal) => {
      const run: MailRun = {
        schemaVersion: 1, runId: randomUUID(), startedAtUtc: started, finishedAtUtc: started,
        status: 'succeeded', mode: this.store.policy.mode, processed: 0, accepted: 0, failed: 0,
        unknown: 0, previewed: 0, suppressed: 0, errors: [],
      }
      try {
        await this.store.reconcilePending()
        if (this.platformIssues) await new AlertProducer(this.store).platform(await this.platformIssues())
        const ids = await this.store.active(200)
        const results = await mapConcurrent(ids, 2, (id) => this.process(id, signal), signal)
        for (const result of results) {
          if (result.status === 'rejected') {
            run.errors.push({ code: 'OUTBOX_PROCESSING_FAILED', message: '部分 Outbox 无法更新；保留状态供下一轮恢复，没有假定邮件已发送。' })
            continue
          }
          const state = result.value
          if (!state) continue
          run.processed += 1
          if (state === 'accepted') run.accepted += 1
          if (state === 'failed') run.failed += 1
          if (state === 'unknown') run.unknown += 1
          if (state === 'previewed') run.previewed += 1
          if (state === 'suppressed' || state === 'closed') run.suppressed += 1
        }
        if (run.failed || run.unknown || run.errors.length) run.status = 'succeededWithWarnings'
      } catch {
        run.status = 'failed'
        run.errors.push({ code: 'MAIL_DISPATCH_FAILED', message: '邮件任务未完成；仅记录到 GUI/日志，不递归发送邮件失败告警。' })
      }
      run.finishedAtUtc = new Date().toISOString()
      await this.store.writeRun(run)
      return run
    })
  }

  private async suppression(record: OutboxRecord): Promise<{ code: string; message: string } | null> {
    const policy = alertEmailSuppression(record.event.kind)
    if (policy) return policy
    const suppressed = (message: string) => ({ code: 'DELIVERY_SUPPRESSED', message })
    const { settings } = await this.store.settings()
    if (record.event.tenantId && await this.store.tenantIsRemoved(record.event.tenantId)) {
      return suppressed('该租户已解除管理，未提交的历史通知不再投递。')
    }
    if (record.sender !== settings.senderMailbox || record.recipients.length === 0) {
      return suppressed('发件邮箱已更换或收件人配置无效，未提交的旧邮件不再投递。')
    }
    if (record.event.kind !== 'test' && (!settings.enabled ||
      record.recipients.some((item) => !settings.operationsRecipients.includes(item)))) {
      return suppressed('告警已关闭或收件人配置发生变化，未向旧收件地址投递。')
    }
    if (record.event.kind !== 'test' && record.mode === 'graph' &&
      !(await this.store.senderAuthorization(settings)).ready) {
      return suppressed('当前发件邮箱尚未通过发信权限验证，自动投递已阻止。')
    }
    try { this.store.validateRecipients(record.recipients) }
    catch (error) {
      if (!(error instanceof MailPolicyError)) throw error
      return suppressed('Outbox 中存在非允许域的收件人，投递已阻止。')
    }
    return null
  }

  private async process(id: string, signal: AbortSignal): Promise<OutboxRecord['status'] | null> {
    signal.throwIfAborted()
    const existing = await this.store.outbox(id)
    if (!existing || !existing.path.startsWith('outbox/active/')) return null
    let record = existing.value
    let etag = existing.etag
    if (terminalOutboxStatuses.has(record.status)) { await this.store.archive(record, etag); return null }
    if (record.status === 'unknown') return null
    if (record.status === 'claimed') {
      if (record.claimExpiresAtUtc && Date.parse(record.claimExpiresAtUtc) > Date.now()) return null
      if (record.submissionStartedAtUtc) {
        record = { ...record, status: 'unknown', updatedAtUtc: new Date().toISOString(), lastError: {
          code: 'EXPIRED_SUBMISSION_CLAIM', message: '提交中的 claim 已过期，结果不确定；不会自动重发。',
        } }
        await this.store.updateOutbox(record, etag)
        return 'unknown'
      }
      record = { ...record, status: 'pending', claimOwner: null, claimExpiresAtUtc: null }
    }
    if (record.nextAttemptAtUtc && Date.parse(record.nextAttemptAtUtc) > Date.now()) return null
    const suppression = await this.suppression(record)
    if (suppression) {
      record = { ...record, status: 'suppressed', updatedAtUtc: new Date().toISOString(), lastError: suppression }
      etag = await this.store.updateOutbox(record, etag); await this.store.archive(record, etag)
      return 'suppressed'
    }
    record = {
      ...record, status: 'claimed', claimOwner: randomUUID(), claimExpiresAtUtc: new Date(Date.now() + 5 * 60_000).toISOString(),
      submissionStartedAtUtc: null, updatedAtUtc: new Date().toISOString(),
    }
    etag = await this.store.updateOutbox(record, etag)
    let result: MailAttemptResult
    try {
      result = await this.sender.attempt(record, async () => {
        signal.throwIfAborted()
        const changed = await this.suppression(record)
        if (changed) throw new MailConfigurationChangedError(changed)
        record = { ...record, attempts: record.attempts + 1, submissionStartedAtUtc: new Date().toISOString() }
        etag = await this.store.updateOutbox(record, etag)
      }, signal)
    } catch (error) {
      if (!(error instanceof MailConfigurationChangedError)) throw error
      record = { ...record, status: 'suppressed', claimOwner: null, claimExpiresAtUtc: null,
        updatedAtUtc: new Date().toISOString(), lastError: error.suppression }
      etag = await this.store.updateOutbox(record, etag)
      await this.store.archive(record, etag)
      return 'suppressed'
    }
    if (record.mode === 'graph' && result.status === 'accepted' && record.event.kind === 'test') {
      await this.store.recordSenderAuthorization(record, 'accepted', result.requestId)
    } else if (record.mode === 'graph' && result.status === 'failed' && result.authorizationRejected) {
      await this.store.recordSenderAuthorization(record, 'denied', null)
    }
    record = {
      ...record, status: result.status === 'retry' ? record.attempts >= 5 ? 'failed' : 'pending' : result.status,
      updatedAtUtc: new Date().toISOString(), claimOwner: null, claimExpiresAtUtc: null,
      nextAttemptAtUtc: result.status === 'retry' ? result.retryAtUtc ?? null : null,
      submissionStartedAtUtc: result.status === 'unknown' ? record.submissionStartedAtUtc : null,
      graphRequestId: 'requestId' in result ? result.requestId : null,
      lastError: 'code' in result ? { code: result.code, message: result.message } : null,
    }
    etag = await this.store.updateOutbox(record, etag)
    if (terminalOutboxStatuses.has(record.status)) await this.store.archive(record, etag)
    return record.status
  }
}
