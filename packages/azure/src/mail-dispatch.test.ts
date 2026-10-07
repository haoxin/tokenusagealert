import { describe, expect, it } from 'vitest'
import { OutboxRecordSchema, type AlertEvent } from '@tokenusagealert/schemas'
import { mailMessage } from './mail-dispatch.js'

function record(event: Partial<AlertEvent> = {}) {
  return OutboxRecordSchema.parse({
    schemaVersion: 1,
    event: {
      schemaVersion: 1, id: 'a'.repeat(64), key: 'fixture-cost-alert',
      kind: 'cost-exceeded', subject: 'tenant-10000000-0000-4000-8000-000000000001',
      tenantId: '10000000-0000-4000-8000-000000000001', tenantName: '模拟客户',
      occurredAtUtc: '2026-10-06T17:00:00Z', windowStartUtc: '2026-10-06T16:00:00Z',
      windowEndUtc: '2026-10-06T17:00:00Z', amountUsd: '1.139120200000',
      amountUpperUsd: '1.856736900000', thresholdUsd: '1.00', dataStatus: 'complete',
      issues: [], createdAtUtc: '2026-10-06T17:15:00Z', ...event,
    },
    sender: 'chx@ms-ext.biz', recipients: ['chx@ms-ext.biz'], mode: 'preview', settingsRevision: 2,
    status: 'pending', attempts: 0, updatedAtUtc: '2026-10-06T17:15:00Z', nextAttemptAtUtc: null,
    claimOwner: null, claimExpiresAtUtc: null, submissionStartedAtUtc: null,
    graphRequestId: null, lastError: null, resolution: null,
  })
}

describe('clear cost-alert email amounts', () => {
  it.each(['cost-exceeded', 'cost-reminder'] as const)('includes the estimate in the subject and summary of %s', (kind) => {
    const message = mailMessage(record({ kind }), 'https://app.example.test/')
    expect(message.subject).toContain('USD 1.13912–1.856737')
    expect(message.body.content).toContain(
      '租户：模拟客户\n估算费用：USD 1.13912–1.856737\n小时阈值：USD 1.00',
    )
    expect(message.body.content).toContain('北京时间窗口：2026/10/07 00:00 至 2026/10/07 01:00')
    expect(message.body.content).toContain('数据状态：完整')
    expect(message.body.content).toContain('不是 Azure 实际账单')
    expect(message.body.content).toContain('估算区间不是额外消费')
    expect(message.body.content).not.toContain('恢复')
    expect(message.body.content).not.toContain('1.139120200000')
    expect(message.body.content).toContain('/tenants/10000000-0000-4000-8000-000000000001/usage')
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'chx@ms-ext.biz' } }])
  })

  it('labels partial amounts as known subtotals, not complete tenant costs', () => {
    const message = mailMessage(record({ dataStatus: 'partial' }), 'https://app.example.test')
    expect(message.body.content).toContain('已知估算小计（部分数据）：USD 1.13912–1.856737')
    expect(message.body.content).toContain('数据状态：部分数据（存在缺失）')
  })

  it('keeps an unknown upper bound explicit', () => {
    const message = mailMessage(record({ amountUpperUsd: null }), 'https://app.example.test')
    expect(message.subject).toContain('USD 1.13912 起（完整上限未知）')
    expect(message.body.content).toContain('估算费用：USD 1.13912 起（完整上限未知）')
  })

  it.each([undefined, '20.000000000000'])('formats legacy or equal bounds as one estimate (%s)', (amountUpperUsd) => {
    const message = mailMessage(record({ amountUsd: '20', amountUpperUsd }), 'https://app.example.test')
    expect(message.body.content).toContain('估算费用：USD 20.00')
    expect(message.body.content).not.toContain('20.00–')
    expect(message.body.content).not.toContain('区间说明')
  })

  it('never formats a missing amount as zero', () => {
    const message = mailMessage(record({
      kind: 'data-quality', dataStatus: 'failed', amountUsd: null, amountUpperUsd: null, thresholdUsd: null,
    }), 'https://app.example.test')
    expect(message.body.content).toContain('估算费用：—')
    expect(message.body.content).toContain('数据状态：采集失败')
    expect(message.body.content).not.toContain('USD 0')
  })

  it('does not round a positive sub-micro-dollar estimate to zero', () => {
    const message = mailMessage(record({
      kind: 'data-quality', amountUsd: '0.000000000001', amountUpperUsd: '0.000000000001',
    }), 'https://app.example.test')
    expect(message.body.content).toContain('估算费用：USD <0.000001')
  })

  it('preserves historical and manual-price provenance without changing the recorded amounts', () => {
    const value = record({
      manualPriceSnapshotId: '20000000-0000-4000-8000-000000000001',
      repricedAtUtc: '2026-10-06T18:00:00Z',
      issues: [{ code: 'MISSING_SUBSCRIPTION', message: '模拟缺失订阅' }],
    })
    const message = mailMessage(value, 'https://app.example.test')
    expect(message.subject).toContain('历史补算')
    expect(message.body.content).toContain('不是当前小时超限')
    expect(message.body.content).toContain('手动单价仅用于缺价备用')
    expect(message.body.content).not.toContain('费用包含手动补充单价')
    expect(message.body.content).toContain('手动价格快照引用：20000000-0000-4000-8000-000000000001')
    expect(message.body.content).toContain('数据问题：\n- MISSING_SUBSCRIPTION：模拟缺失订阅')
    expect(value.event.amountUsd).toBe('1.139120200000')
    expect(value.event.amountUpperUsd).toBe('1.856736900000')
  })
})
