import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createBlobServiceClient } from '@tokenusagealert/azure'
import {
  BlobPricingStore, FixturePricingSource, PricingSyncBusyError,
  PricingSyncService, RetailPricesClient,
  refreshStoredPricingModelMetadata,
} from '@tokenusagealert/azure/pricing'
import { PricingJobConfigSchema } from './config.js'

const shutdown = new AbortController()
process.once('SIGTERM', () => shutdown.abort(new Error('SIGTERM')))
process.once('SIGINT', () => shutdown.abort(new Error('SIGINT')))

try {
  const config = PricingJobConfigSchema.parse(process.env)
  const client = createBlobServiceClient({
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE,
  })
  const store = new BlobPricingStore(client)
  await store.initialize(config.BLOB_AUTO_CREATE)
  if (config.PRICING_METADATA_ONLY) {
    const result = await refreshStoredPricingModelMetadata(store, new Date(),
      AbortSignal.any([shutdown.signal, AbortSignal.timeout(5 * 60_000)]))
    console.log(JSON.stringify({
      event: 'pricing.model-metadata.completed', changed: result.changed,
      snapshotId: result.snapshot.snapshotId, parserVersion: result.snapshot.parserVersion,
      fetchedAtUtc: result.snapshot.fetchedAtUtc, normalizedAtUtc: result.snapshot.normalizedAtUtc,
      total: result.snapshot.entries.length,
      identified: result.snapshot.entries.filter((entry) => entry.modelName !== null).length,
    }))
  } else {
    const source = config.PRICING_SOURCE === 'azure-retail'
      ? new RetailPricesClient()
      : new FixturePricingSource(z.array(z.unknown()).parse(
          JSON.parse(await readFile(config.PRICING_FIXTURE_PATH!, 'utf8')),
        ))
    const run = await new PricingSyncService(store, source).run(
      AbortSignal.any([shutdown.signal, AbortSignal.timeout(25 * 60_000)]),
    )
    console.log(JSON.stringify({ event: 'pricing.sync.completed', ...run }))
    if (run.status === 'failed') process.exitCode = 1
  }
} catch (error) {
  const busy = error instanceof PricingSyncBusyError
  console.error(JSON.stringify({
    event: busy ? 'pricing.sync.skipped' : 'pricing.sync.failed',
    code: busy ? 'PRICING_SYNC_BUSY' : 'PRICING_JOB_FAILED',
    errorType: error instanceof Error ? error.name : 'UnknownError',
    message: busy
      ? 'Another execution owns the pricing lease; this execution made no changes.'
      : 'Pricing Job failed before recording its completion. Inspect configuration, identity, storage availability, and latest run.',
  }))
  if (!busy) process.exitCode = 1
}
