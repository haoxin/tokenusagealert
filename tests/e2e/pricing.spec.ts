import { expect, test, type Page, type Route } from '@playwright/test'
import type { getPricingHistory, getPricingStatus } from '../../apps/web/client/src/api'

type PricingStatus = Awaited<ReturnType<typeof getPricingStatus>>
type PricingHistory = Awaited<ReturnType<typeof getPricingHistory>>
type Snapshot = NonNullable<PricingStatus['active']>
type Run = NonNullable<PricingStatus['latestRun']>

const snapshotId = '11111111-1111-4111-8111-111111111111'
const nextSnapshotId = '22222222-2222-4222-8222-222222222222'
const backupSnapshotId = '33333333-3333-4333-8333-333333333333'
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const nextRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    fetchedAtUtc: '2026-10-01T16:00:00.000Z',
    source: 'azure-retail',
    apiVersion: '2023-01-01-preview',
    parserVersion: 1,
    currency: 'USD',
    cloud: 'AzureCloud',
    pageCount: 3,
    sourceRecordCount: 1290,
    meterCount: 1284,
    duplicateCount: 6,
    unsupportedMeterCount: 1284,
    unrecognizedUnitCount: 2,
    contentHash: 'a'.repeat(64),
    changes: {
      previousSnapshotId: null,
      addedMeterCount: 1284,
      removedMeterCount: 0,
      changedPriceCount: 0,
      unchangedMeterCount: 0,
      priceFromZeroCount: 0,
      largestPriceChangePercent: null,
    },
    ...overrides,
  }
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1,
    runId,
    status: 'succeeded',
    startedAtUtc: '2026-10-01T16:00:00.000Z',
    finishedAtUtc: '2026-10-01T16:00:06.000Z',
    source: 'azure-retail',
    snapshotId,
    pageCount: 3,
    recordCount: 1290,
    error: null,
    ...overrides,
  }
}

function pricingStatus(overrides: Partial<PricingStatus> = {}): PricingStatus {
  return {
    active: snapshot(),
    latestRun: run(),
    freshness: 'fresh',
    ageHours: 2,
    nextScheduledAtUtc: '2026-10-02T16:00:00.000Z',
    scheduleCronUtc: '0 16 * * *',
    businessTimeZone: 'Asia/Shanghai',
    retentionDays: 90,
    automaticUpdates: true,
    ...overrides,
  }
}

function fulfillProblem(route: Route, status: number, code: string, detail: string) {
  return route.fulfill({
    status,
    contentType: 'application/problem+json',
    json: {
      type: 'about:blank',
      title: 'Pricing request failed',
      status,
      code,
      detail,
      instance: new URL(route.request().url()).pathname,
      correlationId: 'pricing-e2e',
    },
  })
}

async function mockPricing(
  page: Page,
  getStatus: () => PricingStatus,
  getHistory: (url: URL) => PricingHistory = () => {
    const active = getStatus().active
    return { items: active ? [active] : [], nextCursor: null }
  },
) {
  await page.route('**/api/v1/session', (route) => route.fulfill({
    json: {
      objectId: '00000000-0000-4000-8000-000000000001',
      name: 'local.operator@ms-ext.biz',
      authMode: 'development',
    },
  }))
  await page.route('**/api/v1/pricing/status', (route) => route.fulfill({ json: getStatus() }))
  await page.route(/\/api\/v1\/pricing\/history(?:\?|$)/, (route) =>
    route.fulfill({ json: getHistory(new URL(route.request().url())) }),
  )
}

function currentSnapshot(page: Page) {
  return page.getByRole('region', { name: '当前价格快照', exact: true })
}

function backups(page: Page) {
  return page.getByRole('region', { name: '近 90 天价格备份', exact: true })
}

test('empty settings show missing values, enabled guarded navigation and the batch4 boundary', async ({ page }) => {
  const empty = pricingStatus({ active: null, latestRun: null, freshness: 'missing', ageHours: null })
  await mockPricing(page, () => empty)
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/settings')

  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  await expect(page.getByText('本地开发身份 · 不代表生产 Entra 登录')).toBeVisible()
  const navigation = page.getByRole('navigation', { name: '主导航' })
  await expect(navigation.getByRole('link', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(navigation.getByRole('link', { name: '费用概览', exact: true })).toHaveAttribute('href', '/overview')
  await expect(currentSnapshot(page)).toContainText('尚无可用价格快照')
  await expect(page.getByTestId('pricing-meter-count')).toHaveText('—')
  await expect(page.getByText('价格就绪 ≠ 费用可计算', { exact: true })).toBeVisible()
  await expect(backups(page)).toContainText('暂无价格备份')
  await expect(page.getByRole('region', { name: '自动同步规则' })).toContainText('每日 00:00')
  await expect(page.getByRole('region', { name: '自动同步规则' })).toContainText('2026/10/03 00:00:00')
  await expect(page.getByRole('region', { name: '其他平台设置' })).toContainText('仅部署管理员管理')
  await expect(page.getByRole('button', { name: /保存模拟|发送模拟|批准|审核/ })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await navigation.getByRole('link', { name: '运行状态', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/operations$/)
  await expect(page.getByRole('region', { name: '最近价格同步运行' })).toContainText('暂无价格同步运行')
  await expect(page.getByRole('region', { name: '当前运行状态的范围' })).toContainText('当前无用量')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await navigation.getByRole('link', { name: '租户与授权', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: '租户与授权', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '同步 Lighthouse' })).toBeVisible()
})

test('HTTP 202 and an old successful run do not confirm the requested sync', async ({ page }) => {
  let current = pricingStatus()
  let reads = 0
  await mockPricing(page, () => {
    reads += 1
    return current
  }, () => ({
    items: current.active?.snapshotId === nextSnapshotId
      ? [current.active, snapshot()]
      : [snapshot()],
    nextCursor: null,
  }))
  let posted = false
  await page.route('**/api/v1/pricing/sync', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['content-type']).toContain('application/json')
    expect(route.request().postDataJSON()).toEqual({})
    posted = true
    await route.fulfill({ status: 202, json: { executionName: 'price-e2e-new-run', status: 'started' } })
  })
  await page.goto('/settings')
  await page.getByRole('button', { name: '立即同步价格' }).click()
  const feedback = page.getByTestId('pricing-sync-feedback')
  await expect(feedback).toContainText('HTTP 202 不代表同步成功')
  expect(posted).toBe(true)
  const baselineReads = reads
  await expect.poll(() => reads).toBeGreaterThan(baselineReads)
  await expect(feedback).not.toContainText('价格同步成功')
  await expect(currentSnapshot(page)).toContainText(snapshotId)

  current = pricingStatus({
    latestRun: run({
      runId: nextRunId,
      status: 'running',
      startedAtUtc: '2026-10-02T16:00:00.000Z',
      finishedAtUtc: null,
      snapshotId: null,
    }),
  })
  await expect(currentSnapshot(page).getByText('运行中', { exact: true })).toBeVisible()
  await expect(feedback).not.toContainText('价格同步成功')

  current = pricingStatus({
    active: snapshot({
      snapshotId: nextSnapshotId,
      fetchedAtUtc: '2026-10-02T16:00:00.000Z',
      changes: {
        previousSnapshotId: snapshotId,
        addedMeterCount: 2,
        removedMeterCount: 2,
        changedPriceCount: 3,
        unchangedMeterCount: 1279,
        priceFromZeroCount: 1,
        largestPriceChangePercent: '12.5',
      },
    }),
    latestRun: run({
      runId: nextRunId,
      snapshotId: nextSnapshotId,
      startedAtUtc: '2026-10-02T16:00:00.000Z',
      finishedAtUtc: '2026-10-02T16:00:06.000Z',
    }),
  })
  await expect(feedback).toContainText('价格同步成功')
  await expect(currentSnapshot(page)).toContainText(nextSnapshotId)
  await expect(page.getByRole('region', { name: '与前一快照对比' })).toContainText('12.5%')
  await expect(backups(page).locator('tbody tr').filter({ hasText: nextSnapshotId })).toContainText('当前使用')
  await expect(backups(page).locator('tbody tr').filter({ hasText: snapshotId })).toContainText('已备份')
})

test('a newly failed run is reported and the last-known-good snapshot is preserved', async ({ page }) => {
  let current = pricingStatus()
  await mockPricing(page, () => current)
  await page.route('**/api/v1/pricing/sync', async (route) => {
    current = pricingStatus({
      latestRun: run({
        runId: nextRunId,
        status: 'failed',
        snapshotId: null,
        startedAtUtc: '2026-10-02T16:00:00.000Z',
        finishedAtUtc: '2026-10-02T16:00:04.000Z',
        error: { code: 'PRICING_PAGE_FAILED', message: '第二页拉取失败，快照未替换。' },
      }),
    })
    await route.fulfill({ status: 202, json: { executionName: 'price-e2e-failed', status: 'started' } })
  })
  await page.goto('/settings')
  await page.getByRole('button', { name: '立即同步价格' }).click()
  await expect(page.getByTestId('pricing-sync-feedback')).toContainText('价格同步失败')
  await expect(page.getByRole('alert').filter({ hasText: 'PRICING_PAGE_FAILED' })).toContainText('继续保留上一份可用快照')
  await expect(currentSnapshot(page)).toContainText(snapshotId)
  await expect(page.getByTestId('pricing-meter-count')).toHaveText('1,284')
  await expect(page.getByRole('button', { name: '重试价格同步' })).toBeEnabled()

  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '运行状态', exact: true }).click()
  const latestRun = page.getByRole('region', { name: '最近价格同步运行' })
  await expect(latestRun).toContainText(nextRunId)
  await expect(latestRun.getByRole('alert')).toContainText('PRICING_PAGE_FAILED')
  await expect(latestRun).toContainText('2026/10/03 00:00:04')
})

for (const freshness of ['stale', 'expired'] as const) {
  test(`a ${freshness} fixture snapshot is explicitly marked and never presented as live Azure pricing`, async ({ page }) => {
    const data = pricingStatus({
      active: snapshot({ source: 'fixture' }),
      latestRun: run({ source: 'fixture' }),
      freshness,
      ageHours: freshness === 'stale' ? 40 : 80,
    })
    await mockPricing(page, () => data)
    await page.goto('/settings')
    await expect(page.getByTestId('pricing-fixture-notice')).toContainText('本地模拟来源（fixture）')
    await expect(currentSnapshot(page)).toContainText(freshness === 'stale' ? '已陈旧' : '已过期')
    await expect(currentSnapshot(page).getByRole('alert')).toContainText(freshness === 'stale' ? '36 小时' : '72 小时')
    await expect(page.getByRole('region', { name: '单位与适用范围' })).toContainText('不强行按 1 折算')
    await expect(page.getByTestId('pricing-meter-count')).toHaveText('1,284')
  })
}

test('history errors remain visible, opaque pagination is encoded and backups are not activation claims', async ({ page }) => {
  const data = pricingStatus()
  const cursor = 'opaque/+cursor=='
  const older = snapshot({ snapshotId: backupSnapshotId, fetchedAtUtc: '2026-09-30T16:00:00.000Z' })
  await mockPricing(page, () => data)
  let failInitial = true
  let failNext = true
  await page.route(/\/api\/v1\/pricing\/history(?:\?|$)/, async (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('limit')).toBe('10')
    if (failInitial) return fulfillProblem(route, 503, 'HISTORY_UNAVAILABLE', '无法读取备份。')
    if (url.searchParams.has('cursor')) {
      expect(url.searchParams.get('cursor')).toBe(cursor)
      if (failNext) return fulfillProblem(route, 503, 'HISTORY_PAGE_FAILED', '无法读取下一页。')
      return route.fulfill({ json: { items: [older], nextCursor: null } })
    }
    return route.fulfill({ json: { items: [data.active], nextCursor: cursor } })
  })
  await page.goto('/settings')
  await expect(backups(page).getByRole('alert')).toContainText('读取价格备份失败')
  await expect(backups(page).getByText('暂无价格备份', { exact: true })).toHaveCount(0)

  failInitial = false
  await backups(page).getByRole('button', { name: '重试加载备份' }).click()
  await expect(backups(page).locator('tbody tr').filter({ hasText: snapshotId })).toContainText('当前使用')
  await backups(page).getByRole('button', { name: '加载更早备份' }).click()
  await expect(backups(page).getByRole('alert')).toContainText('读取更早价格备份失败')
  await expect(backups(page).locator('tbody tr').filter({ hasText: snapshotId })).toBeVisible()

  failNext = false
  await backups(page).getByRole('button', { name: '重试加载备份' }).click()
  await expect(backups(page).locator('tbody tr')).toHaveCount(2)
  await expect(backups(page).locator('tbody tr').filter({ hasText: backupSnapshotId })).toContainText('已备份')
  await expect(backups(page)).toContainText('不一定曾被使用')
  await expect(backups(page).getByRole('button', { name: '加载更早备份' })).toHaveCount(0)

  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const failure of [
  { status: 409, code: 'PRICING_SYNC_BUSY', detail: '已有同步正在运行。' },
  { status: 503, code: 'PRICING_SYNC_NOT_CONFIGURED', detail: '尚未配置价格同步 Job。' },
]) {
  test(`a ${failure.status} sync response is an actionable error, not success`, async ({ page }) => {
    const data = pricingStatus()
    await mockPricing(page, () => data)
    await page.route('**/api/v1/pricing/sync', (route) =>
      fulfillProblem(route, failure.status, failure.code, failure.detail),
    )
    await page.goto('/settings')
    await page.getByRole('button', { name: '立即同步价格' }).click()
    await expect(page.getByRole('alert').filter({ hasText: failure.code })).toContainText(failure.detail)
    await expect(page.getByTestId('pricing-sync-feedback')).toHaveCount(0)
    await expect(currentSnapshot(page)).toContainText(snapshotId)
    await expect(page.getByRole('button', { name: '刷新价格状态' })).toBeEnabled()
  })
}

test('invalid status payloads are visible failures rather than a successful empty state', async ({ page }) => {
  await mockPricing(page, () => pricingStatus())
  await page.route('**/api/v1/pricing/status', (route) => route.fulfill({ json: { active: null } }))
  await page.goto('/settings')
  await expect(page.getByRole('alert').filter({ hasText: '读取价格状态失败' })).toBeVisible()
  await expect(currentSnapshot(page)).toContainText('尚未取得价格状态')
  await expect(page.getByTestId('pricing-meter-count')).toHaveText('—')
  await expect(page.getByRole('button', { name: '立即同步价格' })).toBeDisabled()
})

test('running syncs stop automatic polling after a bounded wait and offer an explicit refresh', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-02T16:00:00.000Z') })
  await page.clock.pauseAt(new Date('2026-10-02T17:00:00.000Z'))
  let reads = 0
  await mockPricing(page, () => {
    reads += 1
    return pricingStatus({
      latestRun: run({ status: 'running', finishedAtUtc: null, snapshotId: null, pageCount: reads }),
    })
  })
  await page.goto('/operations')
  const latestRun = page.getByRole('region', { name: '最近价格同步运行' })
  await expect(latestRun.getByText('运行中', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '正在跟踪同步' })).toBeDisabled()
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const previousReads = reads
    await page.clock.runFor(2_000)
    await expect.poll(() => reads).toBeGreaterThan(previousReads)
    await expect(latestRun.getByText('已读取页面', { exact: true }).locator('..').locator('dd')).toHaveText(String(reads))
  }
  await expect(page.getByTestId('pricing-sync-feedback')).toContainText('已暂停自动跟踪')
  await expect(page.getByTestId('pricing-sync-feedback')).toContainText('尚未确认本次同步成功')
  await expect(page.getByRole('button', { name: '刷新价格状态' })).toBeEnabled()
  const finalReads = reads
  await page.clock.runFor(60_000)
  expect(reads).toBe(finalReads)
})

test('leaving a running pricing page aborts its poll loop', async ({ page }) => {
  await page.clock.install()
  let reads = 0
  await mockPricing(page, () => {
    reads += 1
    return pricingStatus({ latestRun: run({ status: 'running', finishedAtUtc: null, snapshotId: null }) })
  })
  await page.goto('/operations')
  await expect(page.getByRole('button', { name: '正在跟踪同步' })).toBeDisabled()
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '租户与授权', exact: true }).click()
  await expect(page.getByRole('heading', { name: '租户与授权', exact: true })).toBeVisible()
  const readsOnExit = reads
  await page.clock.runFor(60_000)
  expect(reads).toBe(readsOnExit)
})

for (const path of ['/settings', '/operations']) {
  test(`${path} requires a valid session before loading price data`, async ({ page }) => {
    let pricingRequests = 0
    await page.route('**/api/v1/session', (route) => fulfillProblem(route, 401, 'AUTH_REQUIRED', '需要登录。'))
    await page.route('**/api/v1/pricing/**', (route) => {
      pricingRequests += 1
      return route.fulfill({ json: {} })
    })
    await page.goto(path)
    await expect(page.getByRole('heading', { name: '需要合作伙伴 Entra ID 登录' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0)
    expect(pricingRequests).toBe(0)
  })
}

test('the actual local fixture POST persists a snapshot and backup across reload', async ({ page }) => {
  test.setTimeout(60_000)
  // This test deliberately does not intercept the session, pricing endpoints or storage.
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
  const beforeResponse = await page.request.get('/api/v1/pricing/status')
  expect(beforeResponse.ok()).toBe(true)
  const before = await beforeResponse.json() as PricingStatus

  const syncButton = page.getByRole('button', { name: /^(立即同步价格|重试价格同步)$/ })
  await expect(syncButton).toBeEnabled({ timeout: 30_000 })
  const postResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/pricing/sync' &&
    response.request().method() === 'POST',
  )
  await syncButton.click()
  const started = await postResponse
  expect(started.status()).toBe(202)
  expect(await started.json()).toMatchObject({ status: 'started', executionName: expect.any(String) })
  await expect(page.getByTestId('pricing-sync-feedback')).toContainText('价格同步成功', { timeout: 30_000 })

  const persistedResponse = await page.request.get('/api/v1/pricing/status')
  expect(persistedResponse.ok()).toBe(true)
  const persisted = await persistedResponse.json() as PricingStatus
  expect(persisted.latestRun?.status).toBe('succeeded')
  expect(persisted.latestRun?.runId).not.toBe(before.latestRun?.runId)
  expect(persisted.active?.source).toBe('fixture')
  expect(persisted.active?.meterCount).toBeGreaterThan(0)
  const persistedId = persisted.active!.snapshotId

  await page.reload()
  await expect(currentSnapshot(page)).toContainText(persistedId)
  await expect(page.getByTestId('pricing-fixture-notice')).toBeVisible()
  await expect(page.getByTestId('pricing-meter-count')).toHaveText(persisted.active!.meterCount.toLocaleString('zh-CN'))
  await expect(backups(page).locator('tbody tr').filter({ hasText: persistedId })).toContainText('当前使用')
  const historyResponse = await page.request.get('/api/v1/pricing/history?limit=10')
  expect(historyResponse.ok()).toBe(true)
  const history = await historyResponse.json() as PricingHistory
  expect(history.items.some((item) => item.snapshotId === persistedId)).toBe(true)
})
