import { z } from 'zod'

export const PricingJobConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PRICING_SOURCE: z.enum(['azure-retail', 'fixture']).default('azure-retail'),
  PRICING_METADATA_ONLY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  PRICING_FIXTURE_PATH: z.string().min(1).optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().min(1).optional(),
  BLOB_ACCOUNT_URL: z.url().optional(),
  MANAGED_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
  BLOB_AUTO_CREATE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
}).superRefine((config, context) => {
  if (!config.BLOB_ACCOUNT_URL && !config.AZURE_STORAGE_CONNECTION_STRING) {
    context.addIssue({ code: 'custom', message: 'A Blob storage connection is required.' })
  }
  if (config.PRICING_SOURCE === 'fixture' && !config.PRICING_FIXTURE_PATH) {
    context.addIssue({ code: 'custom', message: 'Fixture mode requires an explicit local file.' })
  }
  if (config.NODE_ENV === 'production') {
    if (config.PRICING_SOURCE !== 'azure-retail' || config.PRICING_FIXTURE_PATH) {
      context.addIssue({ code: 'custom', message: 'Fixture pricing is forbidden in production.' })
    }
    if (config.AZURE_STORAGE_CONNECTION_STRING || config.BLOB_AUTO_CREATE) {
      context.addIssue({ code: 'custom', message: 'Production requires provisioned Blob containers and managed identity; shared keys and automatic container creation are forbidden.' })
    }
    if (!config.MANAGED_IDENTITY_CLIENT_ID || !config.BLOB_ACCOUNT_URL?.startsWith('https://')) {
      context.addIssue({ code: 'custom', message: 'Production requires an explicit identity and HTTPS Blob endpoint.' })
    }
  }
})
