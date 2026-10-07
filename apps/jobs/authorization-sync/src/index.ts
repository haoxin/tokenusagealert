import { BlobTenantRepository } from '@tokenusagealert/azure'
import {
  ArmSubscriptionDiscovery,
  AuthorizationSyncService,
  FixtureSubscriptionDiscovery,
  type VisibleSubscription,
} from '@tokenusagealert/azure/authorization'
import { z } from 'zod'

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

const ConfigSchema = z
  .object({
    AUTH_DISCOVERY_MODE: z.enum(['azure', 'fixture']).default('azure'),
    MANAGING_TENANT_ID: z.string().uuid(),
    FIXTURE_SUBSCRIPTIONS_JSON: z.string().optional(),
    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
    BLOB_ACCOUNT_URL: z.url().optional(),
    MANAGED_IDENTITY_CLIENT_ID: z.string().min(1).optional(),
    BLOB_AUTO_CREATE: booleanFromString.default(false),
    CONFIGURATION_CONTAINER: z.string().min(3).default('configuration'),
    AUDIT_CONTAINER: z.string().min(3).default('audit'),
    INVENTORY_CONTAINER: z.string().min(3).default('inventory'),
    OPERATIONS_CONTAINER: z.string().min(3).default('operations'),
  })
  .superRefine((config, context) => {
    if (
      !config.AZURE_STORAGE_CONNECTION_STRING &&
      !config.BLOB_ACCOUNT_URL
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BLOB_ACCOUNT_URL'],
        message:
          'AZURE_STORAGE_CONNECTION_STRING or BLOB_ACCOUNT_URL is required',
      })
    }
    if (
      config.AUTH_DISCOVERY_MODE === 'fixture' &&
      !config.FIXTURE_SUBSCRIPTIONS_JSON
    ) {
      context.addIssue({
        code: 'custom',
        path: ['FIXTURE_SUBSCRIPTIONS_JSON'],
        message: 'Fixture mode requires FIXTURE_SUBSCRIPTIONS_JSON',
      })
    }
  })

const VisibleSubscriptionSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    displayName: z.string().min(1),
    tenantId: z.string().uuid(),
    state: z.string().min(1),
  })
  .strict()

const config = ConfigSchema.parse(process.env)
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

let fixtureSubscriptions: VisibleSubscription[] = []
if (config.AUTH_DISCOVERY_MODE === 'fixture') {
  fixtureSubscriptions = z
    .array(VisibleSubscriptionSchema)
    .parse(JSON.parse(config.FIXTURE_SUBSCRIPTIONS_JSON!))
}

const discovery =
  config.AUTH_DISCOVERY_MODE === 'azure'
    ? new ArmSubscriptionDiscovery(
        config.MANAGING_TENANT_ID,
        config.MANAGED_IDENTITY_CLIENT_ID,
      )
    : new FixtureSubscriptionDiscovery(fixtureSubscriptions)
const service = new AuthorizationSyncService(repository, discovery)
const run = await service.run()

console.log(
  JSON.stringify({
    runId: run.runId,
    status: run.status,
    discoveredTenantCount: run.discoveredTenantCount,
    visibleSubscriptionCount: run.visibleSubscriptionCount,
    updatedTenantCount: run.updatedTenantCount,
    errorCount: run.errors.length,
  }),
)

if (run.status === 'failed') {
  process.exitCode = 1
}
