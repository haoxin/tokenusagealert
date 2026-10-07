import { expect, test } from '@playwright/test'
import type { MailSettingsResponse, OutboxRecord } from '@tokenusagealert/schemas'

test('editing the sender persists in JSON, closes preview notifications and uses the saved sender after reload', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '告警邮件设置', exact: true })
  const sender = panel.getByRole('textbox', { name: '发件邮箱', exact: true })
  await expect(sender).toBeEditable()
  await panel.getByLabel('统一运维收件人（每行一个）').fill('chx@ms-ext.biz')
  await panel.getByRole('checkbox', { name: '启用本地告警预览（不发邮件）', exact: true }).check()
  await panel.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('通知设置已保存')
  await sender.fill('preview-editor@ms-ext.biz')
  await expect(panel.getByRole('checkbox')).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '预览测试（不发送邮件）', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('发件邮箱已更换')
  await page.reload()
  await expect(sender).toHaveValue('preview-editor@ms-ext.biz')
  await expect(sender).toBeEditable()
  const queued = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/settings/alerting/test') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '预览测试（不发送邮件）', exact: true }).click()
  await expect((await queued).json()).resolves.toMatchObject({
    event: { sender: 'preview-editor@ms-ext.biz', mode: 'preview' },
  })
  await panel.getByRole('button', { name: '刷新测试状态', exact: true }).click()
  await expect(panel.getByText('预览完成 · 未发信', { exact: true })).toBeVisible()
  await expect(panel.getByText('测试发件邮箱：preview-editor@ms-ext.biz', { exact: true })).toBeVisible()
  await sender.fill('chx@ms-ext.biz')
  await panel.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await expect(sender).toHaveValue('chx@ms-ext.biz')
})

test('a new sender stays disabled until a mocked accepted Graph test, then explicit enablement is available', async ({ page }) => {
  let value: MailSettingsResponse = {
    settings: {
      schemaVersion: 1, revision: 1, enabled: true, senderMailbox: 'chx@ms-ext.biz',
      operationsRecipients: ['chx@ms-ext.biz'], reminderIntervalHours: 6, recoveryPolicy: 'new-complete-hour',
      updatedAtUtc: null, updatedByObjectId: null,
    },
    etag: '"one"', allowedRecipientDomains: ['ms-ext.biz'], dispatcherConfigured: true,
    mode: 'graph', authorizationReady: true, graphTestAvailable: true,
    senderAuthorizationSource: 'deployment', senderVerifiedAtUtc: null, warning: null,
  }
  const eventId = 'e'.repeat(64)
  let testRecord: OutboxRecord | null = null
  let testRequests = 0
  let externalGraphRequests = 0
  page.on('request', (request) => { if (request.url().startsWith('https://graph.microsoft.com/')) externalGraphRequests++ })
  await page.route('**/api/v1/settings/alerting', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      const changed = body.senderMailbox !== value.settings.senderMailbox
      value = {
        ...value, settings: { ...value.settings, ...body, enabled: changed ? false : body.enabled, revision: value.settings.revision + 1 },
        etag: '"updated"', authorizationReady: changed ? false : value.authorizationReady,
        senderAuthorizationSource: changed ? 'unverified' : value.senderAuthorizationSource,
        warning: changed ? '发件邮箱已更换，自动通知已关闭。请授权并测试。' : null,
      }
    }
    return route.fulfill({ json: value })
  })
  await page.route('**/api/v1/settings/alerting/test', (route) => {
    testRequests++
    const body = route.request().postDataJSON()
    expect(body).toMatchObject({ senderMailbox: 'alerts@ms-ext.biz', preview: false })
    const now = '2026-10-05T03:00:00.000Z'
    testRecord = {
      schemaVersion: 1, sender: value.settings.senderMailbox, recipients: [body.recipient], mode: 'graph',
      settingsRevision: value.settings.revision, status: 'pending', attempts: 0, updatedAtUtc: now,
      nextAttemptAtUtc: null, claimOwner: null, claimExpiresAtUtc: null, submissionStartedAtUtc: null,
      graphRequestId: null, lastError: null, resolution: null,
      event: {
        schemaVersion: 1, id: eventId, key: `test:${body.requestId}`, kind: 'test', subject: 'test',
        tenantId: null, tenantName: 'Mock sender verification', occurredAtUtc: now,
        windowStartUtc: null, windowEndUtc: null, amountUsd: null, thresholdUsd: null,
        dataStatus: 'none', issues: [], createdAtUtc: now,
      },
    }
    return route.fulfill({ status: 202, json: { event: testRecord, dispatcherRequested: true, warning: null } })
  })
  await page.route(`**/api/v1/operations/outbox/${eventId}`, (route) => {
    if (!testRecord) throw new Error('Test must be submitted first')
    testRecord = { ...testRecord, status: 'accepted', attempts: 1, graphRequestId: 'local-fixture-request' }
    value = { ...value, authorizationReady: true, senderAuthorizationSource: 'graph-test', senderVerifiedAtUtc: testRecord.updatedAtUtc }
    return route.fulfill({ json: { item: testRecord, etag: '"accepted"' } })
  })
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '告警邮件设置', exact: true })
  await panel.getByRole('textbox', { name: '发件邮箱', exact: true }).fill('alerts@ms-ext.biz')
  await panel.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await expect(panel.getByRole('checkbox', { name: '启用自动告警邮件', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: '验证发件邮箱（发送测试）', exact: true }).click()
  await panel.getByRole('button', { name: '刷新测试状态', exact: true }).click()
  await expect(panel.getByText('Graph 已接受', { exact: true })).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: '启用自动告警邮件', exact: true })).toBeEnabled()
  await panel.getByRole('checkbox', { name: '启用自动告警邮件', exact: true }).check()
  await panel.getByRole('button', { name: '保存通知设置', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('通知设置已保存')
  expect(value.settings.enabled).toBe(true)
  expect(testRequests).toBe(1)
  expect(externalGraphRequests).toBe(0)
})
