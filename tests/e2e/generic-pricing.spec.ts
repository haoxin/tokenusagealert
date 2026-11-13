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
async function fixture(page: Page, hour: HourlyUsage, next?: HourlyUsage) {
  await page.route('**/api/v1/session', (route) => route.fulfill({
    json: { objectId: 'fixture', name: 'Local billing verification', authMode: 'development' },
  }))
  await page.route(`**/api/v1/tenants/${id}`, (route) => route.fulfill({ json: { tenant } }))
  await page.route(`**/api/v1/tenants/${id}/usage?*`, (route) => route.fulfill({
    json: { tenantId: id, hours: next ? [hour, next] : [hour], inventory: null, latestRun: null },
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

test('served priority slices and cache-hit Percent are explicit and never presented as exact cached tokens', async ({ page }) => {
  const hour: HourlyUsage = {
    ...ranged, knownCostUsd: '35.2', knownCostUpperUsd: '35.2', estimatedCostUsd: '35.2',
    breakdown: [{
      ...ranged.breakdown[0]!, costUsd: '35.2', costUpperUsd: '35.2', pricingStatus: 'matched', pricingUncertainty: [],
      billingSlices: [
        { direction: 'input', tokens: '400000', tier: 'standard', context: null, modality: null },
        { direction: 'input', tokens: '600000', tier: 'priority', context: null, modality: null },
        { direction: 'output', tokens: '800000', tier: 'standard', context: null, modality: null },
        { direction: 'output', tokens: '1200000', tier: 'priority', context: null, modality: null },
      ],
      prices: [{ ...price(1, 'input', 'short', '2'), bound: 'both' },
        { ...price(2, 'output', 'short', '7'), bound: 'both' },
        { ...price(3, 'input', 'short', '6'), tier: 'priority', bound: 'both' },
        { ...price(4, 'output', 'short', '21'), tier: 'priority', bound: 'both' }],
      billingTelemetry: { tierSource: 'azure-openai-usage', cache: { source: 'openai-cache-match-rate',
        status: 'available', matchRatePercent: '42.5', readTokens: null, write5mTokens: null, write1hTokens: null } },
    }],
  }
  await fixture(page, hour)
  await page.goto(`/tenants/${id}/usage`)
  const selected = page.getByRole('region', { name: '所选小时费用', exact: true })
  await expect(selected).toContainText('OpenAI 补充指标 · 已与 Models 总量逐部署核对')
  await expect(selected).toContainText('缓存命中率（小时平均）：42.5%')
  await expect(selected).toContainText('不是精确缓存 token 数')
  const tiers = selected.getByRole('table', { name: '实际服务档位 token' })
  await expect(tiers.locator('tbody tr').filter({ hasText: 'Priority（优先）' })).toContainText('600,000')
  await expect(tiers.locator('tbody tr').filter({ hasText: 'Priority（优先）' })).toContainText('1,200,000')
  await expect(page.locator('.usage-summary-grid')).toContainText('US$35.20')
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1080 })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  }
})

test('provider-specific cache quantities and unavailable cache measurements are not collapsed to zero', async ({ page }) => {
  const hour: HourlyUsage = {
    ...ranged, status: 'partial', knownCostUsd: null, knownCostUpperUsd: null, estimatedCostUsd: null,
    inputTokens: '0', outputTokens: '0', activity: 'hasUsage',
    issues: [{ code: 'CACHE_BILLING_UNVERIFIED', message: '缓存计费协议未确认。', resourceId: null }],
    breakdown: [{
      ...ranged.breakdown[0]!, deployment: { ...ranged.breakdown[0]!.deployment, modelFormat: 'Anthropic' },
      inputTokens: '0', outputTokens: '0', costUsd: null, costUpperUsd: null, pricingStatus: 'missing', prices: [],
      billingTelemetry: { tierSource: 'unknown', cache: { source: 'anthropic-cache-tokens',
        status: 'available', matchRatePercent: null, readTokens: '1000', write5mTokens: '80', write1hTokens: null } },
    }],
  }
  await fixture(page, hour)
  await page.route(`**/api/v1/tenants/${id}/alerts`, (route) => route.fulfill({ json: { items: [] } }))
  await page.goto(`/tenants/${id}/usage`)
  const selected = page.getByRole('region', { name: '所选小时费用', exact: true })
  await expect(selected.locator('dl div').filter({ hasText: '缓存读取 token' })).toContainText('1,000')
  await expect(selected.locator('dl div').filter({ hasText: '5 分钟 TTL' })).toContainText('80')
  await expect(selected.locator('dl div').filter({ hasText: '1 小时 TTL' })).toContainText('—')
  await expect(selected).toContainText('Anthropic 专属计数独立保留')
  await expect(selected).toContainText('CACHE_BILLING_UNVERIFIED')
  await expect(page.locator('.usage-summary-grid').locator('article').first()).toContainText('—')
})

test('ratio-derived cache reads and prices are clearly estimates while write quantities remain unknown', async ({ page }) => {
  const hour: HourlyUsage = {
    ...ranged, knownCostUsd: '15.55', knownCostUpperUsd: '15.925', estimatedCostUsd: '15.55',
    pricingRuleVersion: 4, estimatePolicy: 'cache-ratio-retail-range',
    breakdown: [{
      ...ranged.breakdown[0]!, costUsd: '15.55', costUpperUsd: '15.925', pricingStatus: 'range',
      pricingUncertainty: ['cacheRead', 'cacheWrite'],
      cacheReadEstimate: { method: 'hourly-match-rate', matchRatePercent: '25',
        estimatedReadTokens: '250000', estimatedNonCachedInputTokens: '750000', tierAllocation: 'same-ratio-per-tier' },
      billingTelemetry: { tierSource: 'models', cache: { source: 'openai-cache-match-rate',
        status: 'available', matchRatePercent: '25', readTokens: null, write5mTokens: null, write1hTokens: null } },
      prices: [{ ...price(1, 'input', 'short', '2'), bound: 'both' },
        { ...price(2, 'output', 'short', '7'), bound: 'both' },
        { ...price(3, 'input', 'short', '0.2'), direction: 'cachedInput', bound: 'both' },
        { ...price(4, 'input', 'short', '2.5'), direction: 'cacheWrite', bound: 'upper' }],
    }],
  }
  await fixture(page, hour)
  await page.goto(`/tenants/${id}/usage`)
  const selected = page.getByRole('region', { name: '所选小时费用', exact: true })
  await expect(page.locator('.usage-summary-grid')).toContainText('US$15.55–US$15.925')
  await expect(page.locator('.usage-notice')).toContainText('按小时比例估算缓存读取并匹配单价')
  await expect(page.locator('.usage-notice')).not.toContainText('不折算折扣')
  await expect(page.locator('.usage-notice')).toContainText('历史口径以小时明细为准')
  await expect(selected.locator('dl div').filter({ hasText: '缓存读取 token（比例估算）' })).toContainText('250,000')
  await expect(selected.locator('dl div').filter({ hasText: '非缓存输入 token（比例估算）' })).toContainText('750,000')
  await expect(selected).toContainText('不代表各档位的真实缓存分布')
  await expect(selected).toContainText('cache_write_tokens')
  await expect(selected).toContainText('不与普通输入重复收费')
  await expect(selected).toContainText('缓存读取 · Standard（标准） · 短上下文：US$0.20')
  await expect(selected).toContainText('缓存写入 · Standard（标准） · 短上下文：US$2.50')
  await expect(selected).not.toContainText('该小时未应用缓存比例估算')
})

test('range amounts and price references fit desktop and tablet widths without horizontal page overflow', async ({ page }, testInfo) => {
  await fixture(page, ranged)
  await page.goto(`/tenants/${id}/usage`)
  await page.waitForLoadState('networkidle')
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 1080 })
    const dimensions = await page.evaluate(() => ({ visible: innerWidth, document: document.documentElement.scrollWidth }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.visible + 1)
    await page.screenshot({
      path: testInfo.outputPath(`generic-billing-ui-${width}.png`),
      fullPage: true,
    })
  }
})

test('dual estimates draw the weighted reference dashed and native USD solid, with independent values', async ({ page }) => {
  const estimate = { metricName: 'FoundryModelEstimatedCost' as const, currency: 'USD' as const,
    status: 'available' as const, costUsd: '16.739502000000', retrievedAtUtc: ranged.collectedAtUtc, issue: null }
  const hour: HourlyUsage = {
    ...ranged, pricingRuleVersion: 5, estimatePolicy: 'equal-context-retail-range',
    knownCostUsd: '22.710107500000', estimatedCostUsd: '22.710107500000', knownCostUpperUsd: '22.710107500000',
    foundryEstimatedCost: estimate,
    breakdown: [{ ...ranged.breakdown[0]!, costUsd: '22.710107500000', costUpperUsd: '22.710107500000',
      contextMixEstimate: { method: 'equal-short-long', basis: 'tokens', shortWeight: '0.5', longWeight: '0.5' },
      foundryEstimatedCost: estimate }],
  }
  await fixture(page, hour, { ...hour, windowStartUtc: hour.windowEndUtc, windowEndUtc: '2026-10-06T03:00:00.000Z' })
  await page.goto(`/tenants/${id}/usage`)
  await page.waitForLoadState('networkidle')
  const chart = page.locator('.usage-chart')
  await expect(chart.locator('[stroke="#479ef5"][stroke-dasharray="3 3"]')).not.toHaveCount(0)
  await expect(chart.locator('[stroke="#0f6cbd"]')).not.toHaveCount(0)
  await expect(chart).toContainText('本地参考估算')
  await expect(chart).toContainText('Azure 原生估算')
  await expect(page.locator('.usage-summary-grid')).toContainText('US$22.7101')
  await expect(page.locator('.usage-summary-grid')).toContainText('US$16.7395')
  await expect(page.getByRole('region', { name: '所选小时费用', exact: true })).toContainText('50/50 上下文参考')
  await expect(page.getByText('原生费用覆盖 2/2 个已记录小时；未取得的小时不按零金额累加。', { exact: true })).toBeVisible()
})

test('missing native metrics stay empty instead of using a zero or the reference amount', async ({ page }) => {
  const hour: HourlyUsage = {
    ...ranged, pricingRuleVersion: 5, estimatePolicy: 'equal-context-retail-range',
    foundryEstimatedCost: { metricName: 'FoundryModelEstimatedCost', currency: 'USD', status: 'noData',
      costUsd: null, retrievedAtUtc: ranged.collectedAtUtc, issue: null },
  }
  await fixture(page, hour, { ...hour, windowStartUtc: hour.windowEndUtc, windowEndUtc: '2026-10-06T03:00:00.000Z' })
  await page.goto(`/tenants/${id}/usage`)
  const nativeCard = page.locator('.usage-summary-grid article').filter({ hasText: '所选小时 Azure 原生估算' })
  await expect(nativeCard.locator('strong')).toHaveText('—')
  await expect(page.locator('.usage-chart [stroke="#0f6cbd"]')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '所选小时费用', exact: true })).toContainText('原生指标暂无数据')
})
