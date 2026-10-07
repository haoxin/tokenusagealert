import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { compactOfficialPrices } from '@tokenusagealert/domain'
import { StorageLeaseBusyError, withBlobLease } from './blob-lease.js'
import {
  PricingSnapshotSchema,
  PricingSnapshotSummarySchema,
  PricingSyncRunSchema,
  CompactPriceCatalogSchema,
  type CompactPriceCatalog,
  type UsagePriceBook,
  type PricingHistoryResponse,
  type PricingSnapshot,
  type PricingSnapshotSummary,
  type PricingSyncRun,
} from '@tokenusagealert/schemas'
import { BlobManualPricingStore, manualPriceHeads } from './manual-pricing-store.js'

const ACTIVE_NAME = 'aoai-pricing.json'
const LATEST_RUN_NAME = 'runs/pricing/latest.json'
const LOCK_NAME = 'locks/pricing'
const RETENTION_MS = 90 * 24 * 3_600_000

export class PricingSyncBusyError extends Error {
  constructor() {
    super('A pricing synchronization already holds the Blob lease.')
    this.name = 'PricingSyncBusyError'
  }
}

export class PricingDownloadChangedError extends Error {
  constructor() { super('The active pricing snapshot changed while preparing the download.'); this.name = 'PricingDownloadChangedError' }
}

export interface PricingDownload {
  stream: Readable
  summary: PricingSnapshotSummary
  etag: string
  contentLength: number
}

export interface PricingStore {
  withLease<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>
  getActive(): Promise<{ snapshot: PricingSnapshot; etag: string } | null>
  getActiveSummary(): Promise<PricingSnapshotSummary | null>
  getActiveDownload(signal: AbortSignal): Promise<PricingDownload | null>
  getCompact(): Promise<{ catalog: CompactPriceCatalog; etag: string } | null>
  getUsagePriceBook(): Promise<UsagePriceBook>
  getUsagePriceBookForSnapshot(snapshotId: string): Promise<UsagePriceBook>
  getCompactDownload(signal: AbortSignal): Promise<PricingDownload | null>
  ensureCompact(snapshot: PricingSnapshot, signal: AbortSignal): Promise<void>
  publish(snapshot: PricingSnapshot, expectedEtag: string | null, signal: AbortSignal): Promise<void>
  writeRun(run: PricingSyncRun, signal: AbortSignal): Promise<void>
  getLatestRun(): Promise<PricingSyncRun | null>
  listHistory(limit: number, cursor: string | undefined, now: Date): Promise<PricingHistoryResponse>
}

function storageCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  const code: unknown = Reflect.get(error, 'code')
  if (typeof code === 'string') return code
  const details: unknown = Reflect.get(error, 'details')
  return details && typeof details === 'object' ? Reflect.get(details, 'errorCode') : undefined
}

function isBlobMissing(error: unknown): boolean {
  return storageCode(error) === 'BlobNotFound'
}

export function snapshotSummary(snapshot: PricingSnapshot): PricingSnapshotSummary {
  const { entries: _entries, models: _models, ...summary } = snapshot
  return PricingSnapshotSummarySchema.parse(summary)
}

function historyName(summary: PricingSnapshotSummary): string {
  const date = new Date(summary.fetchedAtUtc).toISOString()
  return `${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}/aoai-pricing-${date.replaceAll(':', '-')}-${summary.snapshotId}.json`
}

function summaryMetadata(summary: PricingSnapshotSummary): Record<string, string> {
  return { summary: Buffer.from(JSON.stringify(summary)).toString('base64') }
}

function readMetadata(metadata: Record<string, string> | undefined): PricingSnapshotSummary {
  if (!metadata?.summary) throw new Error('Pricing Blob is missing snapshot summary metadata.')
  const body: unknown = JSON.parse(Buffer.from(metadata.summary, 'base64').toString('utf8'))
  return PricingSnapshotSummarySchema.parse(body)
}

async function readBlobJson(container: ContainerClient, name: string) {
  const blob = container.getBlobClient(name)
  const properties = await blob.getProperties()
  if (!properties.etag) throw new Error(`Missing ETag for ${name}.`)
  const body = await blob.downloadToBuffer(0, undefined, {
    conditions: { ifMatch: properties.etag },
  })
  const value: unknown = JSON.parse(body.toString('utf8'))
  return { value, etag: properties.etag, metadata: properties.metadata }
}

export interface BlobPricingStoreOptions {
  currentContainer?: string
  historyContainer?: string
  operationsContainer?: string
  configurationContainer?: string
}

export class BlobPricingStore implements PricingStore {
  private readonly current: ContainerClient
  private readonly history: ContainerClient
  private readonly operations: ContainerClient
  private readonly manual: BlobManualPricingStore

  constructor(service: BlobServiceClient, options: BlobPricingStoreOptions = {}) {
    this.current = service.getContainerClient(options.currentContainer ?? 'pricing-current')
    this.history = service.getContainerClient(options.historyContainer ?? 'pricing-history')
    this.operations = service.getContainerClient(options.operationsContainer ?? 'operations')
    this.manual = new BlobManualPricingStore(service, {
      ...(options.configurationContainer ? { configuration: options.configurationContainer } : {}),
      ...(options.operationsContainer ? { operations: options.operationsContainer } : {}),
    })
  }

  async initialize(autoCreate: boolean): Promise<void> {
    if (autoCreate) {
      await Promise.all([
        this.current.createIfNotExists(), this.history.createIfNotExists(),
        this.operations.createIfNotExists(),
      ])
    }
    await this.checkReady()
  }

  async checkReady(): Promise<void> {
    await Promise.all([
      this.current.getProperties(), this.history.getProperties(),
      this.operations.getProperties(),
    ])
  }

  async withLease<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await withBlobLease(this.operations, LOCK_NAME, operation, signal)
    } catch (error) {
      if (error instanceof StorageLeaseBusyError) throw new PricingSyncBusyError()
      throw error
    }
  }

  async getActive() {
    try {
      const { value, etag } = await readBlobJson(this.current, ACTIVE_NAME)
      return { snapshot: PricingSnapshotSchema.parse(value), etag }
    } catch (error) {
      if (isBlobMissing(error)) return null
      throw error
    }
  }

  async getActiveSummary() {
    try {
      const properties = await this.current.getBlobClient(ACTIVE_NAME).getProperties()
      return readMetadata(properties.metadata)
    } catch (error) {
      if (isBlobMissing(error)) return null
      throw error
    }
  }

  async getCompact(): Promise<{ catalog: CompactPriceCatalog; etag: string } | null> {
    const summary = await this.getActiveSummary()
    if (!summary) return null
    try {
      let stored
      try { stored = await readBlobJson(this.current, `compact/v2/${summary.snapshotId}.json`) }
      catch (error) {
        if (!isBlobMissing(error)) throw error
        stored = await readBlobJson(this.current, `compact/${summary.snapshotId}.json`)
      }
      const catalog = CompactPriceCatalogSchema.parse(stored.value)
      if (catalog.snapshotId !== summary.snapshotId || catalog.fetchedAtUtc !== summary.fetchedAtUtc ||
        stored.metadata?.sourcehash !== summary.contentHash) {
        throw new Error('Compact pricing does not belong to the active official snapshot.')
      }
      return { catalog, etag: stored.etag }
    } catch (error) {
      if (isBlobMissing(error)) throw new Error('The active compact catalog is missing; regenerate it before calculating costs.')
      throw error
    }
  }

  async getUsagePriceBook(): Promise<UsagePriceBook> {
    const [official, manual] = await Promise.all([this.getCompact(), this.manual.read()])
    return { kind: 'usage-price-book', official: official?.catalog ?? null, manual: manual.document }
  }

  async getUsagePriceBookForSnapshot(snapshotId: string): Promise<UsagePriceBook> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId)) {
      throw new Error('Invalid historical price snapshot ID.')
    }
    const [stored, manual] = await Promise.all([
      readBlobJson(this.current, `compact/v2/${snapshotId}.json`), this.manual.read(),
    ])
    const catalog = CompactPriceCatalogSchema.parse(stored.value)
    const summary = readMetadata(stored.metadata)
    if (catalog.schemaVersion !== 2 || catalog.snapshotId !== snapshotId ||
      catalog.fetchedAtUtc !== summary.fetchedAtUtc || stored.metadata?.sourcehash !== summary.contentHash) {
      throw new Error('Historical compact pricing provenance does not match the recorded source.')
    }
    return { kind: 'usage-price-book', official: catalog, manual: manual.document }
  }

  async ensureCompact(snapshot: PricingSnapshot, signal: AbortSignal): Promise<void> {
    const blob = this.current.getBlockBlobClient(`compact/v2/${snapshot.snapshotId}.json`)
    try {
      const properties = await blob.getProperties({ abortSignal: signal })
      if (properties.metadata?.sourcehash !== snapshot.contentHash) throw new Error('Existing compact catalog has inconsistent source provenance.')
      return
    } catch (error) { if (!isBlobMissing(error)) throw error }
    const catalog = compactOfficialPrices(snapshot)
    const body = JSON.stringify(catalog)
    try {
      await blob.upload(body, Buffer.byteLength(body), {
        conditions: { ifNoneMatch: '*' }, abortSignal: signal,
        metadata: { sourcehash: snapshot.contentHash, ...summaryMetadata(snapshotSummary(snapshot)) },
        blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      })
    } catch (error) {
      if (['BlobAlreadyExists', 'ConditionNotMet'].includes(String(storageCode(error)))) {
        const properties = await blob.getProperties({ abortSignal: signal })
        if (properties.metadata?.sourcehash === snapshot.contentHash) return
      }
      throw error
    }
  }

  async getCompactDownload(signal: AbortSignal): Promise<PricingDownload | null> {
    signal.throwIfAborted()
    const [compact, summary, manual] = await Promise.all([this.getCompact(), this.getActiveSummary(), this.manual.read()])
    if (!compact || !summary) return null
    if (compact.catalog.snapshotId !== summary.snapshotId) throw new PricingDownloadChangedError()
    const manualRates = manualPriceHeads(manual.document).map((item) => ({
      id: item.ruleId, revision: item.revision, model: item.modelName, modelVersion: item.modelVersion,
      sku: item.deploymentSku, regionScope: item.regionScope, regions: item.regions,
      inputUsdPerMillion: item.inputUsdPerMillion, outputUsdPerMillion: item.outputUsdPerMillion,
      effectiveFromUtc: item.effectiveFromUtc, enabled: item.enabled, source: 'manual-uniform',
    }))
    const body = JSON.stringify({ ...compact.catalog, preference: 'official-first', manualRates })
    return { stream: Readable.from([body]), summary, etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      contentLength: Buffer.byteLength(body) }
  }

  async getActiveDownload(signal: AbortSignal): Promise<PricingDownload | null> {
    const blob = this.current.getBlobClient(ACTIVE_NAME)
    let properties
    try { properties = await blob.getProperties({ abortSignal: signal }) }
    catch (error) { if (isBlobMissing(error)) return null; throw error }
    if (!properties.etag || properties.contentLength === undefined || properties.contentLength <= 0) {
      throw new Error('Pricing download requires an ETag and a non-empty stored snapshot.')
    }
    const summary = readMetadata(properties.metadata)
    try {
      const response = await blob.download(0, undefined, { conditions: { ifMatch: properties.etag }, abortSignal: signal })
      if (!(response.readableStreamBody instanceof Readable)) throw new Error('Pricing download did not return a readable stream.')
      return { stream: response.readableStreamBody, summary, etag: properties.etag, contentLength: properties.contentLength }
    } catch (error) {
      if (storageCode(error) === 'ConditionNotMet') throw new PricingDownloadChangedError()
      throw error
    }
  }

  async publish(snapshotInput: PricingSnapshot, expectedEtag: string | null, signal: AbortSignal) {
    const snapshot = PricingSnapshotSchema.parse(snapshotInput)
    const summary = snapshotSummary(snapshot)
    const body = JSON.stringify(snapshot)
    const options = {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      metadata: summaryMetadata(summary),
      abortSignal: signal,
    }
    signal.throwIfAborted()
    const backup = this.history.getBlockBlobClient(historyName(summary))
    try {
      await backup.upload(body, Buffer.byteLength(body), {
        ...options, conditions: { ifNoneMatch: '*' },
      })
    } catch (error) {
      if (!['BlobAlreadyExists', 'ConditionNotMet'].includes(String(storageCode(error)))) throw error
      const existing = readMetadata((await backup.getProperties()).metadata)
      if (existing.contentHash !== summary.contentHash || existing.snapshotId !== summary.snapshotId) {
        throw new Error('Existing pricing backup does not match the attempted snapshot.')
      }
    }
    await this.ensureCompact(snapshot, signal)
    // Both derived query data and the backup precede the conditional active pointer.
    signal.throwIfAborted()
    await this.current.getBlockBlobClient(ACTIVE_NAME).upload(body, Buffer.byteLength(body), {
      ...options,
      conditions: expectedEtag ? { ifMatch: expectedEtag } : { ifNoneMatch: '*' },
    })
  }

  async writeRun(runInput: PricingSyncRun, signal: AbortSignal) {
    const run = PricingSyncRunSchema.parse(runInput)
    const body = JSON.stringify(run)
    const options = {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      abortSignal: signal,
    }
    for (const name of [`runs/pricing/history/${run.runId}.json`, LATEST_RUN_NAME]) {
      signal.throwIfAborted()
      const blob = this.operations.getBlockBlobClient(name)
      let etag: string | null = null
      try {
        const properties = await blob.getProperties()
        if (!properties.etag) throw new Error(`Missing ETag for ${name}.`)
        etag = properties.etag
      } catch (error) {
        if (!isBlobMissing(error)) throw error
      }
      await blob.upload(body, Buffer.byteLength(body), {
        ...options, conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      })
    }
  }

  async getLatestRun() {
    try {
      return PricingSyncRunSchema.parse((await readBlobJson(this.operations, LATEST_RUN_NAME)).value)
    } catch (error) {
      if (isBlobMissing(error)) return null
      throw error
    }
  }

  async listHistory(limit: number, cursor: string | undefined, now: Date): Promise<PricingHistoryResponse> {
    const items: PricingSnapshotSummary[] = []
    for await (const blob of this.history.listBlobsFlat({ includeMetadata: true })) {
      if (!blob.name.endsWith('.json')) continue
      const summary = readMetadata(blob.metadata)
      if (Date.parse(summary.fetchedAtUtc) < now.getTime() - RETENTION_MS) continue
      items.push(summary)
    }
    items.sort((a, b) =>
      b.fetchedAtUtc.localeCompare(a.fetchedAtUtc) || b.snapshotId.localeCompare(a.snapshotId),
    )
    // The cursor is a stable (timestamp,id) pair, so an intervening new snapshot cannot shift later pages.
    const after = cursor ? items.filter((item) => `${item.fetchedAtUtc}|${item.snapshotId}` < cursor) : items
    const page = after.slice(0, limit)
    const last = page[page.length - 1]
    return {
      items: page,
      nextCursor: after.length > page.length && last ? `${last.fetchedAtUtc}|${last.snapshotId}` : null,
    }
  }
}
