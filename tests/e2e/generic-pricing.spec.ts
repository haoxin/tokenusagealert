import { expect, test, type Page } from '@playwright/test'
import type { HourlyUsage, TenantListItem, UsagePriceReference } from '@tokenusagealert/schemas'

const id = '11111111-1111-4111-8111-111111111111'
const guid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const tenant: TenantListItem = {
  schemaVersion: 1, revision: 1, tenantId: id, displayName: '未来模型本地验证', hourlyThresholdUsd: '1.00',
  status: 'active', authorizationSource: 'lighthouse-template', notes: 'Local browser fixtures only',
  createdByName: 'fixture', createdByObjectId: 'fixture', createdAtUtc: '2026-10-01T00:00:00.000Z',
  updatedAtUtc: '2026-10-01T00:00:00.000Z', deletedAtUtc: null, etag: '"fixture"',
}
const price = (index: number, direction: 'input' | 'output', context: 'short' | 'long', usd: string): UsagePriceReference => ({
  direction, meterId: guid(index), source: 'official', unitQuantity: '1000000', unitPriceUsd: usd,
  effectiveStartUtc: '2026-09-01T00:00:00Z', snapshotId: guid(20), context, modality: 'unspecified', tier: 'standard',
  modelVersion: null, bound: context === 'short' ? 'lower' : 'upper',
})
const ranged: HourlyUsage = {
  schemaVersion: 1, tenantId: id, windowStartUtc: '2026-10-06T01:00:00.000Z', windowEndUtc: '2026-10-06T02:00:00.000Z',
  collectedAtUtc: '2026-10-06T02:15:00.000Z', repricedAtUtc: '2026-10-06T05:00:00.000Z', source: 'fixture',
  metricFamily: 'models-usage',
  status: 'complete', activity: 'hasUsage', finality: 'provisional', estimatedCostUsd: '16.739502000000',
  knownCostUsd: '16.739502000000', knownCostUpperUsd: '28.680713000000', thresholdUsd: '1.00',
  inputTokens: '1000000', outputTokens: '2000000', priceSnapshotId: guid(20),
  estimatePolicy: 'model-independent-retail-range', pricingRuleVersion: 3, validation: 'awaiting-positive-usage-verification',
  coverage: { expectedSubscriptions: 1, successfulSubscriptions: 1, accounts: 1, expectedDeployments: 1, successfulDeployments: 1, pricedDeployments: 1 },
  issues: [], breakdown: [{
    deployment: { id: '/fixture/deployments/future', subscriptionId: guid(21), accountId: '/fixture/accounts/mock',
      accountName: 'mock-local', accountKind: 'OpenAI', region: 'swedencentral', name: 'future-model',
      modelName: 'gpt-9-orion', modelVersion: 'future-version', modelFormat: 'OpenAI', sku: 'GlobalStandard',
      firstObservedAtUtc: '2026-10-01T00:00:00.000Z', observedAtUtc: '2026-10-06T02:15:00.000Z', deleted: false },
    inputTokens: '1000000', outputTokens: '2000000', metricsStatus: 'success', metadataVerified: true, issues: [],
    costUsd: '16.739502000000', costUpperUsd: '28.680713000000', pricingStatus: 'range', pricingUncertainty: ['context'],
    prices: [price(1, 'input', 'short', '2.739502'), price(2, 'output', 'short', '7'),
      price(3, 'input', 'long', '4.680713'), price(4, 'output', 'long', '12')],
  }],
}
async function fixture(page: Page, hour: HourlyUsage) {
  await page.route(`**/api/v1/tenants/${id}`, (route) => route.fulfill({ json: { tenant } }))
  await page.route(`**/api/v1/tenants/${id}/usage?*`, (route) => route.fulfill({
    json: { tenantId: id, hours: [hour], inventory: null, latestRun: null },
  }))
  await page.route(`**/api/v1/tenants/${id}/alerts`, (route) => route.fulfill({ json: { items: [{
    schemaVersion: 1, id: 'a'.repeat(64), key: 'local-reprice-test', kind: 'cost-exceeded', subject: `tenant-${id}`,
    tenantId: id, tenantName: tenant.displayName, occurredAtUtc: hour.windowEndUtc,
    windowStartUtc: hour.windowStartUtc, windowEndUtc: hour.windowEndUtc, amountUsd: hour.knownCostUsd,
    amountUpperUsd: hour.knownCostUpperUsd, thresholdUsd: '1.00', dataStatus: hour.status,
    repricedAtUtc: hour.repricedAtUtc, createdAtUtc: '2026-10-06T05:00:00.000Z', issues: [],
  }] } }))
}

test('future-model pricing shows honest ranges, complete independent data/status badges, all meter references and historical calculation time', async ({ page }) => {
  await fixture(page, ranged)
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`/tenants/${id}/usage`)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.usage-summary-grid')).toContainText('US$16.7395–US$28.6807')
  const hour = page.getByRole('region', { name: '所选小时费用', exact: true })
  await expect(hour).toContainText('数据完整')
  await expect(hour).toContainText('区间估算')
  await expect(hour).toContainText('暂定结果')
  await expect(hour).toContainText('本地模拟来源')
  await expect(hour).toContainText('已匹配 · 区间估算')
  await expect(hour).toContainText('Models - Usage · InputTokens / OutputTokens')
  await expect(hour).toContainText('1,000,000')
  await expect(hour).toContainText('2,000,000')
  await expect(hour).toContainText('缺价补算时间')
  await expect(hour).toContainText('短/长上下文')
  await expect(hour.locator('p').filter({ hasText: '官方 meter' })).toHaveCount(4)
  await expect(page.getByText('估算费用超限 · 历史小时补算', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '10 天', exact: true }).click()
  await expect(hour).toContainText('US$16.7395–US$28.6807')
  expect(consoleErrors).toEqual([])
})

test('missing non-token billing quantities remain an explicitly partial subtotal with unknown upper bound instead of zero or a full-model total', async ({ page }) => {
  const partial: HourlyUsage = {
    ...ranged, status: 'partial', estimatedCostUsd: null, knownCostUsd: '2.739502000000', knownCostUpperUsd: null,
    issues: [{ code: 'ADDITIONAL_BILLING_UNITS_MISSING', message: '按小时计费缺少对应计量，已知 token 仅为小计。', resourceId: null }],
    breakdown: [{ ...ranged.breakdown[0]!, costUsd: '2.739502000000', costUpperUsd: null, pricingStatus: 'missing',
      issues: [{ code: 'ADDITIONAL_BILLING_UNITS_MISSING', message: '未知时长不能按零价估算。', resourceId: null }] }],
  }
  await fixture(page, partial)
  await page.goto(`/tenants/${id}/usage`)
  await expect(page.locator('.usage-summary-grid')).toContainText('US$2.7395 起 · 上限未知')
  const hour = page.getByRole('region', { name: '所选小时费用', exact: true })
  await expect(hour).toContainText('部分数据')
  await expect(hour).toContainText('当前不是完整租户总费用')
  await expect(hour).toContainText('ADDITIONAL_BILLING_UNITS_MISSING')
})

test('range amounts and price references fit desktop and tablet widths without horizontal page overflow', async ({ page }) => {
  await fixture(page, ranged)
  await page.goto(`/tenants/${id}/usage`)
  await page.waitForLoadState('networkidle')
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1080 })
    const dimensions = await page.evaluate(() => ({ visible: innerWidth, document: document.documentElement.scrollWidth }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.visible + 1)
    await page.screenshot({
      path: `/home/chx/.copilot/session-state/26f4dc38-7cdf-483b-a7fa-b2bdae3c98e0/files/generic-billing-ui-${width}.png`,
      fullPage: true,
    })
  }
})
