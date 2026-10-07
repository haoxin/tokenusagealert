import { randomUUID } from 'node:crypto'
import { expect, test, type Locator } from '@playwright/test'
import type { ManualPriceListResponse } from '@tokenusagealert/schemas'

async function fill(editor: Locator, model: string) {
  await editor.getByRole('textbox', { name: /^模型名称/ }).fill(model)
  await editor.getByRole('textbox', { name: /^输入单价/ }).fill('2.50')
  await editor.getByRole('textbox', { name: /^输出单价/ }).fill('8.75')
}

test('creates, edits, reloads and disables real local manual-price JSON with explicit next-hour and official-first semantics', async ({ page }) => {
  expect((await page.request.post('/api/v1/pricing/sync', { data: {}, headers: { accept: 'application/json' } })).status()).toBe(202)
  const model = `mock-text-ui-${randomUUID().slice(0, 8)}`
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '手动价格管理', exact: true })
  await expect(panel).toContainText('官方优先，手动只补缺价')
  await expect(panel).toContainText('不是官方报价或实际账单')
  await panel.getByRole('button', { name: '新增手动价格', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增手动价格', exact: true })
  await expect(editor.getByRole('checkbox', { name: '明确适用所有区域', exact: true })).not.toBeChecked()
  await fill(editor, model)
  await editor.getByRole('button', { name: '保存手动价格', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('区域')
  await editor.getByRole('combobox', { name: '添加适用区域', exact: true }).selectOption('swedencentral')
  await editor.getByRole('textbox', { name: '价格来源 / 备注', exact: true }).fill('纯本地端到端测试，不是真实报价')
  await editor.getByRole('button', { name: '保存手动价格', exact: true }).click()
  await expect(editor).not.toBeVisible()
  const row = panel.locator('tbody tr').filter({ hasText: model })
  await expect(row).toContainText('$2.50 / $8.75')
  await expect(row).toContainText('swedencentral')
  await expect(row).toContainText('待生效')
  await expect(panel.getByRole('status')).toContainText('起生效')
  let current = await (await page.request.get('/api/v1/settings/manual-pricing')).json() as ManualPriceListResponse
  const created = current.items.find((item) => item.modelName === model)!
  expect(created).toMatchObject({ modelVersion: null, regionScope: 'selected', regions: ['swedencentral'],
    inputUsdPerMillion: '2.50', outputUsdPerMillion: '8.75', revision: 1 })
  expect(new Date(created.effectiveFromUtc).getUTCMinutes()).toBe(0)
  expect(new Date(created.effectiveFromUtc).getUTCSeconds()).toBe(0)
  const exported = await (await page.request.get('/api/v1/pricing/download')).json()
  expect(exported.manualRates).toContainEqual(expect.objectContaining({
    model, source: 'manual-uniform', inputUsdPerMillion: '2.50', regionScope: 'selected',
  }))

  await row.getByRole('button', { name: `编辑 ${model} 手动价格`, exact: true }).click()
  const edit = page.getByRole('dialog', { name: '编辑手动价格', exact: true })
  await edit.getByRole('textbox', { name: /^输入单价/ }).fill('4.25')
  await edit.getByRole('checkbox', { name: '明确适用所有区域', exact: true }).check()
  await edit.getByRole('button', { name: '保存手动价格', exact: true }).click()
  await expect(row).toContainText('$4.25 / $8.75')
  await expect(row).toContainText('所有区域 · 用户明确指定')
  await page.reload()
  await expect(row).toContainText('$4.25 / $8.75')
  current = await (await page.request.get('/api/v1/settings/manual-pricing')).json() as ManualPriceListResponse
  expect(current.items.find((item) => item.modelName === model)).toMatchObject({ ruleId: created.ruleId, revision: 2, regionScope: 'all', regions: [] })

  await row.getByRole('button', { name: `停用 ${model} 手动价格`, exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('历史版本保留')
  await expect(row).toContainText(/待停用|已停用/)
  await expect(row.getByRole('button', { name: `停用 ${model} 手动价格`, exact: true })).toHaveCount(0)
  const stopped = await (await page.request.get('/api/v1/settings/manual-pricing')).json() as ManualPriceListResponse
  expect(stopped.items.find((item) => item.ruleId === created.ruleId)).toMatchObject({ enabled: false, revision: 3 })
})

test('manual prices for official-priced models display the official-first warning rather than pretending to override', async ({ page }) => {
  expect((await page.request.post('/api/v1/pricing/sync', { data: {}, headers: { accept: 'application/json' } })).status()).toBe(202)
  const version = `e2e-${randomUUID().slice(0, 8)}`
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '手动价格管理', exact: true })
  await panel.getByRole('button', { name: '新增手动价格', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增手动价格', exact: true })
  await fill(editor, 'gpt-4.1')
  await editor.getByRole('textbox', { name: /^模型版本/ }).fill(version)
  await editor.getByRole('combobox', { name: '添加适用区域', exact: true }).selectOption('swedencentral')
  await editor.getByRole('button', { name: '保存手动价格', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('相同范围已有官方价格')
  const row = panel.locator('tbody tr').filter({ hasText: 'gpt-4.1' }).filter({ hasText: version })
  await expect(row).toContainText('官方优先')
  await row.getByRole('button', { name: '停用 gpt-4.1 手动价格', exact: true }).click()
  await expect(row).toContainText(/待停用|已停用/)
})

test('stale concurrent edits remain in the drawer and cannot overwrite another operator', async ({ page }) => {
  const model = `mock-stale-ui-${randomUUID().slice(0, 8)}`
  let data = await (await page.request.get('/api/v1/settings/manual-pricing')).json() as ManualPriceListResponse
  const input = { modelName: model, modelVersion: null, deploymentSku: 'GlobalStandard', regionScope: 'selected',
    regions: ['swedencentral'], inputUsdPerMillion: '2.50', outputUsdPerMillion: '8.75', note: 'Local-only concurrency fixture' }
  const saved = await page.request.post('/api/v1/settings/manual-pricing', {
    data: input, headers: data.etag ? { 'if-match': data.etag } : { 'if-none-match': '*' },
  })
  expect(saved.status()).toBe(201)
  const id = (await saved.json()).item.ruleId
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '手动价格管理', exact: true })
  const row = panel.locator('tbody tr').filter({ hasText: model })
  await row.getByRole('button', { name: `编辑 ${model} 手动价格`, exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑手动价格', exact: true })
  await editor.getByRole('textbox', { name: /^输入单价/ }).fill('99')
  data = await (await page.request.get('/api/v1/settings/manual-pricing')).json() as ManualPriceListResponse
  const concurrent = await page.request.patch(`/api/v1/settings/manual-pricing/${id}`, {
    data: { ...input, inputUsdPerMillion: '4.50' }, headers: { 'if-match': data.etag! },
  })
  expect(concurrent.status()).toBe(200)
  await editor.getByRole('button', { name: '保存手动价格', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('手动价格配置已变化')
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await panel.getByRole('button', { name: '刷新手动价格', exact: true }).click()
  await expect(row).toContainText('$4.50 / $8.75')
})

test('failed configuration reads show an explicit error and disable creation rather than claiming an empty price book', async ({ page }) => {
  await page.route('**/api/v1/settings/manual-pricing', (route) => route.fulfill({
    status: 503, contentType: 'application/problem+json', json: {
      type: 'about:blank', title: 'Manual pricing unavailable', status: 503, code: 'MANUAL_PRICE_READ_FAILED',
      detail: '无法读取价格配置，请稍后重试；不会显示成空价格列表。',
      instance: '/api/v1/settings/manual-pricing', correlationId: 'manual-read-e2e',
    },
  }))
  await page.goto('/settings')
  const panel = page.getByRole('region', { name: '手动价格管理', exact: true })
  await expect(panel.getByRole('alert')).toContainText('无法读取价格配置')
  await expect(panel.getByRole('button', { name: '新增手动价格', exact: true })).toBeDisabled()
  await expect(panel).not.toContainText('尚无手动价格')
})
