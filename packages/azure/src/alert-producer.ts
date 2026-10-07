import { alertEmailSuppression, evaluateAlertHour } from '@tokenusagealert/domain'
import { Decimal } from 'decimal.js'
import {
  AlertEventSchema, OutboxRecordSchema, type HourlyUsage, type TenantListItem, type OutboxRecord, type AlertKind,
} from '@tokenusagealert/schemas'
import { AlertConflictError, alertId, BlobAlertStore, MailPolicyError } from './alert-store.js'

export interface UsageAlertSink {
  evaluate(tenant: TenantListItem, hour: HourlyUsage): Promise<void>
  disconnected(tenant: TenantListItem, window: { windowStartUtc: string; windowEndUtc: string }): Promise<void>
}

export class AlertProducer implements UsageAlertSink {
  constructor(private readonly store: BlobAlertStore) {}
  async evaluate(tenant: TenantListItem, hour: HourlyUsage) {
    const signature = hour.status === 'complete' ? null : alertId(JSON.stringify(
      [...new Set(hour.issues.map((issue) => `${issue.code}:${issue.resourceId ?? ''}`))].sort(),
    ))
    await this.evaluateSubject(`tenant-${tenant.tenantId}`, tenant.tenantId, tenant.displayName, hour, signature)
  }
  async repriced(tenant: TenantListItem, before: HourlyUsage, after: HourlyUsage) {
    if (before.source !== 'azure-monitor' || after.source !== 'azure-monitor' || before.knownCostUsd !== null || !after.repricedAtUtc ||
      after.pricingRuleVersion !== 3 || before.inputTokens !== after.inputTokens || before.outputTokens !== after.outputTokens ||
      before.tenantId !== tenant.tenantId || after.tenantId !== tenant.tenantId ||
      before.windowStartUtc !== after.windowStartUtc || before.windowEndUtc !== after.windowEndUtc ||
      before.thresholdUsd !== after.thresholdUsd || before.priceSnapshotId !== after.priceSnapshotId) {
      throw new Error('Historical alert requires an audited missing-price repair of the same real usage hour.')
    }
    if (after.knownCostUsd === null || after.thresholdUsd === null || !new Decimal(after.knownCostUsd).gt(after.thresholdUsd)) return null
    const subject = `tenant-${tenant.tenantId}`
    return this.store.subjectLease(subject, async () => {
      const { settings } = await this.store.settings()
      const allowed = settings.enabled && settings.operationsRecipients.length > 0 &&
        settings.updatedAtUtc !== null && Date.parse(settings.updatedAtUtc) <= Date.parse(before.windowStartUtc)
      const key = `${subject}:cost-exceeded:${after.windowStartUtc}`
      const existing = await this.store.outbox(alertId(key))
      if (existing) return existing.value.event
      const now = new Date().toISOString()
      const event = AlertEventSchema.parse({
        schemaVersion: 1, id: alertId(key), key, kind: 'cost-exceeded', subject,
        tenantId: tenant.tenantId, tenantName: tenant.displayName, occurredAtUtc: after.windowEndUtc,
        windowStartUtc: after.windowStartUtc, windowEndUtc: after.windowEndUtc,
        amountUsd: after.knownCostUsd, amountUpperUsd: after.knownCostUpperUsd,
        thresholdUsd: after.thresholdUsd, dataStatus: after.status, repricedAtUtc: after.repricedAtUtc,
        ...(after.manualPriceSnapshotId ? { manualPriceSnapshotId: after.manualPriceSnapshotId } : {}),
        issues: after.issues.slice(0, 20).map((issue) => ({ code: issue.code, message: issue.message })), createdAtUtc: now,
      })
      await this.store.ensureEvent(OutboxRecordSchema.parse({
        schemaVersion: 1, event, sender: settings.senderMailbox, recipients: settings.operationsRecipients,
        mode: this.store.policy.mode, settingsRevision: settings.revision,
        status: allowed ? 'pending' : 'suppressed', attempts: 0, updatedAtUtc: now, nextAttemptAtUtc: null,
        claimOwner: null, claimExpiresAtUtc: null, submissionStartedAtUtc: null, graphRequestId: null,
        lastError: allowed ? null : { code: 'REPRICING_NOTIFICATION_POLICY',
          message: '补算仅记录历史事件；通知关闭或无法确认该小时已启用当前发件/收件设置，不补发关闭期间的邮件。' },
        resolution: null,
      }))
      return event
    })
  }
  async disconnected(tenant: TenantListItem, window: { windowStartUtc: string; windowEndUtc: string }) {
    await this.evaluateSubject(`tenant-${tenant.tenantId}`, tenant.tenantId, tenant.displayName, {
      ...window, status: 'failed', knownCostUsd: null, thresholdUsd: tenant.hourlyThresholdUsd,
      issues: [{ code: 'AUTHORIZATION_DISCONNECTED', message: '客户授权已断开，没有生成新费用；历史数据仍保留。' }],
    }, 'authorization-disconnected')
  }
  async platform(issues: Array<{ code: string; message: string }>, now = new Date()) {
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()
    await this.evaluateSubject('platform', null, '平台运行状态', {
      windowStartUtc: minute, windowEndUtc: minute, status: issues.length ? 'failed' : 'complete',
      knownCostUsd: null, thresholdUsd: null, issues,
    }, issues.length ? alertId(issues.map((issue) => issue.code).sort().join('|')) : null)
  }
  private async evaluateSubject(
    subject: string, tenantId: string | null, tenantName: string,
    hour: Pick<HourlyUsage, 'windowStartUtc' | 'windowEndUtc' | 'status' | 'knownCostUsd' | 'knownCostUpperUsd' | 'thresholdUsd' | 'manualPriceSnapshotId'> & { issues: Array<{ code: string; message: string }> },
    signature: string | null,
  ) {
    await this.store.subjectLease(subject, async () => {
      const state = await this.store.completePending(await this.store.subject(subject))
      const { settings } = await this.store.settings()
      const enabled = settings.enabled && settings.operationsRecipients.length > 0
      const decision = evaluateAlertHour(state.value.current, hour, signature, enabled)
      if (decision.next === state.value.current) return
      const events: OutboxRecord[] = decision.kinds.map((kind) => {
        const suppression = alertEmailSuppression(kind) ?? (enabled ? null : {
          code: 'ALERTING_DISABLED', message: '邮件关闭或尚无收件人，仅记录事件，未发送邮件。',
        })
        const key = `${subject}:${kind}:${hour.windowStartUtc}`
        const now = new Date().toISOString()
        const event = AlertEventSchema.parse({
          schemaVersion: 1, id: alertId(key), key, kind, subject, tenantId, tenantName,
          occurredAtUtc: hour.windowEndUtc, windowStartUtc: hour.windowStartUtc, windowEndUtc: hour.windowEndUtc,
          amountUsd: hour.knownCostUsd, thresholdUsd: hour.thresholdUsd, dataStatus: hour.status,
          ...(hour.knownCostUpperUsd !== undefined ? { amountUpperUsd: hour.knownCostUpperUsd } : {}),
          ...(hour.manualPriceSnapshotId ? { manualPriceSnapshotId: hour.manualPriceSnapshotId } : {}),
          issues: hour.issues.slice(0, 20).map((issue) => ({ code: issue.code, message: issue.message })),
          createdAtUtc: now,
        })
        return OutboxRecordSchema.parse({
          schemaVersion: 1, event, sender: settings.senderMailbox, recipients: settings.operationsRecipients,
          mode: this.store.policy.mode, settingsRevision: settings.revision, status: suppression ? 'suppressed' : 'pending',
          attempts: 0, updatedAtUtc: now, nextAttemptAtUtc: null, claimOwner: null,
          claimExpiresAtUtc: null, submissionStartedAtUtc: null, graphRequestId: null,
          lastError: suppression,
          resolution: null,
        })
      })
      const pending = await this.store.writeSubject({
        ...state.value, pending: { next: decision.next, events },
      }, state.etag)
      await this.store.completePending(pending)
    })
  }
  async test(requestId: string, recipient: string, mode: 'graph' | 'preview', expectedSenderMailbox?: string): Promise<OutboxRecord> {
    this.store.validateRecipients([recipient])
    if (mode === 'graph' && !this.store.graphTestAvailable) throw new MailPolicyError('邮件身份授权或部署绑定尚未完成，真实测试邮件被阻止。')
    const { settings } = await this.store.settings()
    if (expectedSenderMailbox && expectedSenderMailbox !== settings.senderMailbox) throw new AlertConflictError('发件邮箱已改变，请重新读取配置后测试。')
    if (![settings.senderMailbox, ...settings.operationsRecipients].includes(recipient)) throw new MailPolicyError('测试收件人必须是当前发件邮箱或已保存的运维收件人。')
    const key = `test:${requestId}`
    const existing = await this.store.outbox(alertId(key))
    if (existing) {
      if (existing.value.mode !== mode || existing.value.recipients[0] !== recipient ||
        existing.value.sender !== settings.senderMailbox) throw new AlertConflictError('测试请求 ID 已被其他参数使用。')
      return existing.value
    }
    const now = new Date().toISOString()
    const record = OutboxRecordSchema.parse({
      schemaVersion: 1, sender: settings.senderMailbox, recipients: [recipient], mode,
      settingsRevision: settings.revision, status: 'pending', attempts: 0, updatedAtUtc: now,
      nextAttemptAtUtc: null, claimOwner: null, claimExpiresAtUtc: null, submissionStartedAtUtc: null,
      graphRequestId: null, lastError: null, resolution: null,
      event: {
        schemaVersion: 1, id: alertId(key), key, kind: 'test' satisfies AlertKind, subject: 'test',
        tenantId: null, tenantName: '发信验证', occurredAtUtc: now, windowStartUtc: null, windowEndUtc: null,
        amountUsd: null, thresholdUsd: null, dataStatus: 'none', issues: [], createdAtUtc: now,
      },
    })
    await this.store.ensureEvent(record)
    return record
  }
}
