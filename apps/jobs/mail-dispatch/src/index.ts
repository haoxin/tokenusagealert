import { z } from 'zod'
import { createBlobServiceClient } from '@tokenusagealert/azure'
import { BlobAlertStore, GraphMailSender, MailDispatcher } from '@tokenusagealert/azure/alerts'
import { BlobPricingStore } from '@tokenusagealert/azure/pricing'
import { BlobUsageStore, StorageLeaseBusyError } from '@tokenusagealert/azure/usage'
import { AuthorizationSyncRunSchema, PricingSyncRunSchema } from '@tokenusagealert/schemas'

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  BLOB_ACCOUNT_URL: z.url().optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  MANAGED_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
  BLOB_AUTO_CREATE: z.enum(['true', 'false']).default('false'),
  MAIL_SENDER_MAILBOX: z.email().default('chx@ms-ext.biz'),
  MAIL_ALLOWED_DOMAINS: z.string().default('ms-ext.biz'),
  MAIL_AUTHORIZATION_READY: z.enum(['true', 'false']).default('false'),
  MAIL_PUBLIC_URL: z.url(),
  USAGE_SHARD_COUNT: z.coerce.number().int().min(1).max(16).default(1),
}).superRefine((value, context) => {
  if (!value.BLOB_ACCOUNT_URL && !value.AZURE_STORAGE_CONNECTION_STRING) context.addIssue({ code: 'custom', message: 'Storage is required.' })
  if (value.NODE_ENV === 'production' && (!value.MANAGED_IDENTITY_CLIENT_ID ||
    value.AZURE_STORAGE_CONNECTION_STRING || value.BLOB_AUTO_CREATE !== 'false')) {
    context.addIssue({ code: 'custom', message: 'Production mail requires provisioned Blob storage and a managed identity; shared keys and automatic container creation are forbidden.' })
  }
})

try {
  const config = configSchema.parse(process.env)
  const client = createBlobServiceClient({
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE === 'true',
  })
  const store = new BlobAlertStore(client, {
    senderMailbox: config.MAIL_SENDER_MAILBOX,
    allowedRecipientDomains: config.MAIL_ALLOWED_DOMAINS.split(',').map((item) => item.trim().toLowerCase()),
    mode: config.NODE_ENV === 'production' ? 'graph' : 'preview',
    authorizationReady: config.MAIL_AUTHORIZATION_READY === 'true',
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { authorizationIdentityId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
  })
  await store.initialize(config.BLOB_AUTO_CREATE === 'true')
  const pricing = new BlobPricingStore(client)
  const usage = new BlobUsageStore(client, { shardCount: config.USAGE_SHARD_COUNT })
  const sender = new GraphMailSender({
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { clientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    authorizationReady: store.policy.authorizationReady, publicUrl: config.MAIL_PUBLIC_URL,
  })
  const dispatcher = new MailDispatcher(store, sender, async () => {
    const issues: Array<{ code: string; message: string }> = []
    const [priceRunValue, authRunValue, snapshot, runs] = await Promise.all([
      store.operationalDocument('runs/pricing/latest.json'),
      store.operationalDocument('runs/authorization/latest.json'),
      pricing.getActiveSummary(), usage.allRuns(),
    ])
    if (!snapshot || Date.now() - Date.parse(snapshot.fetchedAtUtc) > 36 * 3_600_000) {
      issues.push({ code: 'PLATFORM_PRICE_STALE', message: '价格缺失或超过 36 小时未更新。' })
    }
    if (priceRunValue && PricingSyncRunSchema.parse(priceRunValue).status === 'failed') {
      issues.push({ code: 'PLATFORM_PRICE_SYNC_FAILED', message: '最近价格同步失败，请检查价格任务。' })
    }
    const authRun = authRunValue ? AuthorizationSyncRunSchema.parse(authRunValue) : null
    if (!authRun || authRun.status === 'failed' || Date.now() - Date.parse(authRun.startedAtUtc) > 2 * 3_600_000) {
      issues.push({ code: 'PLATFORM_AUTHORIZATION_SYNC_FAILED', message: '授权同步缺失、失败或超过两小时未更新。' })
    }
    if (runs.length < config.USAGE_SHARD_COUNT || runs.some((run) => run.status === 'failed' ||
      Date.now() - Date.parse(run.startedAtUtc) > 2 * 3_600_000)) {
      issues.push({ code: 'PLATFORM_USAGE_SYNC_FAILED', message: '部分用量分片缺失、失败或超过两小时未更新。' })
    }
    return issues
  })
  const run = await dispatcher.run()
  console.log(JSON.stringify({ event: 'mail.dispatch.completed', ...run }))
  if (run.status === 'failed') process.exitCode = 1
} catch (error) {
  const busy = error instanceof StorageLeaseBusyError
  console.error(JSON.stringify({ event: busy ? 'mail.dispatch.skipped' : 'mail.dispatch.failed',
    errorType: error instanceof Error ? error.name : 'UnknownError',
    message: busy ? 'Another mail dispatcher is running.' : 'Mail dispatcher could not finish; check Blob network access/data permissions, configuration and latest run.' }))
  if (!busy) process.exitCode = 1
}
