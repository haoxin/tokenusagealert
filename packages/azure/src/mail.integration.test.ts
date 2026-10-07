import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it, vi } from 'vitest'
import { HourlyUsageSchema, type TenantListItem } from '@tokenusagealert/schemas'
import { AlertProducer } from './alert-producer.js'
import { alertId, BlobAlertStore, type MailPolicy } from './alert-store.js'
import { GraphMailSender, MailDispatcher, mailMessage } from './mail-dispatch.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
async function fixture(policy: Partial<MailPolicy> = {}) {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { configuration: `mail-config-${suffix}`, operations: `mail-ops-${suffix}` }
  const store = new BlobAlertStore(client, {
    senderMailbox: 'chx@ms-ext.biz', allowedRecipientDomains: ['ms-ext.biz'],
    mode: 'preview', authorizationReady: false,
    ...policy,
  }, names)
  await store.initialize(true)
  const { etag: _etag, ...tenantDocument } = tenant
  await client.getContainerClient(names.configuration).getBlockBlobClient(`tenants/${tenant.tenantId}.json`)
    .uploadData(Buffer.from(JSON.stringify(tenantDocument)), { conditions: { ifNoneMatch: '*' } })
  return { store, names, producer: new AlertProducer(store),
    cleanup: async () => { await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete())) } }
}
const tenant: TenantListItem = {
  schemaVersion: 1, revision: 1, tenantId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Fixture customer', status: 'active', authorizationSource: 'lighthouse-template',
  hourlyThresholdUsd: '10', notes: '', createdByName: 'fixture', createdByObjectId: 'fixture',
  createdAtUtc: '2026-10-04T00:00:00.000Z', updatedAtUtc: '2026-10-04T00:00:00.000Z', deletedAtUtc: null, etag: '"fixture"',
}
const hour = HourlyUsageSchema.parse({
  schemaVersion: 1, tenantId: tenant.tenantId, windowStartUtc: '2026-10-04T00:00:00.000Z',
  windowEndUtc: '2026-10-04T01:00:00.000Z', collectedAtUtc: '2026-10-04T01:15:00.000Z',
  source: 'fixture', status: 'complete', activity: 'hasUsage', finality: 'provisional',
  estimatedCostUsd: '20', knownCostUsd: '20', thresholdUsd: '10', inputTokens: '1000', outputTokens: '100',
  priceSnapshotId: null, estimatePolicy: 'cached-input-at-standard-rate', pricingRuleVersion: 1,
  validation: 'awaiting-positive-usage-verification',
  coverage: { expectedSubscriptions: 1, successfulSubscriptions: 1, accounts: 1, expectedDeployments: 1, successfulDeployments: 1, pricedDeployments: 1 },
  breakdown: [], issues: [],
})

describe('durable alert and Outbox workflow', () => {
  it('notifies a newly priced historical breach once with an explicit historical label, without regressing the current alert state', async () => {
    const f = await fixture()
    try {
      const saved = await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'fixture')
      await client.getContainerClient(f.names.configuration).getBlockBlobClient('alerting.json').uploadData(
        Buffer.from(JSON.stringify({ ...saved.settings, updatedAtUtc: '2026-10-03T00:00:00.000Z' })),
        { conditions: { ifMatch: saved.etag } },
      )
      await f.producer.evaluate(tenant, { ...hour, knownCostUsd: '0', estimatedCostUsd: '0' })
      const state = await f.store.subject(`tenant-${tenant.tenantId}`)
      const before = { ...hour, source: 'azure-monitor' as const, knownCostUsd: null, estimatedCostUsd: null }
      const after = { ...before, knownCostUsd: '20', knownCostUpperUsd: '30', pricingRuleVersion: 3 as const,
        repricedAtUtc: new Date().toISOString() }
      const event = await f.producer.repriced(tenant, before, after)
      expect(event).toMatchObject({ kind: 'cost-exceeded', amountUsd: '20', amountUpperUsd: '30', windowStartUtc: before.windowStartUtc })
      expect(await f.producer.repriced(tenant, before, after)).toEqual(event)
      expect(await f.store.subject(`tenant-${tenant.tenantId}`)).toEqual(state)
      const outbox = (await f.store.listOutbox(20)).items.find((item) => item.event.id === event!.id)!
      expect(outbox.status).toBe('pending')
      const message = mailMessage(outbox, 'http://localhost:5173')
      expect(message.subject).toContain('历史补算')
      expect(message.body.content).toContain('不是当前小时超限')
      expect(message.body.content).toContain('估算费用：USD 20.00–30.00')
      expect(message.body.content).toContain('估算区间不是额外消费')
    } finally { await f.cleanup() }
  })

  it('suppresses historical repricing mail if notifications were enabled only after that hour, and rejects any changed token counts', async () => {
    const f = await fixture()
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'fixture')
      const before = { ...hour, source: 'azure-monitor' as const, knownCostUsd: null, estimatedCostUsd: null }
      const after = { ...before, knownCostUsd: '20', knownCostUpperUsd: '30', pricingRuleVersion: 3 as const,
        repricedAtUtc: new Date().toISOString() }
      const event = await f.producer.repriced(tenant, before, after)
      expect((await f.store.outbox(event!.id))?.value).toMatchObject({ status: 'suppressed',
        lastError: { code: 'REPRICING_NOTIFICATION_POLICY' } })
      await expect(f.producer.repriced(tenant, before, { ...after, inputTokens: '999999' })).rejects.toThrow(/same real usage hour/)
    } finally { await f.cleanup() }
  })

  it('preserves a manual-price snapshot reference and explains its official-first fallback policy without mislabelling legacy estimates', async () => {
    const f = await fixture()
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'fixture')
      const snapshotId = randomUUID()
      await f.producer.evaluate(tenant, { ...hour, manualPriceSnapshotId: snapshotId })
      const event = (await f.store.listOutbox(20)).items.find((item) => item.event.kind === 'cost-exceeded')!
      expect(event.event.manualPriceSnapshotId).toBe(snapshotId)
      const rendered = mailMessage(event, 'http://localhost:5173').body.content
      expect(rendered).toContain('手动单价仅用于缺价备用')
      expect(rendered).not.toContain('费用包含手动补充单价')
      expect(rendered).toContain('不区分上下文档位')
      expect(rendered).toContain(snapshotId)
      expect(rendered).toContain('不是 Azure 实际账单')
    } finally { await f.cleanup() }
  })

  const graphPolicy: Partial<MailPolicy> = {
    mode: 'graph', authorizationReady: true,
    authorizationIdentityId: '20000000-0000-4000-8000-000000000001',
  }
  const credential = { async getToken() { return { token: 'local-fixture-not-a-real-token' } } }
  const newSender = 'alerts@ms-ext.biz'

  it('records cost recovery without email, and sends a later breach as a new alert', async () => {
    const f = await fixture(graphPolicy)
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await f.producer.evaluate(tenant, hour)
      const recovery = { ...hour, windowStartUtc: '2026-10-04T01:00:00.000Z',
        windowEndUtc: '2026-10-04T02:00:00.000Z', knownCostUsd: '0', knownCostUpperUsd: '0' }
      await f.producer.evaluate(tenant, recovery)
      const recovered = (await f.store.listOutbox(20)).items.find((item) => item.event.kind === 'cost-recovered')!
      expect(recovered).toMatchObject({
        status: 'suppressed', attempts: 0, lastError: { code: 'COST_RECOVERY_EMAIL_DISABLED' },
      })
      expect((await f.store.subject(`tenant-${tenant.tenantId}`)).value.current.costState).toBe('normal')
      expect((await f.store.timeline(`tenant-${tenant.tenantId}`)).some((event) => event.kind === 'cost-recovered')).toBe(true)
      await f.producer.evaluate(tenant, { ...hour, windowStartUtc: '2026-10-04T02:00:00.000Z',
        windowEndUtc: '2026-10-04T03:00:00.000Z' })
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }))
      const run = await new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      })).run()
      expect(run.accepted).toBe(2)
      expect(fetcher).toHaveBeenCalledTimes(2)
      for (const [, request] of fetcher.mock.calls) {
        const message = JSON.parse(String(request?.body)).message
        expect(message.subject).toContain('估算费用超限')
        expect(message.subject).toContain('USD 20.00')
        expect(message.body.content).toContain('估算费用：USD 20.00')
        expect(message.body.content).not.toContain('恢复')
      }
    } finally { await f.cleanup() }
  })

  it.each([
    { status: 'pending' as const, started: false, expected: 'suppressed' },
    { status: 'claimed' as const, started: false, expected: 'suppressed' },
    { status: 'claimed' as const, started: true, expected: 'unknown' },
    { status: 'unknown' as const, started: true, expected: 'unknown' },
  ])('does not send legacy recovery records in $status state (submission started: $started)', async ({ status, started, expected }) => {
    const f = await fixture(graphPolicy)
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      const base = await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'preview')
      const key = `tenant-${tenant.tenantId}:cost-recovered:2026-10-04T01:00:00.000Z`
      const id = alertId(key)
      await f.store.ensureEvent({
        ...base, mode: 'graph', status, attempts: started ? 1 : 0,
        claimOwner: status === 'claimed' ? randomUUID() : null,
        claimExpiresAtUtc: status === 'claimed' ? '2020-01-01T00:00:00Z' : null,
        submissionStartedAtUtc: started ? '2020-01-01T00:00:00Z' : null,
        event: { ...base.event, id, key, kind: 'cost-recovered', tenantId: tenant.tenantId,
          subject: `tenant-${tenant.tenantId}`, amountUsd: '0', amountUpperUsd: '0', thresholdUsd: '10',
          dataStatus: 'complete', windowStartUtc: '2026-10-04T01:00:00.000Z', windowEndUtc: '2026-10-04T02:00:00.000Z' },
      })
      const fetcher = vi.fn<typeof fetch>()
      const dispatcher = new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      }))
      await dispatcher.run()
      await dispatcher.run()
      expect(fetcher).not.toHaveBeenCalled()
      const stored = (await f.store.outbox(id))!
      expect(stored.value.status).toBe(expected)
      expect(stored.value.attempts).toBe(started ? 1 : 0)
      if (expected === 'suppressed') {
        expect(stored.path).toContain('outbox/archive/')
        expect(stored.value.lastError?.code).toBe('COST_RECOVERY_EMAIL_DISABLED')
      } else {
        expect(stored.path).toContain('outbox/active/')
      }
    } finally { await f.cleanup() }
  })

  it('continues to send data-quality recovery notifications', async () => {
    const f = await fixture(graphPolicy)
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await f.producer.evaluate(tenant, { ...hour, status: 'partial', knownCostUsd: '1',
        issues: [{ code: 'MISSING_SUBSCRIPTION', message: '模拟缺失订阅' }] })
      await f.producer.evaluate(tenant, { ...hour, windowStartUtc: '2026-10-04T01:00:00.000Z',
        windowEndUtc: '2026-10-04T02:00:00.000Z', knownCostUsd: '0', knownCostUpperUsd: '0' })
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }))
      const run = await new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      })).run()
      expect(run.accepted).toBe(2)
      const subjects = fetcher.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).message.subject)
      expect(subjects.some((subject) => subject.includes('数据质量已恢复'))).toBe(true)
    } finally { await f.cleanup() }
  })

  it('persists an editable sender, closes notifications and suppresses unsubmitted mail from the old sender', async () => {
    const f = await fixture(graphPolicy)
    try {
      const original = await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await f.producer.evaluate(tenant, hour)
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')
      const changed = await f.store.saveSettings({
        senderMailbox: ' ALERTS@MS-EXT.BIZ ', enabled: true, operationsRecipients: ['chx@ms-ext.biz'],
      }, original.etag, 'actor')
      expect(changed.settings).toMatchObject({ senderMailbox: newSender, enabled: false })
      expect(changed.senderChanged).toBe(true)
      expect((await f.store.settings()).settings.senderMailbox).toBe(newSender)
      await expect(f.store.saveSettings({
        senderMailbox: newSender, enabled: true, operationsRecipients: ['chx@ms-ext.biz'],
      }, changed.etag, 'actor')).rejects.toThrow(/发信权限验证/)
      const fetcher = vi.fn<typeof fetch>()
      const run = await new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      })).run()
      expect(run.suppressed).toBe(2)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('uses the saved sender for a real-mode mocked test, binds successful verification to the mail identity and then permits enablement', async () => {
    const f = await fixture(graphPolicy)
    try {
      const changed = await f.store.saveSettings({
        senderMailbox: newSender, enabled: false, operationsRecipients: ['chx@ms-ext.biz'],
      }, null, 'actor')
      const event = await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph', newSender)
      expect(event.sender).toBe(newSender)
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202, headers: { 'request-id': 'fixture-new-sender' } }))
      const dispatcher = new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      }))
      expect((await dispatcher.run()).accepted).toBe(1)
      expect(fetcher.mock.calls[0]?.[0]).toBe(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(newSender)}/sendMail`)
      expect(await f.store.senderAuthorization(changed.settings)).toMatchObject({ ready: true, source: 'graph-test' })
      const enabled = await f.store.saveSettings({
        senderMailbox: newSender, enabled: true, operationsRecipients: ['chx@ms-ext.biz'],
      }, changed.etag, 'actor')
      expect(enabled.settings.enabled).toBe(true)
      await f.producer.evaluate(tenant, hour)
      expect((await f.store.listOutbox(20)).items.find((item) => item.event.kind === 'cost-exceeded')?.sender).toBe(newSender)
      expect((await dispatcher.run()).accepted).toBe(1)
      const otherIdentity = new BlobAlertStore(client, {
        ...f.store.policy, authorizationIdentityId: '20000000-0000-4000-8000-000000000002',
      }, f.names)
      expect((await otherIdentity.senderAuthorization(enabled.settings)).ready).toBe(false)
    } finally { await f.cleanup() }
  })

  it('never treats preview or uncertain submission as permission verification for a changed sender', async () => {
    const f = await fixture(graphPolicy)
    try {
      const changed = await f.store.saveSettings({
        senderMailbox: newSender, enabled: false, operationsRecipients: ['chx@ms-ext.biz'],
      }, null, 'actor')
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'preview')
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Network result unknown'))
      const dispatcher = new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      }))
      expect((await dispatcher.run()).previewed).toBe(1)
      expect(fetcher).not.toHaveBeenCalled()
      expect((await f.store.senderAuthorization(changed.settings)).ready).toBe(false)
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')
      expect((await dispatcher.run()).unknown).toBe(1)
      expect((await f.store.senderAuthorization(changed.settings)).ready).toBe(false)
      await dispatcher.run()
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })

  it('reflects Graph authorization rejection even after an earlier successful sender test', async () => {
    const f = await fixture(graphPolicy)
    try {
      const changed = await f.store.saveSettings({
        senderMailbox: newSender, enabled: false, operationsRecipients: ['chx@ms-ext.biz'],
      }, null, 'actor')
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(new Response('{"error":{"code":"ErrorAccessDenied","message":"Mailbox permission revoked"}}', { status: 403 }))
      const dispatcher = new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential,
      }))
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')
      await dispatcher.run()
      expect((await f.store.senderAuthorization(changed.settings)).ready).toBe(true)
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')
      expect((await dispatcher.run()).failed).toBe(1)
      expect((await f.store.senderAuthorization(changed.settings)).ready).toBe(false)
    } finally { await f.cleanup() }
  })

  it('rechecks sender configuration immediately before submission and does not send after an intervening edit', async () => {
    const f = await fixture(graphPolicy)
    try {
      const saved = await f.store.saveSettings({ enabled: false, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')
      const changingCredential = {
        async getToken() {
          await f.store.saveSettings({ senderMailbox: newSender, enabled: false, operationsRecipients: ['chx@ms-ext.biz'] }, saved.etag, 'another-actor')
          return { token: 'local-fixture-not-a-real-token' }
        },
      }
      const fetcher = vi.fn<typeof fetch>()
      const run = await new MailDispatcher(f.store, new GraphMailSender({
        authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential: changingCredential,
      })).run()
      expect(run.suppressed).toBe(1)
      expect(fetcher).not.toHaveBeenCalled()
      expect((await f.store.listOutbox(20)).items[0]).toMatchObject({ attempts: 0, status: 'suppressed' })
    } finally { await f.cleanup() }
  })

  it('protects stale updates, invalid addresses and test request reuse across sender changes', async () => {
    const f = await fixture(graphPolicy)
    try {
      const requestId = randomUUID()
      await f.producer.test(requestId, 'chx@ms-ext.biz', 'graph')
      const saved = await f.store.saveSettings({
        senderMailbox: newSender, enabled: false, operationsRecipients: ['chx@ms-ext.biz'],
      }, null, 'actor')
      await expect(f.producer.test(requestId, 'chx@ms-ext.biz', 'graph')).rejects.toThrow(/其他参数/)
      await expect(f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph', 'chx@ms-ext.biz')).rejects.toThrow(/发件邮箱已改变/)
      await expect(f.store.saveSettings({
        senderMailbox: 'not-an-email', enabled: false, operationsRecipients: [],
      }, saved.etag, 'actor')).rejects.toThrow()
      await expect(f.store.saveSettings({
        senderMailbox: 'another@ms-ext.biz', enabled: false, operationsRecipients: [],
      }, null, 'actor')).rejects.toThrow(/changed/)
      expect((await f.store.settings()).settings.senderMailbox).toBe(newSender)
    } finally { await f.cleanup() }
  })

  it('suppresses pending notifications when tenant management has ended', async () => {
    const f = await fixture()
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await f.producer.evaluate(tenant, hour)
      vi.spyOn(f.store, 'tenantIsRemoved').mockResolvedValue(true)
      const sender = { attempt: vi.fn(async () => ({ status: 'previewed' as const, requestId: null })) }
      const run = await new MailDispatcher(f.store, sender).run()
      expect(run.suppressed).toBe(1)
      expect(sender.attempt).not.toHaveBeenCalled()
      expect((await f.store.listOutbox(20)).items[0]?.status).toBe('suppressed')
    } finally { await f.cleanup() }
  })
  it('keeps disabled events suppressed and validates recipient domains and ETags', async () => {
    const f = await fixture()
    try {
      expect((await f.store.settings()).settings.enabled).toBe(false)
      await f.producer.evaluate(tenant, hour)
      await f.producer.evaluate(tenant, hour)
      const items = await f.store.listOutbox(20)
      expect(items.items).toHaveLength(1)
      expect(items.items[0]?.status).toBe('suppressed')
      await expect(f.store.saveSettings({ enabled: true, operationsRecipients: ['outside@example.com'] }, null, 'actor')).rejects.toThrow(/not allowed/)
      const saved = await f.store.saveSettings({ enabled: false, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      await expect(f.store.saveSettings({ enabled: false, operationsRecipients: [] }, null, 'actor')).rejects.toThrow(/changed/)
      expect(saved.settings.revision).toBe(1)
    } finally { await f.cleanup() }
  })
  it('repairs a crash after the Outbox was written but before state advanced, without duplicate mail', async () => {
    const f = await fixture()
    try {
      await f.store.saveSettings({ enabled: true, operationsRecipients: ['chx@ms-ext.biz'] }, null, 'actor')
      const original = f.store.writeSubject.bind(f.store)
      let calls = 0
      const spy = vi.spyOn(f.store, 'writeSubject').mockImplementation(async (...args) => {
        calls += 1
        if (calls === 2) throw new Error('simulated crash before state commit')
        return original(...args)
      })
      await expect(f.producer.evaluate(tenant, hour)).rejects.toThrow('simulated crash')
      spy.mockRestore()
      await f.store.reconcilePending()
      await f.producer.evaluate(tenant, hour)
      expect((await f.store.listOutbox(20)).items).toHaveLength(1)
      const sender = { attempt: vi.fn(async () => ({ status: 'previewed' as const, requestId: null })) }
      const dispatcher = new MailDispatcher(f.store, sender)
      expect((await dispatcher.run()).previewed).toBe(1)
      await dispatcher.run()
      expect(sender.attempt).toHaveBeenCalledTimes(1)
      expect((await f.store.listOutbox(20)).items[0]?.status).toBe('previewed')
    } finally { await f.cleanup() }
  })
  it('requeues expired pre-submission claims but never retries a started/unknown submission', async () => {
    const f = await fixture()
    try {
      const before = await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'preview')
      const claim = (await f.store.outbox(before.event.id))!
      await f.store.updateOutbox({
        ...claim.value, status: 'claimed', claimOwner: randomUUID(), claimExpiresAtUtc: '2020-01-01T00:00:00Z',
      }, claim.etag)
      const sender = { attempt: vi.fn(async () => ({ status: 'previewed' as const, requestId: null })) }
      const dispatcher = new MailDispatcher(f.store, sender)
      expect((await dispatcher.run()).previewed).toBe(1)
      const after = await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'preview')
      const inFlight = (await f.store.outbox(after.event.id))!
      await f.store.updateOutbox({
        ...inFlight.value, status: 'claimed', claimOwner: randomUUID(), claimExpiresAtUtc: '2020-01-01T00:00:00Z',
        submissionStartedAtUtc: '2020-01-01T00:00:00Z',
      }, inFlight.etag)
      expect((await dispatcher.run()).unknown).toBe(1)
      await dispatcher.run()
      expect(sender.attempt).toHaveBeenCalledTimes(1)
      const unknown = (await f.store.outbox(after.event.id))!
      expect(unknown.value.status).toBe('unknown')
      await f.store.resolve(after.event.id, unknown.etag, 'close', '已核对消息跟踪，不再投递', 'actor')
      expect((await f.store.outbox(after.event.id))?.value.status).toBe('closed')
    } finally { await f.cleanup() }
  })
  it('persists a preview test, never calls Graph, and uses the request ID for deduplication', async () => {
    const f = await fixture()
    try {
      const id = randomUUID()
      const event = await f.producer.test(id, 'chx@ms-ext.biz', 'preview')
      expect((await f.producer.test(id, 'chx@ms-ext.biz', 'preview')).event.id).toBe(event.event.id)
      await expect(f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'graph')).rejects.toThrow(/授权/)
      const fetcher = vi.fn<typeof fetch>()
      const sender = new GraphMailSender({ authorizationReady: false, publicUrl: 'https://app.example.test', fetcher })
      expect((await new MailDispatcher(f.store, sender).run()).previewed).toBe(1)
      expect(fetcher).not.toHaveBeenCalled()
      expect((await f.store.outbox(event.event.id))?.value.status).toBe('previewed')
    } finally { await f.cleanup() }
  })
  it('distinguishes Graph acceptance, retryable HTTP errors and uncertain network results', async () => {
    const f = await fixture()
    try {
      const base = await f.producer.test(randomUUID(), 'chx@ms-ext.biz', 'preview')
      const record = { ...base, mode: 'graph' as const }
      const before = vi.fn(async () => {})
      const credential = { async getToken() { return { token: 'local-fixture-token' } } }
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'request-id': 'fixture-request' } }))
      const sender = new GraphMailSender({ authorizationReady: true, publicUrl: 'https://app.example.test', fetcher, credential })
      expect(await sender.attempt(record, before, AbortSignal.timeout(1000))).toEqual({ status: 'accepted', requestId: 'fixture-request' })
      expect(before).toHaveBeenCalledTimes(1)
      fetcher.mockResolvedValueOnce(new Response('{"error":{"code":"TooManyRequests","message":"retry"}}', { status: 429, headers: { 'retry-after': '60' } }))
      expect((await sender.attempt(record, before, AbortSignal.timeout(1000))).status).toBe('retry')
      fetcher.mockRejectedValueOnce(new TypeError('connection reset after submission'))
      expect((await sender.attempt(record, before, AbortSignal.timeout(1000))).status).toBe('unknown')
      const forbidden = new GraphMailSender({ authorizationReady: false, publicUrl: 'https://app.example.test', fetcher, credential })
      expect((await forbidden.attempt(record, before, AbortSignal.timeout(1000))).status).toBe('failed')
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { await f.cleanup() }
  })
})
