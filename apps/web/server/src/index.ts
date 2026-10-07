import { BlobTenantRepository, createBlobServiceClient } from '@tokenusagealert/azure'
import { readFileSync } from 'node:fs'
import {
  ArmContainerAppsJobStarter,
  AuthorizationSyncService,
  FixtureSubscriptionDiscovery,
  InlineAuthorizationSyncStarter,
} from '@tokenusagealert/azure/authorization'
import { z } from 'zod'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import {
  BlobManualPricingStore, BlobPricingStore, FixturePricingSource, InlinePricingSyncStarter, PricingSyncService,
} from '@tokenusagealert/azure/pricing'
import type { PricingRoutesOptions } from './pricing-routes.js'
import type { ManualPricingRoutesOptions } from './manual-pricing-routes.js'
import { BlobUsageStore, EmptyUsageSource, InlineUsageStarter, UsageCollectionService, ShardedUsageStarter } from '@tokenusagealert/azure/usage'
import { usageExecutionFromEnvironment } from '@tokenusagealert/schemas'
import type { UsageRoutesOptions } from './usage-routes.js'
import { AlertProducer, BlobAlertStore, GraphMailSender, MailDispatcher } from '@tokenusagealert/azure/alerts'
import type { MailRoutesOptions } from './mail-routes.js'
import { ArmDelegationRemovalClient, BlobOffboardingStore, OffboardingService } from '@tokenusagealert/azure/offboarding'

const config = loadConfig()
const repository = new BlobTenantRepository({
  ...(config.AZURE_STORAGE_CONNECTION_STRING
    ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING }
    : {}),
  ...(config.BLOB_ACCOUNT_URL
    ? { accountUrl: config.BLOB_ACCOUNT_URL }
    : {}),
  ...(config.MANAGED_IDENTITY_CLIENT_ID
    ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID }
    : {}),
  autoCreateContainers: config.BLOB_AUTO_CREATE,
  configurationContainerName: config.CONFIGURATION_CONTAINER,
  auditContainerName: config.AUDIT_CONTAINER,
  inventoryContainerName: config.INVENTORY_CONTAINER,
  operationsContainerName: config.OPERATIONS_CONTAINER,
})

await repository.initialize()
const fixtureSchema = z.array(
  z.object({
    subscriptionId: z.string().uuid(),
    displayName: z.string().min(1),
    tenantId: z.string().uuid(),
    state: z.string().min(1),
  }),
)
const fixtureJson = config.AUTH_SYNC_FIXTURE_PATH
  ? readFileSync(config.AUTH_SYNC_FIXTURE_PATH, 'utf8')
  : (config.AUTH_SYNC_FIXTURE_JSON ?? '[]')
const authorizationSyncStarter =
  config.AUTH_SYNC_MODE === 'job'
    ? new ArmContainerAppsJobStarter(
        config.AUTH_SYNC_JOB_SUBSCRIPTION_ID!,
        config.AUTH_SYNC_JOB_RESOURCE_GROUP!,
        config.AUTH_SYNC_JOB_NAME!,
        config.MANAGED_IDENTITY_CLIENT_ID,
      )
    : new InlineAuthorizationSyncStarter(
        new AuthorizationSyncService(
          repository,
          new FixtureSubscriptionDiscovery(
            fixtureSchema.parse(JSON.parse(fixtureJson)),
          ),
        ),
      )
let pricing: PricingRoutesOptions | undefined
let manualPricing: ManualPricingRoutesOptions | undefined
if (config.PRICING_SYNC_MODE !== 'disabled') {
  const service = createBlobServiceClient({
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE,
  })
  const store = new BlobPricingStore(service, { operationsContainer: config.OPERATIONS_CONTAINER, configurationContainer: config.CONFIGURATION_CONTAINER })
  await store.initialize(config.BLOB_AUTO_CREATE)
  const starter = config.PRICING_SYNC_MODE === 'job'
    ? new ArmContainerAppsJobStarter(
        config.PRICING_SYNC_JOB_SUBSCRIPTION_ID!,
        config.PRICING_SYNC_JOB_RESOURCE_GROUP!,
        config.PRICING_SYNC_JOB_NAME!,
        config.MANAGED_IDENTITY_CLIENT_ID,
      )
    : new InlinePricingSyncStarter(new PricingSyncService(
        store,
        new FixturePricingSource(z.array(z.unknown()).parse(
          JSON.parse(readFileSync(config.PRICING_FIXTURE_PATH!, 'utf8')),
        )),
      ))
  pricing = { store, starter }
  manualPricing = { official: store, manual: new BlobManualPricingStore(service, {
    configuration: config.CONFIGURATION_CONTAINER, operations: config.OPERATIONS_CONTAINER,
  }) }
}
let usage: UsageRoutesOptions | undefined
if (config.USAGE_SYNC_MODE !== 'disabled') {
  const execution = usageExecutionFromEnvironment(process.env)
  const client = createBlobServiceClient({
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE,
  })
  const store = new BlobUsageStore(client, { shardId: 0, shardCount: execution.shardCount })
  await store.initialize(config.BLOB_AUTO_CREATE)
  const starter = config.USAGE_SYNC_MODE === 'job'
    ? new ShardedUsageStarter(Array.from({ length: execution.shardCount }, (_, i) =>
        new ArmContainerAppsJobStarter(
          config.USAGE_JOB_SUBSCRIPTION_ID!, config.USAGE_JOB_RESOURCE_GROUP!,
          `${config.USAGE_JOB_NAME!}${i === 0 ? '' : `-${i}`}`, config.MANAGED_IDENTITY_CLIENT_ID,
        )))
    : new InlineUsageStarter(new UsageCollectionService(
        repository, store, new BlobPricingStore(client, {
          configurationContainer: config.CONFIGURATION_CONTAINER, operationsContainer: config.OPERATIONS_CONTAINER,
        }), new EmptyUsageSource(), {
          execution,
          ...(config.MAIL_MODE === 'preview' ? { alerts: new AlertProducer(new BlobAlertStore(client, {
            senderMailbox: config.MAIL_SENDER_MAILBOX,
            allowedRecipientDomains: config.MAIL_ALLOWED_DOMAINS.split(',').map((item) => item.trim().toLowerCase()),
            mode: 'preview', authorizationReady: false,
          })) } : {}),
        },
      ))
  usage = { tenants: repository, store, starter }
}
let mail: MailRoutesOptions | undefined
if (config.MAIL_MODE !== 'disabled') {
  const client = createBlobServiceClient({
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE,
  })
  const store = new BlobAlertStore(client, {
    senderMailbox: config.MAIL_SENDER_MAILBOX,
    allowedRecipientDomains: config.MAIL_ALLOWED_DOMAINS.split(',').map((item) => item.trim().toLowerCase()),
    mode: config.MAIL_MODE,
    authorizationReady: config.MAIL_AUTHORIZATION_READY === 'true',
    ...(config.MAIL_IDENTITY_CLIENT_ID ? { authorizationIdentityId: config.MAIL_IDENTITY_CLIENT_ID } : {}),
  })
  await store.initialize(config.BLOB_AUTO_CREATE)
  const producer = new AlertProducer(store)
  const starter = config.MAIL_MODE === 'graph'
    ? new ArmContainerAppsJobStarter(config.MAIL_JOB_SUBSCRIPTION_ID!, config.MAIL_JOB_RESOURCE_GROUP!, config.MAIL_JOB_NAME!, config.MANAGED_IDENTITY_CLIENT_ID)
    : { async start() {
        const run = await new MailDispatcher(store, new GraphMailSender({ authorizationReady: false, publicUrl: 'http://localhost:5173' })).run()
        return { executionName: run.runId }
      } }
  mail = { store, producer, starter }
}
let offboarding: OffboardingService | undefined
if (config.OFFBOARDING_CLIENT_ID) {
  const removalClient = new ArmDelegationRemovalClient({
    clientId: config.OFFBOARDING_CLIENT_ID,
    principalId: config.OFFBOARDING_PRINCIPAL_ID!,
    managingTenantId: config.OFFBOARDING_MANAGING_TENANT_ID!,
    collectorPrincipalId: config.OFFBOARDING_COLLECTOR_PRINCIPAL_ID!,
    offerName: 'AOAI Cost Usage Monitoring',
  })
  const client = createBlobServiceClient({
    ...(config.AZURE_STORAGE_CONNECTION_STRING ? { connectionString: config.AZURE_STORAGE_CONNECTION_STRING } : {}),
    ...(config.BLOB_ACCOUNT_URL ? { accountUrl: config.BLOB_ACCOUNT_URL } : {}),
    ...(config.MANAGED_IDENTITY_CLIENT_ID ? { managedIdentityClientId: config.MANAGED_IDENTITY_CLIENT_ID } : {}),
    autoCreateContainers: config.BLOB_AUTO_CREATE,
  })
  offboarding = new OffboardingService(repository, removalClient, new BlobOffboardingStore(client), authorizationSyncStarter)
}
const app = await buildApp({
  config,
  repository,
  authorizationSyncStarter,
  ...(pricing ? { pricing } : {}),
  ...(manualPricing ? { manualPricing } : {}),
  ...(usage ? { usage } : {}),
  ...(mail ? { mail } : {}),
  ...(offboarding ? { offboarding } : {}),
})

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down')
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await app.listen({
  host: config.HOST,
  port: config.PORT,
})
