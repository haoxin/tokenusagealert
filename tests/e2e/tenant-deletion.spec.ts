import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import type { TenantListItem } from '@tokenusagealert/schemas'

const pending: TenantListItem = {
  schemaVersion: 1, revision: 1, tenantId: '11111111-1111-4111-8111-111111111111',
  displayName: '待授权登记', status: 'pendingAuthorization', authorizationSource: 'manual-preregistration',
  hourlyThresholdUsd: '10.00', notes: '', createdByObjectId: 'fixture', createdByName: 'operator@ms-ext.biz',
  createdAtUtc: '2026-10-05T00:00:00.000Z', updatedAtUtc: '2026-10-05T00:00:00.000Z',
  deletedAtUtc: null, etag: '"pending-one"',
}

async function mockTenants(page: Page, items: () => TenantListItem[]) {
  await page.route('**/api/v1/session', (route) => route.fulfill({
    json: { objectId: 'fixture', name: 'local.operator@ms-ext.biz', authMode: 'development' },
  }))
  await page.route(/\/api\/v1\/tenants(?:\?.*)?$/, (route) => route.fulfill({
    json: { items: items(), count: items().length },
  }))
  await page.route('**/api/v1/authorization/runs/latest', (route) => route.fulfill({ json: { run: null } }))
}

test('cancel is harmless, confirmed deletion removes the JSON and re-registration works', async ({ page }) => {
  const tenantId = randomUUID()
  const displayName = `E2E 删除 ${tenantId.slice(0, 6)}`
  let deleteRequests = 0
  page.on('request', (request) => { if (request.method() === 'DELETE') deleteRequests += 1 })
  await page.goto('/')
  await page.getByRole('button', { name: '预登记租户', exact: true }).click()
  await page.getByLabel('客户租户名称').fill(displayName)
  await page.getByRole('dialog', { name: '预登记客户租户' }).getByRole('textbox', { name: 'Tenant ID', exact: true }).fill(tenantId)
  await page.getByLabel('小时预警金额（USD）').fill('12.50')
  await page.getByRole('button', { name: '保存到 Blob', exact: true }).click()
  const row = page.locator('tbody tr').filter({ hasText: tenantId })
  await expect(row).toContainText('等待客户授权')
  await row.getByRole('button', { name: `删除 ${displayName} 登记`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除租户预登记' })
  await expect(dialog).toContainText(tenantId)
  await expect(dialog).toContainText('直接删除该租户的配置 JSON')
  await expect(dialog).toContainText('后续授权同步仍会重新发现该租户')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(row).toBeVisible()
  expect(deleteRequests).toBe(0)

  await row.getByRole('button', { name: `删除 ${displayName} 登记`, exact: true }).click()
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'DELETE' && response.url().endsWith(`/api/v1/tenants/${tenantId}`))
  await dialog.getByRole('button', { name: '确认删除登记', exact: true }).click()
  expect((await responsePromise).status()).toBe(200)
  await expect(page.getByRole('status').filter({ hasText: `${displayName} 的预登记已删除。` })).toBeVisible()
  await expect(row).toHaveCount(0)
  expect(deleteRequests).toBe(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: '租户与授权', exact: true })).toBeVisible()
  await expect(row).toHaveCount(0)
  const listed = await page.request.get('/api/v1/tenants?includeRemoved=true')
  expect(listed.status()).toBe(200)
  expect(await listed.json()).toMatchObject({
    items: expect.not.arrayContaining([expect.objectContaining({ tenantId })]),
  })
  expect((await page.request.get(`/api/v1/tenants/${tenantId}`)).status()).toBe(404)

  await page.getByRole('button', { name: '预登记租户', exact: true }).click()
  await page.getByLabel('客户租户名称').fill(displayName)
  await page.getByRole('dialog', { name: '预登记客户租户' }).getByRole('textbox', { name: 'Tenant ID', exact: true }).fill(tenantId)
  await page.getByLabel('小时预警金额（USD）').fill('12.50')
  await page.getByRole('button', { name: '保存到 Blob', exact: true }).click()
  await expect(row).toContainText('等待客户授权')
})

test('only waiting-authorization tenants expose hard deletion, including at tablet width', async ({ page }) => {
  const discovered = { ...pending, tenantId: '22222222-2222-4222-8222-222222222222', displayName: '已发现客户', status: 'discovered' as const }
  const active = { ...pending, tenantId: '33333333-3333-4333-8333-333333333333', displayName: '活动客户', status: 'active' as const }
  const archived = { ...pending, tenantId: '44444444-4444-4444-8444-444444444444', displayName: '已解除客户', status: 'deleted' as const }
  await mockTenants(page, () => [pending, discovered, active, archived])
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: `删除 ${pending.displayName} 登记`, exact: true })).toBeVisible()
  for (const tenant of [discovered, active]) {
    const row = page.locator('tbody tr').filter({ hasText: tenant.tenantId })
    await expect(row.getByRole('button', { name: /删除.*登记/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: `解除 ${tenant.displayName} 管理`, exact: true })).toBeVisible()
  }
  await page.getByRole('tab', { name: '已解除管理 (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: /删除.*登记/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新登记', exact: true })).toBeVisible()
})

test('a changed authorization state blocks deletion and requires refreshing the list', async ({ page }) => {
  let tenant = pending
  let deleteRequests = 0
  await mockTenants(page, () => [tenant])
  await page.route(`**/api/v1/tenants/${pending.tenantId}`, (route) => {
    deleteRequests += 1
    expect(route.request().method()).toBe('DELETE')
    expect(route.request().headers()['if-match']).toBe(pending.etag)
    expect(route.request().postDataJSON()).toEqual({})
    tenant = { ...pending, status: 'discovered', revision: 2, etag: '"new-version"' }
    return route.fulfill({
      status: 412, contentType: 'application/problem+json',
      json: {
        type: 'about:blank', title: 'Tenant was modified', status: 412, code: 'TENANT_ETAG_MISMATCH',
        detail: '租户配置或授权状态已变化，未执行删除。请刷新列表后核对。',
        instance: `/api/v1/tenants/${pending.tenantId}`, correlationId: 'deletion-e2e',
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: `删除 ${pending.displayName} 登记`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除租户预登记' })
  await dialog.getByRole('button', { name: '确认删除登记', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('TENANT_ETAG_MISMATCH')
  await expect(dialog.getByRole('button', { name: '确认删除登记', exact: true })).toHaveCount(0)
  await expect(page.locator('tbody tr')).toContainText(pending.displayName)
  await dialog.getByRole('button', { name: '刷新租户列表', exact: true }).click()
  await expect(page.locator('tbody tr')).toContainText('已发现待启用')
  await expect(page.getByRole('button', { name: `删除 ${pending.displayName} 登记`, exact: true })).toHaveCount(0)
  expect(deleteRequests).toBe(1)
})

test('uncertain network failure stays visible and never pretends the registration was deleted', async ({ page }) => {
  await mockTenants(page, () => [pending])
  await page.route(`**/api/v1/tenants/${pending.tenantId}`, (route) => route.abort('failed'))
  await page.goto('/')
  await page.getByRole('button', { name: `删除 ${pending.displayName} 登记`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除租户预登记' })
  await dialog.getByRole('button', { name: '确认删除登记', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('删除结果未确认')
  await expect(dialog.getByRole('button', { name: '刷新租户列表', exact: true })).toBeVisible()
  await expect(page.locator('tbody tr')).toContainText(pending.displayName)
  await expect(page.getByText(`${pending.displayName} 的预登记已删除。`, { exact: true })).toHaveCount(0)
})

test('a completed deletion removes the row while retaining an explicit audit warning', async ({ page }) => {
  let items = [pending]
  await mockTenants(page, () => items)
  await page.route(`**/api/v1/tenants/${pending.tenantId}`, (route) => {
    items = []
    return route.fulfill({ json: {
      tenantId: pending.tenantId, deleted: true,
      warnings: [{ code: 'AUDIT_COMPLETION_WRITE_FAILED', message: '租户预登记已删除，但完成审计写入失败。' }],
    } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: `删除 ${pending.displayName} 登记`, exact: true }).click()
  await page.getByRole('dialog', { name: '删除租户预登记' }).getByRole('button', { name: '确认删除登记', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('完成审计写入失败')
  await expect(page.locator('tbody tr')).toHaveCount(0)
})

test('mail capability card contains no batch marker or stale authorization blocker', async ({ page }) => {
  await page.goto('/operations')
  const scope = page.getByRole('region', { name: '当前运行状态的范围', exact: true })
  const card = scope.locator('article').filter({ hasText: '告警与邮件 Outbox' })
  await expect(card).toContainText('发信授权与自动通知状态以设置页为准')
  await expect(card).not.toContainText('第六批')
  await expect(card).not.toContainText('真实发信需管理员完成邮箱授权')
  await expect(card.getByRole('link', { name: '查看告警与邮件设置', exact: true })).toHaveAttribute('href', '/settings')
  await card.getByRole('link', { name: '查看告警与邮件设置', exact: true }).click()
  await expect(page).toHaveURL(/\/settings$/)
})
