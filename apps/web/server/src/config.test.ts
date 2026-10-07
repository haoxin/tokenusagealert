import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const storage = {
  AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
}

describe('loadConfig', () => {
  it('accepts explicit development auth outside production', () => {
    expect(
      loadConfig({
        NODE_ENV: 'development',
        AUTH_MODE: 'development',
        DEV_AUTH_OBJECT_ID: 'operator-1',
        DEV_AUTH_NAME: 'operator@ms-ext.biz',
        ...storage,
      }).AUTH_MODE,
    ).toBe('development')
  })

  it('rejects development auth in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'development',
        DEV_AUTH_OBJECT_ID: 'operator-1',
        DEV_AUTH_NAME: 'operator@ms-ext.biz',
        BLOB_ACCOUNT_URL: 'https://storage.example.com',
      }),
    ).toThrow(/development auth is forbidden in production/)
  })

  it('rejects a shared-key connection string in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'easyauth',
        ...storage,
      }),
    ).toThrow(/forbidden in production/)
  })

  it('accepts a partner HTTPS Blob endpoint and explicitly configured mailbox/domain in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production', AUTH_MODE: 'easyauth',
      BLOB_ACCOUNT_URL: 'https://partnerexample.blob.core.windows.net/',
      MANAGED_IDENTITY_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      MAIL_SENDER_MAILBOX: 'alerts@partner.example', MAIL_ALLOWED_DOMAINS: 'partner.example',
      MAIL_MODE: 'graph', MAIL_AUTHORIZATION_READY: 'false',
      MAIL_JOB_SUBSCRIPTION_ID: '22222222-2222-4222-8222-222222222222',
      MAIL_JOB_RESOURCE_GROUP: 'partner-rg', MAIL_JOB_NAME: 'partner-mail',
    })
    expect(config.BLOB_ACCOUNT_URL).toBe('https://partnerexample.blob.core.windows.net/')
    expect(config.MAIL_SENDER_MAILBOX).toBe('alerts@partner.example')
    expect(config.MAIL_ALLOWED_DOMAINS).toBe('partner.example')
    expect(config.MAIL_AUTHORIZATION_READY).toBe('false')
    expect(config.BLOB_AUTO_CREATE).toBe(false)
  })

  it('rejects fixture prices in production and incomplete Job settings', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production', AUTH_MODE: 'easyauth',
      BLOB_ACCOUNT_URL: 'https://example.blob.core.windows.net',
      PRICING_SYNC_MODE: 'fixture', PRICING_FIXTURE_PATH: 'test.json',
    })).toThrow(/Fixture pricing is forbidden/)
    expect(() => loadConfig({
      AUTH_MODE: 'easyauth', ...storage, PRICING_SYNC_MODE: 'job',
    })).toThrow(/PRICING_SYNC_JOB_NAME/)
  })

  it('requires the dedicated mail identity binding before opening real Graph tests', () => {
    const mail = {
      AUTH_MODE: 'easyauth', ...storage, MAIL_MODE: 'graph', MAIL_AUTHORIZATION_READY: 'true',
      MAIL_JOB_SUBSCRIPTION_ID: '11111111-1111-4111-8111-111111111111',
      MAIL_JOB_RESOURCE_GROUP: 'fixture-rg', MAIL_JOB_NAME: 'fixture-mail',
    }
    expect(() => loadConfig(mail)).toThrow(/dedicated mail identity binding/)
    expect(loadConfig({ ...mail, MAIL_IDENTITY_CLIENT_ID: '22222222-2222-4222-8222-222222222222' }).MAIL_AUTHORIZATION_READY).toBe('true')
  })
})
