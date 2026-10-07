import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('development login can persist and reload a preregistered tenant', async ({
  page,
}) => {
  const tenantId = randomUUID()
  const displayName = `E2E 客户 ${tenantId.slice(0, 6)}`

  await page.goto('/')
  await expect(
    page.getByText('本地开发身份 · 不代表生产 Entra 登录'),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '租户与授权' }),
  ).toBeVisible()
  await expect(
    page.locator('.identity').getByText('local.operator@ms-ext.biz'),
  ).toBeVisible()

  await page.getByRole('button', { name: '预登记租户' }).click()
  await page.getByLabel('客户租户名称').fill(displayName)
  await page.getByLabel('Tenant ID').fill(tenantId)
  await page.getByLabel('小时预警金额（USD）').fill('12.50')
  await page.getByLabel('备注').fill('Playwright local persistence test')
  await page.getByRole('button', { name: '保存到 Blob' }).click()

  await expect(
    page.getByText(`${displayName} 已保存到 Blob`, { exact: false }),
  ).toBeVisible()
  const tenantRow = page.locator('tbody tr').filter({ hasText: displayName })
  await expect(tenantRow).toBeVisible()
  await expect(tenantRow).toContainText('US$12.50')

  await page.reload()
  await expect(
    page.getByRole('heading', { name: '租户与授权' }),
  ).toBeVisible()
  await expect(
    page.locator('tbody tr').filter({ hasText: displayName }),
  ).toBeVisible()

  await page.getByRole('button', { name: '预登记租户' }).click()
  await page.getByLabel('客户租户名称').fill(displayName)
  await page.getByLabel('Tenant ID').fill(tenantId)
  await page.getByLabel('小时预警金额（USD）').fill('12.50')
  await page.getByRole('button', { name: '保存到 Blob' }).click()
  await expect(page.getByText('TENANT_ALREADY_EXISTS', { exact: false })).toBeVisible()
})

test('invalid tenant input is rejected without closing the form', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '预登记租户' }).click()
  await page.getByLabel('客户租户名称').fill('无效客户')
  await page.getByLabel('Tenant ID').fill('not-a-guid')
  await page.getByLabel('小时预警金额（USD）').fill('0')
  await page.getByRole('button', { name: '保存到 Blob' }).click()

  await expect(page.getByText('VALIDATION_FAILED', { exact: false })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '预登记客户租户' }),
  ).toBeVisible()
})

test('syncs delegated subscriptions and enables a discovered tenant', async ({
  page,
}) => {
  const tenantId = '92078590-b3a5-4c46-aaea-74360df451d0'
  await page.goto('/')
  await page.getByRole('button', { name: '预登记租户' }).click()
  await page.getByLabel('客户租户名称').fill('Lighthouse 测试客户')
  await page.getByLabel('Tenant ID').fill(tenantId)
  await page.getByLabel('小时预警金额（USD）').fill('20.00')
  await page.getByRole('button', { name: '保存到 Blob' }).click()
  await expect(
    page.getByText('Lighthouse 测试客户 已保存到 Blob', {
      exact: false,
    }),
  ).toBeVisible()

  await page.getByRole('button', { name: '同步 Lighthouse' }).click()
  await expect(
    page.getByText('授权同步完成：发现 1 个客户租户、2 个订阅。'),
  ).toBeVisible({ timeout: 30_000 })

  const row = page.locator('tbody tr').filter({
    hasText: 'Lighthouse 测试客户',
  })
  await expect(row).toContainText('已发现待启用')
  await row
    .getByRole('button', {
      name: '查看 Lighthouse 测试客户 授权订阅',
    })
    .click()
  await expect(page.getByText('Pay-As-You-Go-TEMP')).toBeVisible()
  await expect(page.getByText('mct', { exact: true })).toBeVisible()
  await page.getByLabel('客户租户名称').fill('Lighthouse 已启用客户')
  await page.getByLabel('小时预警金额（USD）').fill('25.00')
  await page.getByRole('button', { name: '启用租户' }).click()

  await expect(
    page.getByText('Lighthouse 已启用客户 已启用。'),
  ).toBeVisible()
  const activeRow = page.locator('tbody tr').filter({
    hasText: 'Lighthouse 已启用客户',
  })
  await expect(activeRow).toContainText('活动')
  await expect(activeRow).toContainText('US$25.00')
})
