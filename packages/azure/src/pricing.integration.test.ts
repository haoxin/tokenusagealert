import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it, vi } from 'vitest'
import { BlobClient } from '@azure/storage-blob'
import { CompactPriceCatalogSchema, PricingSnapshotSchema, RetailPricePageSchema, type PricingSnapshot } from '@tokenusagealert/schemas'
import {
  BlobPricingStore, FixturePricingSource, PricingSyncService, PricingSyncBusyError,
  getPricingStatus, snapshotSummary, PricingDownloadChangedError, refreshStoredPricingModelMetadata, type PricingSource,
} from './pricing.js'
import { BlobManualPricingStore } from './manual-pricing-store.js'

const pages = (JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/retail-prices-pages.json', import.meta.url), 'utf8',
)) as unknown[]).map((page) => RetailPricePageSchema.parse(page))
const service = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const signal = () => AbortSignal.timeout(10_000)

async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { currentContainer: `price-${suffix}`, historyContainer: `history-${suffix}`,
    operationsContainer: `ops-${suffix}`, configurationContainer: `config-${suffix}` }
  const store = new BlobPricingStore(service, names)
  await store.initialize(true)
  await service.getContainerClient(names.configurationContainer).create()
  return {
    store, names,
    cleanup: async () => { await Promise.all(Object.values(names).map((name) => service.getContainerClient(name).delete())) },
  }
}

describe('private Blob pricing publication semantics (Azurite)', () => {
  it('publishes an immutable compact query catalog before activation and reads costs/downloads without downloading full raw JSON', async () => {
    const f = await fixture()
    try {
      const run = await new PricingSyncService(f.store, new FixturePricingSource(pages)).run()
      expect(run.status).toBe('succeeded')
      const active = (await f.store.getActive())!
      const download = BlobClient.prototype.download
      const read = vi.spyOn(BlobClient.prototype, 'download').mockImplementation(async function(this: BlobClient, offset, count, options) {
        if (this.url.endsWith('/aoai-pricing.json')) throw new Error('Full raw JSON must not be read on the query path')
        return download.call(this, offset, count, options)
      })
      try {
        const book = await f.store.getUsagePriceBook()
        expect(book.official).toMatchObject({ snapshotId: active.snapshot.snapshotId, rawEntryCount: 2, unitTokens: '1000000' })
        expect(book.manual.versions).toEqual([])
        const compact = (await f.store.getCompactDownload(signal()))!
        const chunks: Buffer[] = []
        for await (const chunk of compact.stream) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks)
        expect(body.length).toBe(compact.contentLength)
        const json = JSON.parse(body.toString())
        const { preference, manualRates, ...catalog } = json
        expect(preference).toBe('official-first')
        expect(manualRates).toEqual([])
        expect(CompactPriceCatalogSchema.parse(catalog)).toEqual(book.official)
        expect(json.entries).toBeUndefined()
        expect(body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(active.snapshot)))
      } finally { read.mockRestore() }
    } finally { await f.cleanup() }
  })

  it('includes source-labelled manual fallback heads in compact exports and changes the export ETag when manual configuration changes', async () => {
    const f = await fixture()
    try {
      await new PricingSyncService(f.store, new FixturePricingSource(pages)).run()
      const before = (await f.store.getCompactDownload(signal()))!
      before.stream.destroy()
      const manual = new BlobManualPricingStore(service, { configuration: f.names.configurationContainer, operations: f.names.operationsContainer })
      await manual.save({ modelName: 'gpt-6.1-sol', modelVersion: null, deploymentSku: 'GlobalStandard', regionScope: 'selected',
        regions: ['swedencentral'], inputUsdPerMillion: '3', outputUsdPerMillion: '7', note: 'Fixture, not real quote' }, null, 'fixture')
      const after = (await f.store.getCompactDownload(signal()))!
      expect(after.etag).not.toBe(before.etag)
      const chunks = []
      for await (const chunk of after.stream) chunks.push(Buffer.from(chunk))
      expect(JSON.parse(Buffer.concat(chunks).toString()).manualRates).toEqual([
        expect.objectContaining({ model: 'gpt-6.1-sol', source: 'manual-uniform', inputUsdPerMillion: '3', outputUsdPerMillion: '7' }),
      ])
      expect((await f.store.getUsagePriceBook()).manual.versions).toHaveLength(1)
    } finally { await f.cleanup() }
  })

  it('does not fall back to the heavy raw file when compact data is missing or its provenance is wrong', async () => {
    const f = await fixture()
    try {
      await new PricingSyncService(f.store, new FixturePricingSource(pages)).run()
      const active = (await f.store.getActive())!
      const blob = service.getContainerClient(f.names.currentContainer).getBlockBlobClient(`compact/v2/${active.snapshot.snapshotId}.json`)
      await blob.setMetadata({ sourcehash: 'b'.repeat(64) })
      await expect(f.store.getCompact()).rejects.toThrow(/active official snapshot/)
      await blob.delete()
      await expect(f.store.getUsagePriceBook()).rejects.toThrow(/compact catalog is missing/)
      await f.store.ensureCompact(active.snapshot, signal())
      expect((await f.store.getCompact())?.catalog.snapshotId).toBe(active.snapshot.snapshotId)
    } finally { await f.cleanup() }
  })

  it('keeps the old active snapshot when compact generation fails before a new publication', async () => {
    const f = await fixture()
    try {
      await new PricingSyncService(f.store, new FixturePricingSource(pages)).run()
      const active = (await f.store.getActive())!
      const compact = vi.spyOn(f.store, 'ensureCompact').mockRejectedValueOnce(new Error('Compact validation failed'))
      try {
        await expect(f.store.publish({ ...active.snapshot, snapshotId: randomUUID() }, active.etag, signal())).rejects.toThrow(/Compact validation failed/)
        expect(await f.store.getActive()).toEqual(active)
      } finally { compact.mockRestore() }
    } finally { await f.cleanup() }
  })

  it('repairs legacy stored model names with a backup, preserved fetch time and an independently versioned model index', async () => {
    const f = await fixture()
    try {
      await new PricingSyncService(f.store, new FixturePricingSource(pages), () => new Date('2026-10-01T16:00:00.000Z')).run()
      const current = (await f.store.getActive())!
      const legacy: PricingSnapshot = {
        ...current.snapshot, snapshotId: randomUUID(), parserVersion: 1, models: [],
        entries: current.snapshot.entries.map((entry) => ({ ...entry, modelName: null })),
      }
      await f.store.publish(legacy, current.etag, signal())
      const result = await refreshStoredPricingModelMetadata(f.store, new Date('2026-10-05T04:00:00.000Z'), signal())
      expect(result.changed).toBe(true)
      expect(result.snapshot).toMatchObject({
        parserVersion: 3, fetchedAtUtc: legacy.fetchedAtUtc, normalizedAtUtc: '2026-10-05T04:00:00.000Z',
        sourceSnapshotId: legacy.snapshotId, models: ['gpt-4.1'],
      })
      expect(result.snapshot.entries.map((entry) => entry.raw)).toEqual(legacy.entries.map((entry) => entry.raw))
      expect(result.snapshot.entries.map((entry) => entry.priceUsd)).toEqual(legacy.entries.map((entry) => entry.priceUsd))
      expect(result.snapshot.entries.every((entry) => entry.modelName === 'gpt-4.1' && entry.supportStatus === 'supported')).toBe(true)
      expect((await f.store.getActive())?.snapshot).toEqual(result.snapshot)
      expect((await f.store.listHistory(10, undefined, new Date('2026-10-05T04:00:00.000Z'))).items
        .some((entry) => entry.snapshotId === legacy.snapshotId)).toBe(true)
      expect((await refreshStoredPricingModelMetadata(f.store)).changed).toBe(false)
    } finally { await f.cleanup() }
  })

  it('streams the entire active JSON with matching metadata and refuses a concurrent snapshot overwrite', async () => {
    const f = await fixture()
    try {
      expect(await f.store.getActiveDownload(signal())).toBeNull()
      await new PricingSyncService(f.store, new FixturePricingSource(pages)).run()
      const active = (await f.store.getActive())!
      const download = (await f.store.getActiveDownload(signal()))!
      const chunks: Buffer[] = []
      for await (const chunk of download.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      expect(body.length).toBe(download.contentLength)
      expect(PricingSnapshotSchema.parse(JSON.parse(body.toString()))).toEqual(active.snapshot)
      expect(download.etag).toBe(active.etag)
      expect(download.summary.snapshotId).toBe(active.snapshot.snapshotId)
      const read = BlobClient.prototype.download
      let replaced = false
      const spy = vi.spyOn(BlobClient.prototype, 'download').mockImplementation(
        async function(this: BlobClient, offset, count, options) {
          if (!replaced && this.url.endsWith('/aoai-pricing.json')) {
            replaced = true
            await f.store.publish(active.snapshot, active.etag, signal())
          }
          return read.call(this, offset, count, options)
        },
      )
      try { await expect(f.store.getActiveDownload(signal())).rejects.toBeInstanceOf(PricingDownloadChangedError) }
      finally { spy.mockRestore() }
    } finally { await f.cleanup() }
  })

  it('backs up full pages, publishes automatically after a large price change, and reports freshness and pagination', async () => {
    const { store, names, cleanup } = await fixture()
    try {
      const firstDate = new Date('2026-10-01T16:00:00.000Z')
      const first = await new PricingSyncService(store, new FixturePricingSource(pages), () => firstDate).run()
      expect(first.status).toBe('succeeded')
      const active = await store.getActive()
      expect(active?.snapshot.entries).toHaveLength(2)
      expect(active?.snapshot.pageCount).toBe(2)
      const nextPages = pages.map((page) => ({ ...page, Items: page.Items.map((item) => ({ ...item, retailPrice: item.retailPrice * 2 })) }))
      const secondDate = new Date('2026-10-02T16:00:00.000Z')
      const second = await new PricingSyncService(store, new FixturePricingSource(nextPages), () => secondDate).run()
      const next = await store.getActive()
      expect(second.status).toBe('succeeded')
      expect(next?.snapshot.snapshotId).toBe(second.runId)
      expect(next?.snapshot.changes).toMatchObject({ changedPriceCount: 2, largestPriceChangePercent: '100.0000' })
      expect(next?.etag).not.toBe(active?.etag)
      const firstPage = await store.listHistory(1, undefined, secondDate)
      expect(firstPage.items[0]?.snapshotId).toBe(second.runId)
      const secondPage = await store.listHistory(1, firstPage.nextCursor!, secondDate)
      expect(secondPage.items[0]?.snapshotId).toBe(first.runId)
      expect(secondPage.nextCursor).toBeNull()
      expect((await getPricingStatus(store, new Date('2026-10-06T16:00:00Z'))).freshness).toBe('expired')
      expect((await store.listHistory(10, undefined, new Date('2027-02-01T00:00:00Z'))).items).toHaveLength(0)
      const raw = await service.getContainerClient(names.currentContainer).getBlobClient('aoai-pricing.json').downloadToBuffer()
      expect(JSON.parse(raw.toString()).entries[0].raw.productName).toBe('Azure OpenAI')
    } finally { await cleanup() }
  })

  it('keeps active ETag, content, and history unchanged on empty/partial/conflicting fetch failures', async () => {
    const { store, cleanup } = await fixture()
    try {
      await new PricingSyncService(store, new FixturePricingSource(pages)).run()
      const before = await store.getActive()
      const failures: PricingSource[] = [
        new FixturePricingSource([{ BillingCurrency: 'USD', Count: 0, Items: [], NextPageLink: null }]),
        new FixturePricingSource([pages[0]]),
        new FixturePricingSource([{ ...pages[0], NextPageLink: null, Count: 2, Items: [pages[0]!.Items[0], { ...pages[0]!.Items[0], retailPrice: 5 }] }]),
        { name: 'fixture', async fetchAll() { throw new Error('upstream failure') } },
      ]
      for (const source of failures) {
        expect((await new PricingSyncService(store, source).run()).status).toBe('failed')
        expect(await store.getActive()).toEqual(before)
        expect((await store.getLatestRun())?.error?.code).toBeTruthy()
        expect((await store.listHistory(10, undefined, new Date())).items).toHaveLength(1)
      }
    } finally { await cleanup() }
  })

  it('rejects concurrent lease ownership and releases the lease on failure', async () => {
    const { store, cleanup } = await fixture()
    try {
      await store.withLease(async () => {
        await expect(store.withLease(async () => 1, signal())).rejects.toBeInstanceOf(PricingSyncBusyError)
        return 0
      }, signal())
      await expect(store.withLease(async () => { throw new Error('test failure') }, signal())).rejects.toThrow('test failure')
      expect(await store.withLease(async () => 'released', signal())).toBe('released')
    } finally { await cleanup() }
  })

  it('refuses a stale ETag and does not overwrite an immutable backup', async () => {
    const { store, cleanup } = await fixture()
    try {
      await new PricingSyncService(store, new FixturePricingSource(pages)).run()
      const active = (await store.getActive())!
      const summary = snapshotSummary(active.snapshot)
      await store.publish(active.snapshot, active.etag, signal())
      const later = (await store.getActive())!
      const copy: PricingSnapshot = { ...active.snapshot, snapshotId: randomUUID() }
      await expect(store.publish(copy, active.etag, signal())).rejects.toMatchObject({ statusCode: 412 })
      expect((await store.getActive())?.snapshot.snapshotId).toBe(active.snapshot.snapshotId)
      await expect(store.publish({ ...active.snapshot, contentHash: '0'.repeat(64) }, later.etag, signal())).rejects.toThrow(/backup/)
      expect((await store.getActiveSummary())?.contentHash).toBe(summary.contentHash)
    } finally { await cleanup() }
  })

  it('does not publish without a successful backup and retains prices at the exact 90-day boundary', async () => {
    const { store, names, cleanup } = await fixture()
    try {
      const fetchedAt = new Date('2026-10-01T16:00:00Z')
      await new PricingSyncService(store, new FixturePricingSource(pages), () => fetchedAt).run()
      const before = await store.getActive()
      const atBoundary = new Date(fetchedAt.getTime() + 90 * 24 * 3_600_000)
      expect((await store.listHistory(10, undefined, atBoundary)).items).toHaveLength(1)
      expect((await store.listHistory(10, undefined, new Date(atBoundary.getTime() + 1))).items).toHaveLength(0)
      const noHistory = new BlobPricingStore(service, {
        ...names, historyContainer: `missing-${randomUUID().replaceAll('-', '')}`,
      })
      const failed = await new PricingSyncService(noHistory, new FixturePricingSource(pages)).run()
      expect(failed.status).toBe('failed')
      expect(failed.error?.code).toBe('PRICING_STORAGE_ERROR')
      expect(await store.getActive()).toEqual(before)
    } finally { await cleanup() }
  })

  it('does not convert a missing container into a healthy empty price catalog', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const store = new BlobPricingStore(service, { currentContainer: `absent-${suffix}` })
    await expect(store.getActiveSummary()).rejects.toMatchObject({ statusCode: 404 })
  })
})
