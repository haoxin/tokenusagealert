import { z } from 'zod'

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

const EnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    AUTH_MODE: z.enum(['development', 'easyauth']),
    DEV_AUTH_OBJECT_ID: z.string().min(1).optional(),
    DEV_AUTH_NAME: z.string().min(1).optional(),
    AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
    BLOB_ACCOUNT_URL: z.url().optional(),
    MANAGED_IDENTITY_CLIENT_ID: z.string().min(1).optional(),
    AUTH_SYNC_MODE: z.enum(['inline', 'job']).default('inline'),
    MANAGING_TENANT_ID: z.string().uuid().optional(),
    AUTH_SYNC_FIXTURE_JSON: z.string().optional(),
    AUTH_SYNC_FIXTURE_PATH: z.string().min(1).optional(),
    AUTH_SYNC_JOB_SUBSCRIPTION_ID: z.string().uuid().optional(),
    AUTH_SYNC_JOB_RESOURCE_GROUP: z.string().min(1).optional(),
    AUTH_SYNC_JOB_NAME: z.string().min(1).optional(),
    PRICING_SYNC_MODE: z.enum(['disabled', 'fixture', 'job']).default('disabled'),
    PRICING_FIXTURE_PATH: z.string().min(1).optional(),
    PRICING_SYNC_JOB_SUBSCRIPTION_ID: z.string().uuid().optional(),
    PRICING_SYNC_JOB_RESOURCE_GROUP: z.string().min(1).optional(),
    PRICING_SYNC_JOB_NAME: z.string().min(1).optional(),
    USAGE_SYNC_MODE: z.enum(['disabled', 'fixture', 'job']).default('disabled'),
    USAGE_JOB_SUBSCRIPTION_ID: z.string().uuid().optional(),
    USAGE_JOB_RESOURCE_GROUP: z.string().min(1).optional(),
    USAGE_JOB_NAME: z.string().min(1).optional(),
    MAIL_MODE: z.enum(['disabled', 'preview', 'graph']).default('disabled'),
    MAIL_SENDER_MAILBOX: z.email().default('chx@ms-ext.biz'),
    MAIL_ALLOWED_DOMAINS: z.string().default('ms-ext.biz'),
    MAIL_AUTHORIZATION_READY: z.enum(['true', 'false']).default('false'),
    MAIL_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
    MAIL_JOB_SUBSCRIPTION_ID: z.string().uuid().optional(),
    MAIL_JOB_RESOURCE_GROUP: z.string().optional(),
    MAIL_JOB_NAME: z.string().optional(),
    OFFBOARDING_CLIENT_ID: z.string().uuid().optional(),
    OFFBOARDING_PRINCIPAL_ID: z.string().uuid().optional(),
    OFFBOARDING_MANAGING_TENANT_ID: z.string().uuid().optional(),
    OFFBOARDING_COLLECTOR_PRINCIPAL_ID: z.string().uuid().optional(),
    BLOB_AUTO_CREATE: booleanFromString.default(false),
    CONFIGURATION_CONTAINER: z.string().min(3).default('configuration'),
    AUDIT_CONTAINER: z.string().min(3).default('audit'),
    INVENTORY_CONTAINER: z.string().min(3).default('inventory'),
    OPERATIONS_CONTAINER: z.string().min(3).default('operations'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
  .superRefine((environment, context) => {
    const offboarding = [
      environment.OFFBOARDING_CLIENT_ID, environment.OFFBOARDING_PRINCIPAL_ID,
      environment.OFFBOARDING_MANAGING_TENANT_ID, environment.OFFBOARDING_COLLECTOR_PRINCIPAL_ID,
    ]
    if (offboarding.some(Boolean) && !offboarding.every(Boolean)) {
      context.addIssue({ code: 'custom', message: 'All offboarding identity settings must be configured together.' })
    }
    if (environment.OFFBOARDING_PRINCIPAL_ID &&
      environment.OFFBOARDING_PRINCIPAL_ID.toLowerCase() === environment.OFFBOARDING_COLLECTOR_PRINCIPAL_ID?.toLowerCase()) {
      context.addIssue({ code: 'custom', message: 'Offboarding must use a different identity from the Reader Collector.' })
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.AUTH_MODE === 'development'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'development auth is forbidden in production',
      })
    }

    if (environment.AUTH_MODE === 'development') {
      if (!environment.DEV_AUTH_OBJECT_ID) {
        context.addIssue({
          code: 'custom',
          path: ['DEV_AUTH_OBJECT_ID'],
          message: 'DEV_AUTH_OBJECT_ID is required for development auth',
        })
      }
      if (!environment.DEV_AUTH_NAME) {
        context.addIssue({
          code: 'custom',
          path: ['DEV_AUTH_NAME'],
          message: 'DEV_AUTH_NAME is required for development auth',
        })
      }
    }

    if (
      !environment.AZURE_STORAGE_CONNECTION_STRING &&
      !environment.BLOB_ACCOUNT_URL
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BLOB_ACCOUNT_URL'],
        message:
          'AZURE_STORAGE_CONNECTION_STRING or BLOB_ACCOUNT_URL is required',
      })
    }

    if (
      environment.NODE_ENV === 'production' &&
      environment.AZURE_STORAGE_CONNECTION_STRING
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AZURE_STORAGE_CONNECTION_STRING'],
        message:
          'Shared-key storage connection strings are forbidden in production',
      })
    }
    if (environment.AUTH_SYNC_MODE === 'job') {
      for (const [field, value] of [
        [
          'AUTH_SYNC_JOB_SUBSCRIPTION_ID',
          environment.AUTH_SYNC_JOB_SUBSCRIPTION_ID,
        ],
        [
          'AUTH_SYNC_JOB_RESOURCE_GROUP',
          environment.AUTH_SYNC_JOB_RESOURCE_GROUP,
        ],
        ['AUTH_SYNC_JOB_NAME', environment.AUTH_SYNC_JOB_NAME],
      ] as const) {
        if (!value) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is required for job sync mode`,
          })
        }
      }
    }
    if (environment.PRICING_SYNC_MODE === 'fixture') {
      if (environment.NODE_ENV === 'production') {
        context.addIssue({ code: 'custom', path: ['PRICING_SYNC_MODE'], message: 'Fixture pricing is forbidden in production.' })
      }
      if (!environment.PRICING_FIXTURE_PATH) {
        context.addIssue({ code: 'custom', path: ['PRICING_FIXTURE_PATH'], message: 'Fixture pricing requires an explicit local fixture path.' })
      }
    }
    if (environment.PRICING_SYNC_MODE === 'job') {
      for (const field of [
        'PRICING_SYNC_JOB_SUBSCRIPTION_ID', 'PRICING_SYNC_JOB_RESOURCE_GROUP', 'PRICING_SYNC_JOB_NAME',
      ] as const) {
        if (!environment[field]) context.addIssue({ code: 'custom', path: [field], message: `${field} is required for pricing Job mode.` })
      }
    }
    if (environment.NODE_ENV === 'production' && environment.USAGE_SYNC_MODE === 'fixture') {
      context.addIssue({ code: 'custom', path: ['USAGE_SYNC_MODE'], message: 'Fixture usage is forbidden in production.' })
    }
    if (environment.USAGE_SYNC_MODE === 'job') {
      for (const field of ['USAGE_JOB_SUBSCRIPTION_ID', 'USAGE_JOB_RESOURCE_GROUP', 'USAGE_JOB_NAME'] as const) {
        if (!environment[field]) context.addIssue({ code: 'custom', path: [field], message: `${field} is required.` })
      }
    }
    if (environment.MAIL_MODE === 'graph' &&
      (!environment.MAIL_JOB_NAME || !environment.MAIL_JOB_RESOURCE_GROUP || !environment.MAIL_JOB_SUBSCRIPTION_ID)) {
      context.addIssue({ code: 'custom', message: 'Graph mail mode requires a configured mail dispatcher Job.' })
    }
    if (environment.MAIL_MODE === 'graph' && environment.MAIL_AUTHORIZATION_READY === 'true' && !environment.MAIL_IDENTITY_CLIENT_ID) {
      context.addIssue({ code: 'custom', path: ['MAIL_IDENTITY_CLIENT_ID'], message: 'Authorized Graph mail requires the dedicated mail identity binding.' })
    }
  })

export type AppConfig = z.infer<typeof EnvironmentSchema>

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return EnvironmentSchema.parse(environment)
}
