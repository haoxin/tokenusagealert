import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import type { TenantListItem } from '@tokenusagealert/schemas'

const id = '92078590-b3a5-4c46-aaea-74360df451d0'

test('managed tenants can edit name and limit, reload them and preserve historical-hour thresholds', async ({ page }) => {
  test.setTimeout(60_000)
  expect((await page.request.post('/api/v1/authorization/sync')).status()).toBe(202)
  const current = (await (await page.request.get(`/api/v1/tenants/${id}`)).json()).tenant
  const originalName = `管理中编辑 ${randomUUID().slice(0, 6)}`
  const activated = await page.request.post(`/api/v1/tenants/${id}/enable`, {
    data: { displayName: originalName, hourlyThresholdUsd: '10.00', etag: current.etag },
  })
  expect(activated.status()).toBe(200)
  expect((await page.request.post('/api/v1/usage/collect', { data: {} })).status()).toBe(202)
  await page.goto('/')
  const row = page.locator('tbody tr').filter({ hasText: id })
  await row.getByRole('button', { name: `编辑 ${originalName} 名称与限额`, exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑租户名称与限额', exact: true })
  await expect(editor).toContainText('不改写历史小时阈值')
  await editor.getByRole('textbox', { name: '租户名称', exact: true }).fill('取消的名称')
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await expect(row).toContainText(originalName)
  await row.getByRole('button', { name: `编辑 ${originalName} 名称与限额`, exact: true }).click()
  const newName = `修改后 ${randomUUID().slice(0, 6)}`
  await editor.getByRole('textbox', { name: '租户名称', exact: true }).fill(newName)
  await editor.getByRole('textbox', { name: '小时费用限额（USD）', exact: true }).fill('25.50')
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(row).toContainText(newName)
  await expect(row).toContainText('US$25.50')
  await expect(row).toContainText('活动')
  await page.reload()
  await expect(row).toContainText(newName)
  await page.goto('/overview')
  await expect(page.locator('tbody tr').filter({ hasText: newName })).toContainText('US$25.50')
  await page.goto(`/tenants/${id}/usage`)
  await expect(page.getByRole('heading', { name: newName, exact: true })).toBeVisible()
  await expect(page.locator('.usage-summary-grid')).toContainText('US$25.50')
  await expect(page.locator('.usage-basis')).toContainText('该小时采集阈值')
  await expect(page.locator('.usage-basis')).toContainText('US$10.00')
  await page.getByRole('button', { name: '编辑名称与限额', exact: true }).click()
  await editor.getByRole('textbox', { name: '小时费用限额（USD）', exact: true }).fill('30.00')
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.locator('.usage-summary-grid')).toContainText('US$30.00')
  await expect(page.locator('.usage-basis')).toContainText('US$10.00')
})

const fixture: TenantListItem = {
  schemaVersion: 1, revision: 1, tenantId: '11111111-1111-4111-8111-111111111111',
  displayName: '并发编辑客户', hourlyThresholdUsd: '10.00', status: 'active', authorizationSource: 'lighthouse-template',
  notes: '', createdByObjectId: 'fixture', createdByName: 'operator@ms-ext.biz', deletedAtUtc: null,
  createdAtUtc: '2026-10-05T00:00:00.000Z', updatedAtUtc: '2026-10-05T00:00:00.000Z', etag: '"one"',
}
async function mockTenants(page: Page, read: () => TenantListItem) {
  await page.route(/\/api\/v1\/tenants(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [read()], count: 1 } }))
  await page.route('**/api/v1/authorization/runs/latest', (route) => route.fulfill({ json: { run: null } }))
}

test('stale edits stay visible and require a fresh configuration instead of overwriting another operator', async ({ page }) => {
  let tenant = fixture
  await mockTenants(page, () => tenant)
  await page.route(`**/api/v1/tenants/${fixture.tenantId}`, (route) => {
    expect(route.request().method()).toBe('PATCH')
    expect(route.request().headers()['if-match']).toBe('"one"')
    tenant = { ...fixture, displayName: '其他人员已修改', hourlyThresholdUsd: '99.00', etag: '"two"' }
    return route.fulfill({ status: 412, contentType: 'application/problem+json', json: {
      type: 'about:blank', title: 'Tenant changed', status: 412, code: 'TENANT_ETAG_MISMATCH',
      detail: '租户配置或授权状态已变化，请刷新核对后再修改。',
      instance: `/api/v1/tenants/${fixture.tenantId}`, correlationId: 'edit-e2e',
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: `编辑 ${fixture.displayName} 名称与限额`, exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑租户名称与限额', exact: true })
  await editor.getByRole('textbox', { name: '小时费用限额（USD）', exact: true }).fill('20.00')
  await editor.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('TENANT_ETAG_MISMATCH')
  await expect(editor.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled()
  await editor.getByRole('button', { name: '刷新核对配置', exact: true }).click()
  await expect(page.locator('tbody tr')).toContainText('其他人员已修改')
  await expect(page.locator('tbody tr')).toContainText('US$99.00')
})

test('archived tenants do not offer configuration editing', async ({ page }) => {
  await mockTenants(page, () => ({ ...fixture, status: 'deleted' }))
  await page.goto('/')
  await page.getByRole('tab', { name: '已解除管理 (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: /编辑.*名称与限额/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新登记', exact: true })).toBeVisible()
})
