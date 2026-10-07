import { z } from 'zod'
import { BlobTenantRepository, createBlobServiceClient } from '@tokenusagealert/azure'
import { BlobPricingStore } from '@tokenusagealert/azure/pricing'
import { usageExecutionFromEnvironment } from '@tokenusagealert/schemas'
import { tenantShard } from '@tokenusagealert/domain'
import { AlertProducer, BlobAlertStore } from '@tokenusagealert/azure/alerts'
import {
  ArmUsageSource, BlobUsageStore, EmptyUsageSource, overviewHour, StorageLeaseBusyError, UsageCollectionService, UsageTopologyMismatchError,
} from '@tokenusagealert/azure/usage'

const configSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  USAGE_SOURCE: z.enum(['azure-monitor', 'fixture']).default('azure-monitor'),
  USAGE_OPERATION: z.enum(['collect', 'reprice']).default('collect'),
  USAGE_REPRICE_TENANT_ID: z.string().uuid().optional(),
  USAGE_REPRICE_WINDOW_START_UTC: z.iso.datetime({ offset: true }).optional(),
  BLOB_ACCOUNT_URL: z.url().optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  MANAGED_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
  BLOB_AUTO_CREATE: z.enum(['true', 'false']).default('false'),
  MAIL_SENDER_MAILBOX: z.email().default('chx@ms-ext.biz'),
  MAIL_ALLOWED_DOMAINS: z.string().default('ms-ext.biz'),
}).superRefine((config, context) => {
  if (config.USAGE_OPERATION === 'reprice' &&
    (!config.USAGE_REPRICE_TENANT_ID || !config.USAGE_REPRICE_WINDOW_START_UTC)) {
    context.addIssue({ code: 'custom', message: 'One-time repricing requires an exact tenant and retained completed natural hour.' })
  }
  if (config.USAGE_OPERATION === 'collect' &&
    (config.USAGE_REPRICE_TENANT_ID || config.USAGE_REPRICE_WINDOW_START_UTC)) {
    context.addIssue({ code: 'custom', message: 'Historical repricing parameters must not be present on a normal scheduled collector.' })
  }
  if (!config.BLOB_ACCOUNT_URL && !config.AZURE_STORAGE_CONNECTION_STRING) {
    context.addIssue({ code: 'custom', message: 'Blob configuration is required.' })
  }
  if (config.NODE_ENV === 'production' && (config.USAGE_SOURCE !== 'azure-monitor' ||
    !config.MANAGED_IDENTITY_CLIENT_ID || config.AZURE_STORAGE_CONNECTION_STRING ||
    config.BLOB_AUTO_CREATE !== 'false' || !config.BLOB_ACCOUNT_URL?.startsWith('https://'))) {
    context.addIssue({ code: 'custom', message: 'Production requires real Monitor data, provisioned HTTPS Blob storage, and managed identity.' })
  }
})

try {
  const config = configSchema.parse(process.env)
  const execution = usageExecutionFromEnvironment(process.env)
  const options = {
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE === 'true',
  }
  const client = createBlobServiceClient(options)
  const tenants = new BlobTenantRepository(options)
  const usage = new BlobUsageStore(client, { shardId: execution.shardId, shardCount: execution.shardCount })
  await tenants.initialize()
  await usage.initialize(options.autoCreateContainers)
  const pricing = new BlobPricingStore(client)
  if (config.USAGE_OPERATION === 'reprice') {
    const tenantId = config.USAGE_REPRICE_TENANT_ID!
    const windowStart = config.USAGE_REPRICE_WINDOW_START_UTC!
    if (tenantShard(tenantId, execution.shardCount) !== execution.shardId) throw new Error('Requested tenant belongs to another usage shard.')
    const result = await usage.withLease(async (leaseSignal) =>
      tenants.withTenantAuthorizationLease(tenantId, async (tenantSignal) => {
        const signal = AbortSignal.any([leaseSignal, tenantSignal])
        const tenant = await tenants.getTenant(tenantId)
        if (!['active', 'degraded'].includes(tenant.status)) throw new Error('Only a currently managed tenant can have missing prices repaired.')
        const hour = (await usage.hours(tenantId, 240)).find((item) => item.windowStartUtc === windowStart)
        if (!hour?.priceSnapshotId) throw new Error('The original real usage hour or its price snapshot is missing.')
        const book = await pricing.getUsagePriceBookForSnapshot(hour.priceSnapshotId)
        const repriced = await usage.repriceMissingHour(tenantId, windowStart, book, config.MANAGED_IDENTITY_CLIENT_ID ?? 'local-fixture', signal)
        if (repriced.auditId !== null) {
          const alertStore = new BlobAlertStore(client, {
            senderMailbox: config.MAIL_SENDER_MAILBOX,
            allowedRecipientDomains: config.MAIL_ALLOWED_DOMAINS.split(',').map((item) => item.trim().toLowerCase()),
            mode: config.NODE_ENV === 'production' ? 'graph' : 'preview', authorizationReady: false,
          })
          await new AlertProducer(alertStore).repriced(tenant, repriced.before, repriced.hour)
        }
        const view = (await usage.views()).find((item) => item.shardId === execution.shardId)
        if (view) {
          const hours = (await usage.hours(tenantId, 24)).map(overviewHour)
          await usage.saveView({ ...view, generatedAtUtc: new Date().toISOString(), tenants: view.tenants.map((row) =>
            row.tenantId !== tenantId ? row : { ...row, hours, latest: hours.find((item) => item.windowStartUtc === view.windowStartUtc) ?? null }) }, signal)
        }
        return repriced
      }), AbortSignal.timeout(5 * 60_000))
    console.log(JSON.stringify({
      event: 'usage.missing-price.repricing.completed', changed: result.changed, auditId: result.auditId,
      tenantId, windowStartUtc: windowStart, knownCostUsd: result.hour.knownCostUsd,
      knownCostUpperUsd: result.hour.knownCostUpperUsd, ruleVersion: result.hour.pricingRuleVersion,
      tokenCountsUnchanged: true, currentAlertStateRewritten: false,
    }))
  } else {
  const source = config.USAGE_SOURCE === 'azure-monitor'
    ? new ArmUsageSource(config.MANAGED_IDENTITY_CLIENT_ID, { execution })
    : new EmptyUsageSource()
  const alertStore = new BlobAlertStore(client, {
    senderMailbox: config.MAIL_SENDER_MAILBOX,
    allowedRecipientDomains: config.MAIL_ALLOWED_DOMAINS.split(',').map((item) => item.trim().toLowerCase()),
    mode: config.NODE_ENV === 'production' ? 'graph' : 'preview', authorizationReady: false,
  })
  const alerts = new AlertProducer(alertStore)
  const run = await new UsageCollectionService(tenants, usage, pricing, source, { execution, alerts }).run()
  console.log(JSON.stringify({ event: 'usage.collection.completed', ...run }))
  if (run.status === 'failed') process.exitCode = 1
  }
} catch (error) {
  const busy = error instanceof StorageLeaseBusyError
  console.error(JSON.stringify({
    event: busy ? 'usage.collection.skipped' : 'usage.collection.failed',
    code: busy ? 'USAGE_BUSY' : 'USAGE_STARTUP_FAILED',
    errorType: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof UsageTopologyMismatchError ? error.message
      : busy ? 'Another usage Job is running; no overlapping writes were performed.'
      : 'Usage Job failed; inspect configuration, Blob network access/data permissions and the latest run.',
  }))
  if (!busy) process.exitCode = 1
}
