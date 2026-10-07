import { describe, expect, it } from 'vitest'
import { PricingJobConfigSchema } from './config.js'

const production = {
  BLOB_ACCOUNT_URL: 'https://example.blob.core.windows.net',
  MANAGED_IDENTITY_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
}
describe('pricing Job configuration', () => {
  it('defaults to real prices and private managed-identity storage', () => {
    expect(PricingJobConfigSchema.parse(production).PRICING_SOURCE).toBe('azure-retail')
  })
  it.each([
    { PRICING_SOURCE: 'fixture', PRICING_FIXTURE_PATH: 'fixture.json' },
    { AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' },
    { BLOB_AUTO_CREATE: 'true' },
  ])('rejects production fixture/shared-key/auto-create options: %j', (options) => {
    expect(PricingJobConfigSchema.safeParse({ ...production, ...options }).success).toBe(false)
  })
  it('allows an explicitly configured local fixture', () => {
    expect(PricingJobConfigSchema.safeParse({
      NODE_ENV: 'development', PRICING_SOURCE: 'fixture', PRICING_FIXTURE_PATH: 'fixture.json',
      AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true', BLOB_AUTO_CREATE: 'true',
    }).success).toBe(true)
  })
  it('allows an explicit metadata-only execution without changing normal retail defaults or storage guards', () => {
    expect(PricingJobConfigSchema.parse({ ...production, PRICING_METADATA_ONLY: 'true' }).PRICING_METADATA_ONLY).toBe(true)
    expect(PricingJobConfigSchema.parse(production).PRICING_METADATA_ONLY).toBe(false)
    expect(PricingJobConfigSchema.safeParse({ ...production, PRICING_METADATA_ONLY: 'true', AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' }).success).toBe(false)
  })
})
