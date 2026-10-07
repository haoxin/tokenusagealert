import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import type { PricingSnapshotSummary, PricingStatusResponse } from '@tokenusagealert/schemas'

const summary: PricingSnapshotSummary = {
  schemaVersion: 1, snapshotId: '11111111-1111-4111-8111-111111111111',
  fetchedAtUtc: '2026-10-05T00:00:00.000Z', source: 'fixture', apiVersion: '2023-01-01-preview',
  parserVersion: 1, currency: 'USD', cloud: 'AzureCloud', pageCount: 1, sourceRecordCount: 2,
  meterCount: 2, duplicateCount: 0, unsupportedMeterCount: 2, unrecognizedUnitCount: 0,
  contentHash: 'a'.repeat(64),
  changes: { previousSnapshotId: null, addedMeterCount: 2, removedMeterCount: 0, changedPriceCount: 0,
    unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
}
async function mockStatus(page: Page, active: PricingSnapshotSummary | null) {
  const value: PricingStatusResponse = {
    active, latestRun: null, freshness: active ? 'fresh' : 'missing', ageHours: active ? 1 : null,
    nextScheduledAtUtc: '2026-10-05T16:00:00.000Z', scheduleCronUtc: '0 16 * * *',
    businessTimeZone: 'Asia/Shanghai', retentionDays: 90, automaticUpdates: true,
  }
  await page.route('**/api/v1/pricing/status', (route) => route.fulfill({ json: value }))
  await page.route(/\/api\/v1\/pricing\/history(?:\?|$)/, (route) => route.fulfill({ json: { items: [], nextCursor: null } }))
}

test('downloads the actual compact query catalog by default and preserves a separate full raw audit export', async ({ page }) => {
  const synchronized = await page.request.post('/api/v1/pricing/sync', {
    data: {}, headers: { accept: 'application/json' },
  })
  expect(synchronized.status()).toBe(202)
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '当前价格快照', exact: true })
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: '下载精简 SKU 价格 JSON', exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('aoai-pricing.json')
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  if (!path) throw new Error('Downloaded JSON file was not saved by the test browser')
  const downloaded = await readFile(path, 'utf8')
  const direct = await page.request.get('/api/v1/pricing/download')
  expect(direct.status()).toBe(200)
  expect(downloaded).toBe(await direct.text())
  expect(JSON.parse(downloaded)).toMatchObject({
    schemaVersion: 2, billingParserVersion: 3, kind: 'compact-official', currency: 'USD', unitTokens: '1000000',
    models: ['gpt-4.1'], preference: 'official-first',
    rates: expect.arrayContaining([expect.objectContaining({
      model: 'gpt-4.1', usd: '2', direction: 'input',
      regions: [{ name: 'swedencentral', meterId: '10000000-0000-4000-8000-000000000001' }],
    })]),
  })
  expect(JSON.parse(downloaded).entries).toBeUndefined()
  const rawDownloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: '下载原始/审计快照', exact: true }).click()
  const rawDownload = await rawDownloadPromise
  expect(rawDownload.suggestedFilename()).toBe('aoai-pricing-raw.json')
  const rawPath = await rawDownload.path()
  if (!rawPath) throw new Error('Raw audit download was not saved')
  const raw = await readFile(rawPath, 'utf8')
  expect(raw.length).toBeGreaterThan(downloaded.length)
  expect(raw).toBe(await (await page.request.get('/api/v1/pricing/download?format=raw')).text())
  expect(JSON.parse(raw)).toMatchObject({
    schemaVersion: 1, parserVersion: 3, models: ['gpt-4.1'],
    entries: expect.arrayContaining([expect.objectContaining({
      modelName: 'gpt-4.1', modelIdentityStatus: 'identified',
      raw: expect.objectContaining({ skuName: expect.any(String), unitOfMeasure: expect.any(String), meterName: expect.any(String) }),
    })]),
  })
})

test('missing snapshots disable the download rather than offering an empty file', async ({ page }) => {
  await mockStatus(page, null)
  let requests = 0
  page.on('request', (request) => { if (request.url().includes('/api/v1/pricing/download')) requests++ })
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '当前价格快照', exact: true })
  await expect(panel.getByRole('button', { name: '下载精简 SKU 价格 JSON', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: '下载原始/审计快照', exact: true })).toBeDisabled()
  await expect(panel).toContainText('价格同步成功后可下载精简目录')
  expect(requests).toBe(0)
})

test('download failures are shown explicitly and never saved as a success-shaped JSON attachment', async ({ page }) => {
  await mockStatus(page, summary)
  await page.route('**/api/v1/pricing/download?format=compact', (route) => route.fulfill({
    status: 503, contentType: 'application/problem+json', json: {
      type: 'about:blank', title: 'Download unavailable', status: 503, code: 'PRICE_DOWNLOAD_UNAVAILABLE',
      detail: '价格文件读取失败，请稍后重试；不会返回空文件。',
      instance: '/api/v1/pricing/download', correlationId: 'download-e2e',
    },
  }))
  let downloads = 0
  page.on('download', () => downloads++)
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '当前价格快照', exact: true })
  await panel.getByRole('button', { name: '下载精简 SKU 价格 JSON', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('价格文件读取失败')
  expect(downloads).toBe(0)
})
