import { createHash, randomUUID } from 'node:crypto'
import {
  comparePrices, nextPricingSyncUtc, normalizePrices, pricingFreshness,
  PricingValidationError,
  PRICING_PARSER_VERSION,
} from '@tokenusagealert/domain'
import {
  PricingSnapshotSchema,
  PricingStatusResponseSchema,
  type PricingSyncRun,
} from '@tokenusagealert/schemas'
import type { PricingSource } from './pricing-source.js'
import { snapshotSummary, type PricingStore } from './pricing-store.js'

export * from './pricing-source.js'
export * from './pricing-store.js'
export * from './manual-pricing-store.js'

export class PricingSyncFailedError extends Error {
  constructor(readonly run: PricingSyncRun) {
    super(run.error?.message ?? 'Pricing synchronization failed.')
    this.name = 'PricingSyncFailedError'
  }
}

export async function refreshStoredPricingModelMetadata(
  store: PricingStore,
  now = new Date(),
  signal: AbortSignal = AbortSignal.timeout(5 * 60_000),
) {
  return store.withLease(async (leaseSignal) => {
    const workSignal = AbortSignal.any([signal, leaseSignal])
    const active = await store.getActive()
    if (!active) throw new PricingValidationError('PRICE_SNAPSHOT_MISSING', 'No stored catalog exists for metadata normalization.')
    await store.ensureCompact(active.snapshot, workSignal)
    if (active.snapshot.parserVersion === PRICING_PARSER_VERSION) {
      return { changed: false, snapshot: active.snapshot }
    }
    const normalized = normalizePrices(active.snapshot.entries.map((entry) => entry.raw))
    const snapshot = PricingSnapshotSchema.parse({
      ...active.snapshot, snapshotId: randomUUID(), parserVersion: PRICING_PARSER_VERSION,
      normalizedAtUtc: now.toISOString(), sourceSnapshotId: active.snapshot.snapshotId,
      meterCount: normalized.entries.length, entries: normalized.entries,
      unsupportedMeterCount: normalized.entries.filter((entry) => entry.supportStatus !== 'supported').length,
      models: [...new Set(normalized.entries.flatMap((entry) => entry.modelName ? [entry.modelName] : []))].sort(),
      contentHash: createHash('sha256').update(JSON.stringify(normalized.entries)).digest('hex'),
      changes: comparePrices(active.snapshot, normalized.entries),
    })
    await store.publish(snapshot, active.etag, workSignal)
    const verified = await store.getActiveSummary()
    if (verified?.snapshotId !== snapshot.snapshotId || verified.contentHash !== snapshot.contentHash) {
      throw new Error('Normalized model metadata publication could not be verified.')
    }
    return { changed: true, snapshot }
  }, signal)
}

export class PricingSyncService {
  constructor(
    private readonly store: PricingStore,
    private readonly source: PricingSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(signal: AbortSignal = AbortSignal.timeout(25 * 60_000)): Promise<PricingSyncRun> {
    return this.store.withLease(async (leaseSignal) => {
      const workSignal = AbortSignal.any([signal, leaseSignal])
      const run: PricingSyncRun = {
        schemaVersion: 1, runId: randomUUID(), status: 'running',
        startedAtUtc: this.now().toISOString(), finishedAtUtc: null,
        source: this.source.name, snapshotId: null, pageCount: 0, recordCount: 0, error: null,
      }
      await this.store.writeRun(run, leaseSignal)
      let phase: 'storage' | 'download' | 'validation' = 'storage'
      try {
        const previous = await this.store.getActive()
        phase = 'download'
        const catalog = await this.source.fetchAll(workSignal)
        run.pageCount = catalog.pageCount
        run.recordCount = catalog.items.length
        phase = 'validation'
        const normalized = normalizePrices(catalog.items)
        const fetchedAtUtc = this.now().toISOString()
        const snapshot = PricingSnapshotSchema.parse({
          schemaVersion: 1, snapshotId: run.runId, fetchedAtUtc,
          source: this.source.name, apiVersion: '2023-01-01-preview', parserVersion: PRICING_PARSER_VERSION,
          currency: 'USD', cloud: 'AzureCloud',
          pageCount: catalog.pageCount, sourceRecordCount: catalog.items.length,
          meterCount: normalized.entries.length, duplicateCount: normalized.duplicateCount,
          unsupportedMeterCount: normalized.entries.filter((entry) => entry.supportStatus !== 'supported').length,
          unrecognizedUnitCount: normalized.entries.filter((entry) => entry.unit.kind === 'unknown').length,
          contentHash: createHash('sha256').update(JSON.stringify(normalized.entries)).digest('hex'),
          changes: comparePrices(previous?.snapshot ?? null, normalized.entries),
          entries: normalized.entries,
          models: [...new Set(normalized.entries.flatMap((entry) => entry.modelName ? [entry.modelName] : []))].sort(),
        })
        phase = 'storage'
        await this.store.publish(snapshot, previous?.etag ?? null, workSignal)
        run.snapshotId = snapshot.snapshotId
        const published = await this.store.getActiveSummary()
        if (published?.snapshotId !== snapshot.snapshotId || published.contentHash !== snapshot.contentHash) {
          throw new Error('Published snapshot verification failed.')
        }
        run.status = 'succeeded'
      } catch (error) {
        run.status = 'failed'
        run.error = error instanceof PricingValidationError
          ? { code: error.code, message: error.message }
          : {
              code: workSignal.aborted ? 'PRICING_SYNC_INTERRUPTED'
                : phase === 'download' ? 'PRICING_FETCH_ERROR'
                  : phase === 'validation' ? 'PRICING_VALIDATION_ERROR' : 'PRICING_STORAGE_ERROR',
              message: workSignal.aborted
                ? 'The pricing run timed out or lost its lease; no unvalidated data was published.'
                : phase === 'download' ? 'The pricing download failed; existing prices were retained.'
                  : phase === 'validation' ? 'The downloaded catalog failed validation; existing prices were retained.'
                    : 'Pricing storage or snapshot verification failed. Inspect the run and current snapshot before retrying.',
            }
        // Persist a failure only while this execution still owns the lease; never overwrite a newer run.
        leaseSignal.throwIfAborted()
      }
      run.finishedAtUtc = this.now().toISOString()
      await this.store.writeRun(run, leaseSignal)
      return run
    }, AbortSignal.timeout(28 * 60_000))
  }
}

export class InlinePricingSyncStarter {
  constructor(private readonly service: PricingSyncService) {}
  async start(): Promise<{ executionName: string }> {
    const run = await this.service.run()
    if (run.status === 'failed') throw new PricingSyncFailedError(run)
    return { executionName: run.runId }
  }
}

export async function getPricingStatus(store: PricingStore, now = new Date()) {
  const [active, latestRun] = await Promise.all([
    store.getActiveSummary(), store.getLatestRun(),
  ])
  return PricingStatusResponseSchema.parse({
    active, latestRun,
    ...pricingFreshness(active?.fetchedAtUtc ?? null, now),
    nextScheduledAtUtc: nextPricingSyncUtc(now), scheduleCronUtc: '0 16 * * *',
    businessTimeZone: 'Asia/Shanghai', retentionDays: 90, automaticUpdates: true,
  })
}

export { snapshotSummary }
