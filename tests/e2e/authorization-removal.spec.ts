import { expect, test, type Page } from '@playwright/test'
import type { AuthorizationSyncRun, SubscriptionInventoryDocument, TenantListItem } from '@tokenusagealert/schemas'

const tenantId = '11111111-1111-4111-8111-111111111111'
const subscriptionId = '22222222-2222-4222-8222-222222222222'
const time = '2026-10-04T12:00:00.000Z'
const originalTenant: TenantListItem = {
  schemaVersion: 1, revision: 1, tenantId, displayName: '解除管理验证客户', status: 'active',
  authorizationSource: 'lighthouse-template', hourlyThresholdUsd: '10.00', notes: '',
  createdByObjectId: 'fixture', createdByName: 'operator@ms-ext.biz', createdAtUtc: time,
  updatedAtUtc: time, deletedAtUtc: null, etag: '"one"',
}
const originalInventory: SubscriptionInventoryDocument = {
  schemaVersion: 1, revision: 1, tenantId, expectedSubscriptionIds: [subscriptionId],
  subscriptions: [{
    subscriptionId, customerTenantId: tenantId, displayName: '客户订阅 A', state: 'Enabled',
    firstSeenAtUtc: time, lastSeenAtUtc: time, lastValidatedAtUtc: time,
  }],
  observedAtUtc: time, updatedAtUtc: time, removedSubscriptions: [],
}

async function mockLifecycle(page: Page, failSync = false) {
  let tenant = structuredClone(originalTenant)
  let inventory = structuredClone(originalInventory)
  let run: AuthorizationSyncRun | null = null
  let syncCount = 0
  let destructiveRequests = 0
  page.on('request', (request) => { if (request.method() === 'DELETE') destructiveRequests += 1 })
  await page.route('**/api/v1/session', (route) => route.fulfill({
    json: { objectId: 'fixture', name: 'local.operator@ms-ext.biz', authMode: 'development' },
  }))
  await page.route(/\/api\/v1\/tenants(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      tenant = { ...tenant, displayName: body.displayName, status: 'pendingAuthorization', deletedAtUtc: null, etag: '"reregistered"' }
      return route.fulfill({ status: 201, json: { tenant } })
    }
    expect(new URL(route.request().url()).searchParams.get('includeRemoved')).toBe('true')
    return route.fulfill({ json: { items: [tenant], count: 1 } })
  })
  await page.route(`**/api/v1/tenants/${tenantId}/subscriptions`, (route) => route.fulfill({ json: { inventory } }))
  await page.route('**/api/v1/authorization/runs/latest', (route) => route.fulfill({ json: { run } }))
  await page.route('**/api/v1/authorization/sync', (route) => {
    syncCount += 1
    if (!failSync && syncCount === 1) {
      tenant = { ...tenant, status: 'deleted', deletedAtUtc: time, revision: 2, etag: '"removed"' }
      inventory = { ...inventory, subscriptions: [], expectedSubscriptionIds: [], removedSubscriptions: [{
        subscriptionId, customerTenantId: tenantId, displayName: '客户订阅 A', lastSeenAtUtc: time,
        removedAtUtc: time, reason: 'collector-access-removed',
      }] }
    } else if (!failSync) {
      tenant = { ...tenant, status: 'discovered', deletedAtUtc: null, revision: 3, etag: '"rediscovered"' }
      inventory = structuredClone(originalInventory)
    }
    run = {
      schemaVersion: 1, runId: syncCount === 1 ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444',
      status: failSync ? 'failed' : 'succeeded', startedAtUtc: time, finishedAtUtc: time,
      discoveredTenantCount: tenant.status === 'deleted' ? 0 : 1,
      visibleSubscriptionCount: inventory.subscriptions.length, updatedTenantCount: failSync ? 0 : 1,
      errors: failSync ? [{ tenantId: null, code: 'SUBSCRIPTION_DISCOVERY_FAILED', message: '授权查询超时，不能确认移除。' }] : [],
    }
    return route.fulfill({ status: 202, json: { executionName: 'fixture-sync', status: 'started' } })
  })
  return { getDestructiveRequests: () => destructiveRequests }
}

test('guides customer-side revocation, archives verified removals and requires reenablement after new authorization', async ({ page }) => {
  const state = await mockLifecycle(page)
  await page.goto('/')
  await page.getByRole('button', { name: '解除 解除管理验证客户 管理', exact: true }).click()
  const guide = page.getByRole('dialog', { name: '解除租户管理' })
  await expect(guide).toContainText('Collector 保持 Reader')
  await expect(guide).toContainText('撤销全部对应委派')
  await guide.getByRole('button', { name: '同步确认授权' }).click()
  await expect(page.getByRole('tab', { name: '已解除管理 (1)', exact: true })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(0)
  await page.getByRole('tab', { name: '已解除管理 (1)', exact: true }).click()
  await expect(page.locator('tbody tr')).toContainText('解除管理验证客户')
  await page.getByRole('button', { name: '查看 解除管理验证客户 授权订阅' }).click()
  const details = page.getByRole('dialog', { name: '解除管理验证客户', exact: true })
  await expect(details).toContainText('已移出订阅')
  await expect(details).toContainText('客户订阅 A')
  await expect(details.getByRole('link', { name: '查看该租户保留的费用历史' })).toHaveAttribute('href', `/tenants/${tenantId}/usage`)
  await details.getByRole('button', { name: '关闭授权详情' }).click()
  await page.getByRole('button', { name: '同步 Lighthouse', exact: true }).click()
  await expect(page.getByRole('tab', { name: '管理中 (1)', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '管理中 (1)', exact: true }).click()
  await expect(page.locator('tbody tr')).toContainText('已发现待启用')
  expect(state.getDestructiveRequests()).toBe(0)
})

test('subscription offboarding shows the exact customer scope and failed sync never pretends deletion succeeded', async ({ page }) => {
  const state = await mockLifecycle(page, true)
  await page.goto('/')
  await page.getByRole('button', { name: '查看 解除管理验证客户 授权订阅' }).click()
  await page.getByRole('button', { name: '解除订阅 客户订阅 A 管理' }).click()
  const guide = page.getByRole('dialog', { name: '解除订阅管理' })
  await expect(guide).toContainText(subscriptionId)
  await expect(guide).toContainText('只撤销这个订阅')
  await guide.getByRole('button', { name: '同步确认授权' }).click()
  await expect(page.getByRole('alert')).toContainText('未确认移除')
  await expect(page.getByRole('tab', { name: '管理中 (1)', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: '已解除管理 (0)', exact: true })).toBeVisible()
  expect(state.getDestructiveRequests()).toBe(0)
})

test('an archived tenant can be re-registered but never manually made active', async ({ page }) => {
  await mockLifecycle(page)
  await page.goto('/')
  await page.getByRole('button', { name: '同步 Lighthouse', exact: true }).click()
  await page.getByRole('tab', { name: '已解除管理 (1)', exact: true }).click()
  await page.getByRole('button', { name: '重新登记' }).click()
  await expect(page.getByRole('dialog', { name: '预登记客户租户' }).getByRole('textbox', { name: 'Tenant ID', exact: true })).toHaveValue(tenantId)
  await page.getByRole('button', { name: '保存到 Blob' }).click()
  await expect(page.locator('tbody tr')).toContainText('等待客户授权')
})

test('partner offboarding is unavailable until the customer grants the separate identity', async ({ page }) => {
  await mockLifecycle(page)
  await page.route(`**/api/v1/tenants/${tenantId}/offboarding/preview`, (route) => route.fulfill({
    json: {
      configured: true,
      identity: {
        clientId: '55555555-5555-4555-8555-555555555555',
        principalId: '66666666-6666-4666-8666-666666666666',
        collectorPrincipalId: '77777777-7777-4777-8777-777777777777',
        managingTenantId: '88888888-8888-4888-8888-888888888888',
        offerName: 'AOAI Cost Usage Monitoring',
      },
      operation: null,
      blockers: [{ subscriptionId, code: 'CUSTOMER_REAUTHORIZATION_REQUIRED', message: '请客户使用新版模板重新授权。' }],
    },
  }))
  await page.goto('/')
  await page.getByRole('button', { name: '解除 解除管理验证客户 管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解除租户管理' })
  await dialog.getByRole('button', { name: '检查解除权限并预览' }).click()
  await expect(dialog.getByRole('alert')).toContainText('CUSTOMER_REAUTHORIZATION_REQUIRED')
  await expect(dialog.getByRole('button', { name: '确认解除管理', exact: true })).toHaveCount(0)
  await expect(page.locator('tbody tr')).toContainText('解除管理验证客户')
})

test('partner must preview and type the customer ID before requesting removal', async ({ page }) => {
  await mockLifecycle(page)
  const id = '99999999-9999-4999-8999-999999999999'
  const prepared = {
    schemaVersion: 1, id, tenantId, tenantName: originalTenant.displayName, subscriptionId: null,
    requestedByObjectId: 'fixture', scopeGeneration: id, createdAtUtc: time, updatedAtUtc: time, expiresAtUtc: '2030-01-01T00:00:00.000Z',
    status: 'prepared', synchronizationRequested: false, synchronizationError: null,
    targets: [{ subscriptionId, displayName: '客户订阅 A',
      assignmentId: `/subscriptions/${subscriptionId}/providers/Microsoft.ManagedServices/registrationAssignments/${id}`,
      definitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.ManagedServices/registrationDefinitions/${id}`,
      fingerprint: 'a'.repeat(64), state: 'ready', message: null }],
  }
  let executions = 0
  await page.route(`**/api/v1/tenants/${tenantId}/offboarding/preview`, (route) => route.fulfill({
    json: { configured: true, identity: null, operation: prepared, blockers: [] },
  }))
  await page.route(`**/api/v1/authorization/offboarding/${id}/execute`, async (route) => {
    executions += 1
    expect(route.request().postDataJSON()).toEqual({ confirmation: tenantId })
    return route.fulfill({
      json: { operation: { ...prepared, status: 'submitted', synchronizationRequested: true,
        targets: prepared.targets.map((item) => ({ ...item, state: 'submitted', message: '等待授权同步确认。' })) } },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '解除 解除管理验证客户 管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解除租户管理' })
  await dialog.getByRole('button', { name: '检查解除权限并预览' }).click()
  await expect(dialog.getByRole('region', { name: '解除管理预览' })).toContainText('客户订阅 A')
  const confirm = dialog.getByRole('button', { name: '确认解除管理', exact: true })
  await expect(confirm).toBeDisabled()
  expect(executions).toBe(0)
  await dialog.getByRole('textbox', { name: '输入租户 ID 确认解除' }).fill(tenantId)
  await confirm.click()
  await expect(dialog).toContainText('已提交解除 · 待同步确认')
  await expect(dialog.getByRole('button', { name: '确认解除管理', exact: true })).toHaveCount(0)
  expect(executions).toBe(1)
})
