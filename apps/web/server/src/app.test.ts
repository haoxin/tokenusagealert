import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { AlertProducer, BlobAlertStore } from '@tokenusagealert/azure/alerts'
import {
  TenantCannotBeEnabledError,
  TenantCannotBeDeletedError,
  TenantCannotBeUpdatedError,
  TenantConcurrencyError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  createBlobServiceClient,
  type AuthenticatedActor,
  type CreateTenantResult,
  type DeleteTenantRegistrationResult,
} from '@tokenusagealert/azure'
import type {
  AuthorizationSyncRun,
  CreateTenantRequest,
  EnableTenantRequest,
  SubscriptionInventoryDocument,
  TenantListItem,
  PricingSnapshotSummary,
  MailSettings,
  UpdateTenantSettingsRequest,
  CompactPriceCatalog,
  ManualPriceInput,
  ManualPriceVersion,
} from '@tokenusagealert/schemas'
import {
  PricingDownloadChangedError, PricingSyncBusyError, ManualPriceConflictError, ManualPriceScopeError,
  ManualPriceNotFoundError, type PricingStore,
} from '@tokenusagealert/azure/pricing'
import { StorageLeaseBusyError } from '@tokenusagealert/azure/usage'
import { buildApp, type TenantRepository } from './app.js'
import type { AppConfig } from './config.js'
import type { ManualPricingRoutesOptions } from './manual-pricing-routes.js'

class MemoryTenantRepository implements TenantRepository {
  readonly tenants = new Map<string, TenantListItem>()
  readonly inventories = new Map<string, SubscriptionInventoryDocument>()
  latestRun: AuthorizationSyncRun | null = null
  ready = true
  deletionAuditCompletionRecorded = true

  async checkReady() {
    if (!this.ready) throw new Error('not ready')
  }

  async listTenants() {
    return [...this.tenants.values()]
  }

  async getTenant(tenantId: string) {
    const tenant = this.tenants.get(tenantId)
    if (!tenant) throw new TenantNotFoundError(tenantId)
    return tenant
  }

  async createTenant(
    request: CreateTenantRequest,
    actor: AuthenticatedActor,
  ): Promise<CreateTenantResult> {
    if (this.tenants.has(request.tenantId)) {
      throw new TenantAlreadyExistsError(request.tenantId)
    }
    const now = '2026-09-29T08:00:00.000Z'
    const tenant: TenantListItem = {
      schemaVersion: 1,
      revision: 1,
      tenantId: request.tenantId,
      displayName: request.displayName,
      status: 'pendingAuthorization',
      authorizationSource: 'manual-preregistration',
      hourlyThresholdUsd: request.hourlyThresholdUsd,
      notes: request.notes,
      createdByObjectId: actor.objectId,
      createdByName: actor.name,
      createdAtUtc: now,
      updatedAtUtc: now,
      deletedAtUtc: null,
      etag: '"etag-1"',
    }
    this.tenants.set(request.tenantId, tenant)
    return { tenant, auditCompletionRecorded: true }
  }

  async updateTenantSettings(tenantId: string, input: UpdateTenantSettingsRequest, expectedEtag: string) {
    const tenant = await this.getTenant(tenantId)
    if (tenant.etag !== expectedEtag) throw new TenantConcurrencyError(tenantId)
    if (tenant.status === 'deleted') throw new TenantCannotBeUpdatedError(tenantId)
    const updated = { ...tenant, ...input, revision: tenant.revision + 1,
      updatedAtUtc: '2026-10-05T03:00:00.000Z', etag: `"etag-${tenant.revision + 1}"` }
    this.tenants.set(tenantId, updated)
    return updated
  }

  async deletePendingTenant(tenantId: string, expectedEtag: string): Promise<DeleteTenantRegistrationResult> {
    const tenant = await this.getTenant(tenantId)
    if (tenant.etag !== expectedEtag) throw new TenantConcurrencyError(tenantId)
    const inventory = this.inventories.get(tenantId)
    if (tenant.status !== 'pendingAuthorization' || inventory?.subscriptions.length || inventory?.expectedSubscriptionIds.length) {
      throw new TenantCannotBeDeletedError(tenantId, '只能删除未授权的预登记。')
    }
    this.tenants.delete(tenantId)
    return { tenantId, auditCompletionRecorded: this.deletionAuditCompletionRecorded }
  }

  async getSubscriptionInventory(tenantId: string) {
    return this.inventories.get(tenantId) ?? null
  }

  async getLatestAuthorizationSyncRun() {
    return this.latestRun
  }

  async enableTenant(
    tenantId: string,
    request: EnableTenantRequest,
    actor: AuthenticatedActor,
  ) {
    const tenant = await this.getTenant(tenantId)
    if (tenant.etag !== request.etag) {
      throw new TenantConcurrencyError(tenantId)
    }
    if (tenant.status !== 'discovered') {
      throw new TenantCannotBeEnabledError(
        tenantId,
        'Tenant is not discovered',
      )
    }
    if (!this.inventories.get(tenantId)?.subscriptions.length) {
      throw new TenantCannotBeEnabledError(
        tenantId,
        'Tenant has no delegated subscriptions',
      )
    }
    const updated: TenantListItem = {
      ...tenant,
      displayName: request.displayName,
      hourlyThresholdUsd: request.hourlyThresholdUsd,
      status: 'active',
      revision: tenant.revision + 1,
      updatedAtUtc: '2026-09-29T09:00:00.000Z',
      createdByObjectId: actor.objectId,
      etag: '"etag-2"',
    }
    this.tenants.set(tenantId, updated)
    return updated
  }
}

function config(
  authMode: 'development' | 'easyauth' = 'development',
): AppConfig {
  return {
    NODE_ENV: 'test',
    AUTH_MODE: authMode,
    ...(authMode === 'development'
      ? {
          DEV_AUTH_OBJECT_ID: 'operator-1',
          DEV_AUTH_NAME: 'operator@ms-ext.biz',
        }
      : {}),
    AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    BLOB_AUTO_CREATE: true,
    AUTH_SYNC_MODE: 'inline',
    PRICING_SYNC_MODE: 'disabled',
    USAGE_SYNC_MODE: 'disabled',
    MAIL_MODE: 'disabled',
    MAIL_SENDER_MAILBOX: 'chx@ms-ext.biz',
    MAIL_ALLOWED_DOMAINS: 'ms-ext.biz',
    MAIL_AUTHORIZATION_READY: 'false',
    CONFIGURATION_CONTAINER: 'configuration',
    AUDIT_CONTAINER: 'audit',
    INVENTORY_CONTAINER: 'inventory',
    OPERATIONS_CONTAINER: 'operations',
    HOST: '127.0.0.1',
    PORT: 3000,
    LOG_LEVEL: 'error',
  }
}

const validBody = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  displayName: '客户 A',
  hourlyThresholdUsd: '25',
}

describe('web API', () => {
  const manualInput: ManualPriceInput = { modelName: 'gpt-4.1', modelVersion: null, deploymentSku: 'GlobalStandard',
    regionScope: 'selected', regions: ['swedencentral'], inputUsdPerMillion: '3', outputUsdPerMillion: '7', note: 'Unit-test fixture' }
  const manualItem: ManualPriceVersion = { ...manualInput, ruleId: '44444444-4444-4444-8444-444444444444', revision: 1,
    effectiveFromUtc: '2026-10-05T11:00:00.000Z', effectiveToUtc: null, enabled: true,
    updatedAtUtc: '2026-10-05T10:30:00.000Z', updatedByObjectId: 'fixture' }
  function manualOptions() {
    const document = { schemaVersion: 1 as const, revision: 1, snapshotId: '55555555-5555-4555-8555-555555555555', versions: [manualItem] }
    const saved = { document, item: manualItem, etag: '"manual-new"' }
    const catalog: CompactPriceCatalog = {
      schemaVersion: 1, kind: 'compact-official', snapshotId: '66666666-6666-4666-8666-666666666666',
      fetchedAtUtc: '2026-10-05T10:00:00.000Z', generatedAtUtc: '2026-10-05T10:00:00.000Z', currency: 'USD',
      unitTokens: '1000000', models: ['gpt-4.1'], regions: ['swedencentral'], rawEntryCount: 1,
      rates: [{ model: 'gpt-4.1', skuName: 'gpt 4.1 Inp glbl', sku: 'GlobalStandard', tier: 'standard', context: 'uniform', direction: 'input',
        usd: '2', effectiveFromUtc: '2026-01-01T00:00:00Z', approvedMapping: true,
        regions: [{ name: 'swedencentral', meterId: '77777777-7777-4777-8777-777777777777' }] }],
    }
    return {
      manual: {
        read: vi.fn<ManualPricingRoutesOptions['manual']['read']>().mockResolvedValue({ document, etag: '"manual-current"' }),
        save: vi.fn<ManualPricingRoutesOptions['manual']['save']>().mockResolvedValue(saved),
        disable: vi.fn<ManualPricingRoutesOptions['manual']['disable']>().mockResolvedValue({ ...saved, item: { ...manualItem, enabled: false } }),
      },
      official: { getCompact: vi.fn<ManualPricingRoutesOptions['official']['getCompact']>().mockResolvedValue({ catalog, etag: '"official"' }) },
    }
  }

  it('protects manual-price read, create, update and disable with the same Entra authentication as other settings', async () => {
    const app = await buildApp({ config: config('easyauth'), repository: new MemoryTenantRepository(), manualPricing: manualOptions() })
    expect((await app.inject('/api/v1/settings/manual-pricing')).statusCode).toBe(401)
    for (const [method, url] of [
      ['POST', '/api/v1/settings/manual-pricing'],
      ['PATCH', `/api/v1/settings/manual-pricing/${manualItem.ruleId}`],
      ['POST', `/api/v1/settings/manual-pricing/${manualItem.ruleId}/disable`],
    ] as const) {
      expect((await app.inject({ method, url, payload: manualInput })).statusCode).toBe(401)
    }
    await app.close()
  })

  it('lists current manual heads, version history, official region options and strong ETag without caching configuration', async () => {
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: manualOptions() })
    const result = await app.inject('/api/v1/settings/manual-pricing')
    expect(result.json()).toMatchObject({ items: [manualItem], etag: '"manual-current"', regionOptions: ['swedencentral'],
      officialModels: ['gpt-4.1'], preference: 'official-first', effectivePolicy: 'next-full-hour' })
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers.etag).toBe('"manual-current"')
    await app.close()
  })

  it('saves explicit manual prices as next-hour fallback, forwards the operator identity and warns about official precedence', async () => {
    const options = manualOptions()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    const initial = await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing', payload: manualInput,
      headers: { accept: 'application/json', 'if-none-match': '*' } })
    expect(initial.statusCode).toBe(201)
    expect(initial.json()).toMatchObject({ item: manualItem, etag: '"manual-new"', warning: expect.stringContaining('官方优先') })
    expect(options.manual.save).toHaveBeenCalledWith(manualInput, null, config().DEV_AUTH_OBJECT_ID, null)
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/settings/manual-pricing/${manualItem.ruleId}`,
      payload: manualInput, headers: { accept: 'application/json', 'if-match': '"manual-current"' } })
    expect(edited.statusCode).toBe(200)
    expect(options.manual.save).toHaveBeenLastCalledWith(manualInput, '"manual-current"', config().DEV_AUTH_OBJECT_ID, manualItem.ruleId)
    expect(edited.headers.etag).toBe('"manual-new"')
    expect(edited.headers['cache-control']).toBe('no-store')
    await app.close()
  })

  it.each([
    {}, { 'if-match': 'W/"weak"' }, { 'if-match': '*' },
    { 'if-match': '"manual-current"', 'if-none-match': '*' },
  ])('requires an exact strong manual ETag or an unmixed initial-create condition: %j', async (headers) => {
    const options = manualOptions()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    const result = await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing',
      payload: manualInput, headers: { accept: 'application/json', ...headers } })
    expect(result.json()).toMatchObject({ status: 428, code: 'MANUAL_PRICE_PRECONDITION_REQUIRED' })
    expect(options.manual.save).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    { inputUsdPerMillion: '' }, { outputUsdPerMillion: '-2' }, { regions: [] }, { regionScope: 'all' },
    { modelName: 'gpt-4o-audio-preview' }, { arbitraryBlob: '../configuration/other.json' },
  ])('rejects invalid manual price inputs without persisting any state: %j', async (invalid) => {
    const options = manualOptions()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    const result = await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing', payload: { ...manualInput, ...invalid },
      headers: { accept: 'application/json', 'if-match': '"manual-current"' } })
    expect(result.json()).toMatchObject({ status: 400, code: 'INVALID_MANUAL_PRICE' })
    expect(options.manual.save).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects cross-origin writes and does not let a create-only header authorize update/disable', async () => {
    const options = manualOptions()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing', payload: manualInput,
      headers: { accept: 'application/json', 'if-none-match': '*', origin: 'https://foreign.example' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/settings/manual-pricing/${manualItem.ruleId}`, payload: manualInput,
      headers: { accept: 'application/json', 'if-none-match': '*' } })).statusCode).toBe(428)
    expect(options.manual.save).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    [new ManualPriceConflictError(), 412, 'MANUAL_PRICE_CONFLICT'],
    [new ManualPriceScopeError('Overlapping scope'), 409, 'MANUAL_PRICE_SCOPE_OVERLAP'],
    [new ManualPriceNotFoundError(), 404, 'MANUAL_PRICE_NOT_FOUND'],
    [new StorageLeaseBusyError(), 409, 'MANUAL_PRICE_BUSY'],
    [new Error('Private storage unavailable'), 503, 'MANUAL_PRICE_SAVE_FAILED'],
  ])('surfaces manual persistence failures without success-shaped responses: %s', async (error, status, code) => {
    const options = manualOptions()
    options.manual.save.mockRejectedValueOnce(error)
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    const result = await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing', payload: manualInput,
      headers: { accept: 'application/json', 'if-match': '"manual-current"' } })
    expect(result.json()).toMatchObject({ status, code })
    expect(result.json().item).toBeUndefined()
    expect(result.body).not.toContain('Private storage')
    await app.close()
  })

  it('checks official availability before saving and explicitly reports failed manual reads', async () => {
    const options = manualOptions()
    options.official.getCompact.mockRejectedValue(new Error('Cannot verify official prices'))
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    expect((await app.inject('/api/v1/settings/manual-pricing')).json()).toMatchObject({ status: 503, code: 'MANUAL_PRICE_READ_FAILED' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/settings/manual-pricing', payload: manualInput,
      headers: { accept: 'application/json', 'if-match': '"manual-current"' } })).statusCode).toBe(503)
    expect(options.manual.save).not.toHaveBeenCalled()
    await app.close()
  })

  it('disables with a version guard and preserves the store supplied effective time instead of claiming immediate deletion', async () => {
    const options = manualOptions()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), manualPricing: options })
    const result = await app.inject({ method: 'POST', url: `/api/v1/settings/manual-pricing/${manualItem.ruleId}/disable`,
      payload: {}, headers: { accept: 'application/json', 'if-match': '"manual-current"' } })
    expect(result.json()).toMatchObject({ item: { enabled: false, effectiveFromUtc: manualItem.effectiveFromUtc }, warning: null })
    expect(options.manual.disable).toHaveBeenCalledWith(manualItem.ruleId, '"manual-current"', config().DEV_AUTH_OBJECT_ID)
    await app.close()
  })

  it('guards partner offboarding behind authentication, same-origin JSON and a configured identity', async () => {
    const unauthorized = await buildApp({ config: config('easyauth'), repository: new MemoryTenantRepository() })
    expect((await unauthorized.inject({
      method: 'POST', url: `/api/v1/tenants/${validBody.tenantId}/offboarding/preview`, payload: {},
    })).statusCode).toBe(401)
    await unauthorized.close()
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository() })
    const preview = await app.inject({
      method: 'POST', url: `/api/v1/tenants/${validBody.tenantId}/offboarding/preview`, payload: {},
    })
    expect(preview.json()).toMatchObject({ configured: false, operation: null })
    const foreign = await app.inject({
      method: 'POST', url: `/api/v1/tenants/${validBody.tenantId}/offboarding/preview`, payload: {},
      headers: { origin: 'https://untrusted.example' },
    })
    expect(foreign.statusCode).toBe(403)
    const arbitrary = await app.inject({
      method: 'POST', url: `/api/v1/tenants/${validBody.tenantId}/offboarding/preview`,
      payload: { assignmentId: '/subscriptions/unrelated/anything' },
    })
    expect(arbitrary.statusCode).toBe(400)
    await app.close()
  })
  it('keeps real mail disabled without mailbox authorization and rejects untrusted origins', async () => {
    const store = new BlobAlertStore(createBlobServiceClient({
      connectionString: 'UseDevelopmentStorage=true', autoCreateContainers: false,
    }), { senderMailbox: 'chx@ms-ext.biz', allowedRecipientDomains: ['ms-ext.biz'], mode: 'graph', authorizationReady: false })
    vi.spyOn(store, 'settings').mockResolvedValue({
      settings: {
        schemaVersion: 1, revision: 0, enabled: false, senderMailbox: 'chx@ms-ext.biz', operationsRecipients: [],
        reminderIntervalHours: 6, recoveryPolicy: 'new-complete-hour', updatedAtUtc: null, updatedByObjectId: null,
      }, etag: null,
    })
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(), mail: { store, producer: new AlertProducer(store) } })
    const read = await app.inject({ method: 'GET', url: '/api/v1/settings/alerting' })
    expect(read.json()).toMatchObject({ authorizationReady: false, settings: { enabled: false, operationsRecipients: [] } })
    const enable = await app.inject({
      method: 'PATCH', url: '/api/v1/settings/alerting', payload: { enabled: true, operationsRecipients: ['chx@ms-ext.biz'] },
      headers: { 'if-none-match': '*' },
    })
    expect(enable.statusCode).toBe(409)
    const test = await app.inject({
      method: 'POST', url: '/api/v1/settings/alerting/test',
      payload: { requestId: '00000000-0000-4000-8000-000000000001', recipient: 'chx@ms-ext.biz', preview: false },
    })
    expect(test.statusCode).toBe(409)
    const foreign = await app.inject({
      method: 'PATCH', url: '/api/v1/settings/alerting',
      payload: { enabled: false, operationsRecipients: [] }, headers: { origin: 'https://untrusted.example' },
    })
    expect(foreign.statusCode).toBe(403)
    await app.close()
  })

  it('requires Entra authentication for mail settings and Outbox', async () => {
    const app = await buildApp({ config: config('easyauth'), repository: new MemoryTenantRepository() })
    for (const url of ['/api/v1/settings/alerting', '/api/v1/operations/outbox', '/api/v1/operations/mail']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
    await app.close()
  })

  it('saves a new sender as unverified with notifications off and permits an explicit test from that saved sender', async () => {
    const store = new BlobAlertStore(createBlobServiceClient({
      connectionString: 'UseDevelopmentStorage=true', autoCreateContainers: false,
    }), {
      senderMailbox: 'chx@ms-ext.biz', allowedRecipientDomains: ['ms-ext.biz'], mode: 'graph',
      authorizationReady: true, authorizationIdentityId: '22222222-2222-4222-8222-222222222222',
    })
    let settings: MailSettings = {
      schemaVersion: 1, revision: 1, enabled: true, senderMailbox: 'chx@ms-ext.biz',
      operationsRecipients: ['chx@ms-ext.biz'], reminderIntervalHours: 6, recoveryPolicy: 'new-complete-hour',
      updatedAtUtc: null, updatedByObjectId: null,
    }
    vi.spyOn(store, 'settings').mockImplementation(async () => ({ settings, etag: '"current"' }))
    vi.spyOn(store, 'senderAuthorization').mockImplementation(async (value) => ({
      ready: value.senderMailbox === 'chx@ms-ext.biz', source: 'unverified', checkedAtUtc: null,
    }))
    const save = vi.spyOn(store, 'saveSettings').mockImplementation(async (input, expected, actor) => {
      expect(expected).toBe('"current"'); expect(actor).toBe('operator-1')
      settings = { ...settings, ...input, senderMailbox: input.senderMailbox ?? settings.senderMailbox, enabled: false, revision: 2 }
      return { settings, etag: '"current"', senderChanged: true }
    })
    vi.spyOn(store, 'outbox').mockResolvedValue(null)
    const queued = vi.spyOn(store, 'ensureEvent').mockResolvedValue()
    const start = vi.fn(async () => ({ executionName: 'fixture-mail-only' }))
    const app = await buildApp({ config: config(), repository: new MemoryTenantRepository(),
      mail: { store, producer: new AlertProducer(store), starter: { start } } })
    const result = await app.inject({
      method: 'PATCH', url: '/api/v1/settings/alerting', headers: { 'if-match': '"current"' },
      payload: { senderMailbox: 'ALERTS@MS-EXT.BIZ', enabled: true, operationsRecipients: ['chx@ms-ext.biz'] },
    })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({
      settings: { senderMailbox: 'alerts@ms-ext.biz', enabled: false }, authorizationReady: false, graphTestAvailable: true,
    })
    expect(result.json().warning).toContain('自动通知已关闭')
    expect(save).toHaveBeenCalledTimes(1)
    const invalid = await app.inject({
      method: 'PATCH', url: '/api/v1/settings/alerting', headers: { 'if-match': '"current"' },
      payload: { senderMailbox: 'invalid', enabled: false, operationsRecipients: [] },
    })
    expect(invalid.statusCode).toBe(400)
    expect(save).toHaveBeenCalledTimes(1)
    const test = await app.inject({
      method: 'POST', url: '/api/v1/settings/alerting/test',
      payload: { requestId: '33333333-3333-4333-8333-333333333333', recipient: 'chx@ms-ext.biz',
        senderMailbox: 'alerts@ms-ext.biz', preview: false },
    })
    expect(test.statusCode).toBe(202)
    expect(test.json().event).toMatchObject({ sender: 'alerts@ms-ext.biz', mode: 'graph' })
    expect(queued).toHaveBeenCalledTimes(1)
    const stale = await app.inject({
      method: 'POST', url: '/api/v1/settings/alerting/test',
      payload: { requestId: '44444444-4444-4444-8444-444444444444', recipient: 'chx@ms-ext.biz',
        senderMailbox: 'chx@ms-ext.biz', preview: false },
    })
    expect(stale.statusCode).toBe(409)
    expect(start).toHaveBeenCalledTimes(1)
    await app.close()
  })

  const emptyPricingStore: PricingStore = {
    async withLease(operation, signal) { return operation(signal) },
    async getActive() { return null },
    async getActiveSummary() { return null },
    async getActiveDownload() { return null },
    async getCompact() { return null },
    async getUsagePriceBook() {
      return { kind: 'usage-price-book', official: null, manual: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] } }
    },
    async getUsagePriceBookForSnapshot() { throw new Error('Unexpected historical price read from API') },
    async getCompactDownload() { return null },
    async ensureCompact() { throw new Error('Unexpected compact mutation from read-only API') },
    async getLatestRun() { return null },
    async listHistory() { return { items: [], nextCursor: null } },
    async publish() { throw new Error('Unexpected publish from read-only API') },
    async writeRun() { throw new Error('Unexpected write from read-only API') },
  }

  it('requires authentication for all pricing endpoints', async () => {
    const app = await buildApp({
      config: config('easyauth'), repository: new MemoryTenantRepository(),
      pricing: { store: emptyPricingStore, starter: { async start() { throw new Error('Must not start') } } },
    })
    for (const url of ['/api/v1/pricing/status', '/api/v1/pricing/history', '/api/v1/pricing/download']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401)
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/pricing/sync', payload: {} })).statusCode).toBe(401)
    await app.close()
  })

  it('reports no snapshot honestly and validates history query limits', async () => {
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: { store: emptyPricingStore, starter: { async start() { return { executionName: 'execution-price-1' } } } },
    })
    const status = await app.inject({ method: 'GET', url: '/api/v1/pricing/status' })
    expect(status.json()).toMatchObject({ active: null, freshness: 'missing', ageHours: null, automaticUpdates: true })
    expect(status.headers['cache-control']).toBe('no-store')
    for (const query of ['limit=0', 'limit=51', 'cursor=../arbitrary-blob']) {
      expect((await app.inject({ method: 'GET', url: `/api/v1/pricing/history?${query}` })).statusCode).toBe(400)
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/history?limit=10' })).json()).toEqual({ items: [], nextCursor: null })
    await app.close()
  })

  const downloadSummary: PricingSnapshotSummary = {
    schemaVersion: 1, snapshotId: '33333333-3333-4333-8333-333333333333',
    fetchedAtUtc: '2026-10-05T00:00:00.000Z', source: 'fixture', apiVersion: '2023-01-01-preview',
    parserVersion: 1, currency: 'USD', cloud: 'AzureCloud', pageCount: 1, sourceRecordCount: 1,
    meterCount: 1, duplicateCount: 0, unsupportedMeterCount: 1, unrecognizedUnitCount: 0,
    contentHash: 'a'.repeat(64),
    changes: { previousSnapshotId: null, addedMeterCount: 1, removedMeterCount: 0, changedPriceCount: 0,
      unchangedMeterCount: 0, priceFromZeroCount: 0, largestPriceChangePercent: null },
  }

  it('downloads the complete stored JSON as a protected attachment, without transforming or filtering entries', async () => {
    const body = JSON.stringify({ ...downloadSummary, entries: [{ raw: { skuName: '6-luna ShortCo Inp Std Gl', retailPrice: 0.1 } }] })
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: {
        store: { ...emptyPricingStore, async getActiveDownload() {
          return { stream: Readable.from([body]), summary: downloadSummary, etag: '"download-version"', contentLength: Buffer.byteLength(body) }
        } },
        starter: { async start() { throw new Error('Download must not start a Job') } },
      },
    })
    const result = await app.inject({ method: 'GET', url: '/api/v1/pricing/download?format=raw' })
    expect(result.statusCode).toBe(200)
    expect(result.body).toBe(body)
    expect(result.headers['content-type']).toContain('application/json')
    expect(result.headers['content-disposition']).toBe('attachment; filename="aoai-pricing-raw.json"')
    expect(result.headers['cache-control']).toBe('private, no-store')
    expect(result.headers['x-pricing-snapshot-id']).toBe(downloadSummary.snapshotId)
    expect(result.headers.etag).toBe('"download-version"')
    await app.close()
  })

  it('returns explicit download errors for missing snapshots, changed versions and failed storage reads', async () => {
    const getter = vi.fn<PricingStore['getCompactDownload']>().mockResolvedValue(null)
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: { store: { ...emptyPricingStore, getCompactDownload: getter }, starter: { async start() { throw new Error('Unexpected start') } } },
    })
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/download' })).json())
      .toMatchObject({ status: 404, code: 'PRICE_SNAPSHOT_MISSING' })
    getter.mockRejectedValueOnce(new PricingDownloadChangedError())
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/download' })).json())
      .toMatchObject({ status: 409, code: 'PRICE_SNAPSHOT_CHANGED' })
    getter.mockRejectedValueOnce(new Error('Blob unavailable'))
    const failed = await app.inject({ method: 'GET', url: '/api/v1/pricing/download' })
    expect(failed.json()).toMatchObject({ status: 503, code: 'PRICE_DOWNLOAD_UNAVAILABLE' })
    expect(failed.headers['content-disposition']).toBeUndefined()
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/download?blob=../configuration/alerting.json' })).statusCode).toBe(400)
    expect(getter).toHaveBeenCalledTimes(3)
    await app.close()
  })

  it('uses compact JSON for the default download and keeps raw audit export explicit', async () => {
    const body = JSON.stringify({ kind: 'compact-official', models: ['gpt-4.1'], unitTokens: '1000000', rates: [], manualRates: [] })
    const compact = vi.fn<PricingStore['getCompactDownload']>().mockImplementation(async () => ({
      stream: Readable.from([body]), summary: downloadSummary, etag: '"compact-version"', contentLength: Buffer.byteLength(body),
    }))
    const raw = vi.fn<PricingStore['getActiveDownload']>().mockResolvedValue(null)
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: { store: { ...emptyPricingStore, getCompactDownload: compact, getActiveDownload: raw },
        starter: { async start() { throw new Error('No synchronization expected') } } },
    })
    const response = await app.inject('/api/v1/pricing/download')
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(body)
    expect(response.headers['content-disposition']).toBe('attachment; filename="aoai-pricing.json"')
    expect(compact).toHaveBeenCalledTimes(1)
    expect(raw).not.toHaveBeenCalled()
    expect((await app.inject('/api/v1/pricing/download?format=invalid')).statusCode).toBe(400)
    expect((await app.inject('/api/v1/pricing/download?format=raw')).statusCode).toBe(404)
    expect(raw).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('starts a price Job with 202 without claiming sync success or allowing custom templates', async () => {
    let starts = 0
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: {
        store: emptyPricingStore,
        starter: { async start() { starts += 1; return { executionName: 'price-execution-1' } } },
      },
    })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/pricing/sync', payload: {},
      headers: { accept: 'application/json', origin: 'http://localhost:80' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ executionName: 'price-execution-1', status: 'started' })
    expect(starts).toBe(1)
    const foreign = await app.inject({
      method: 'POST', url: '/api/v1/pricing/sync', payload: {},
      headers: { accept: 'application/json', origin: 'https://evil.example' },
    })
    expect(foreign.statusCode).toBe(403)
    const template = await app.inject({
      method: 'POST', url: '/api/v1/pricing/sync',
      headers: { accept: 'application/json' }, payload: { url: 'https://evil.example' },
    })
    expect(template.statusCode).toBe(400)
    expect(starts).toBe(1)
    const proxied = await app.inject({
      method: 'POST', url: '/api/v1/pricing/sync', payload: {},
      headers: {
        accept: 'application/json',
        host: '127.0.0.1:3100',
        origin: 'http://127.0.0.1:5173',
        'x-forwarded-host': '127.0.0.1:5173',
      },
    })
    expect(proxied.statusCode).toBe(202)
    expect(starts).toBe(2)
    await app.close()
  })

  it('returns explicit errors for unavailable/overlapping price sync instead of a false success', async () => {
    const unavailable = await buildApp({ config: config(), repository: new MemoryTenantRepository() })
    expect((await unavailable.inject({ method: 'GET', url: '/api/v1/pricing/status' })).statusCode).toBe(503)
    await unavailable.close()
    const busy = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: { store: emptyPricingStore, starter: { async start() { throw new PricingSyncBusyError() } } },
    })
    const response = await busy.inject({
      method: 'POST', url: '/api/v1/pricing/sync',
      headers: { accept: 'application/json' }, payload: {},
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('PRICING_SYNC_BUSY')
    await busy.close()
  })

  it('does not report storage failure as empty pricing status or history', async () => {
    const app = await buildApp({
      config: config(), repository: new MemoryTenantRepository(),
      pricing: {
        store: {
          ...emptyPricingStore,
          async getActiveSummary() { throw new Error('Storage unavailable') },
          async listHistory() { throw new Error('Storage unavailable') },
        },
        starter: { async start() { return { executionName: 'price-test' } } },
      },
    })
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/status' })).statusCode).toBe(503)
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/history' })).statusCode).toBe(503)
    await app.close()
  })

  it('returns the development session', async () => {
    const app = await buildApp({
      config: config(),
      repository: new MemoryTenantRepository(),
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      objectId: 'operator-1',
      name: 'operator@ms-ext.biz',
      authMode: 'development',
    })
    await app.close()
  })

  it('hides removed tenants by default while keeping history endpoints and explicit archive access', async () => {
    const repository = new MemoryTenantRepository()
    const created = await repository.createTenant({
      ...validBody, hourlyThresholdUsd: '25.00', notes: '',
    }, { objectId: 'operator', name: 'operator@ms-ext.biz' })
    repository.tenants.set(created.tenant.tenantId, {
      ...created.tenant, status: 'deleted', deletedAtUtc: '2026-10-04T12:00:00.000Z',
    })
    const app = await buildApp({ config: config(), repository })
    expect((await app.inject({ method: 'GET', url: '/api/v1/tenants' })).json().items).toEqual([])
    const archived = await app.inject({ method: 'GET', url: '/api/v1/tenants?includeRemoved=true' })
    expect(archived.json().items[0].status).toBe('deleted')
    expect((await app.inject({ method: 'GET', url: `/api/v1/tenants/${created.tenant.tenantId}` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/v1/tenants?includeRemoved=invalid' })).statusCode).toBe(400)
    await app.close()
  })

  it('requires Easy Auth headers and accepts protected identity headers', async () => {
    const app = await buildApp({
      config: config('easyauth'),
      repository: new MemoryTenantRepository(),
    })
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
    })
    expect(unauthorized.statusCode).toBe(401)

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: {
        'x-ms-client-principal-id': 'entra-object-id',
        'x-ms-client-principal-name': 'operator@ms-ext.biz',
      },
    })
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json().authMode).toBe('easyauth')
    await app.close()
  })

  it('creates, lists and reads a pending authorization tenant', async () => {
    const repository = new MemoryTenantRepository()
    const app = await buildApp({ config: config(), repository })

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: validBody,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().tenant).toMatchObject({
      tenantId: validBody.tenantId,
      hourlyThresholdUsd: '25.00',
      status: 'pendingAuthorization',
      createdByObjectId: 'operator-1',
    })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
    })
    expect(listed.json().count).toBe(1)

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${validBody.tenantId}`,
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().tenant.displayName).toBe(validBody.displayName)
    await app.close()
  })

  it('edits current tenant name and hourly limit with an ETag while preserving its authorization and other configuration', async () => {
    const repository = new MemoryTenantRepository()
    const created = await repository.createTenant({ ...validBody, notes: 'Preserved notes' }, { objectId: 'original-actor', name: 'Original' })
    repository.tenants.set(validBody.tenantId, { ...created.tenant, status: 'active' })
    const app = await buildApp({ config: config(), repository })
    const update = vi.spyOn(repository, 'updateTenantSettings')
    const edited = await app.inject({
      method: 'PATCH', url: `/api/v1/tenants/${validBody.tenantId}`, headers: { 'if-match': created.tenant.etag },
      payload: { displayName: ' 修改后租户 ', hourlyThresholdUsd: '12.500' },
    })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().tenant).toMatchObject({
      displayName: '修改后租户', hourlyThresholdUsd: '12.50', status: 'active',
      notes: 'Preserved notes', createdByObjectId: 'original-actor',
    })
    expect(update).toHaveBeenCalledWith(validBody.tenantId,
      { displayName: '修改后租户', hourlyThresholdUsd: '12.50' }, created.tenant.etag,
      { objectId: 'operator-1', name: 'operator@ms-ext.biz' }, expect.any(String))
    expect((await app.inject({ method: 'GET', url: '/api/v1/tenants' })).json().items[0].displayName).toBe('修改后租户')
    expect((await app.inject({
      method: 'PATCH', url: `/api/v1/tenants/${validBody.tenantId}`, headers: { 'if-match': created.tenant.etag },
      payload: { displayName: 'Stale', hourlyThresholdUsd: '1.00' },
    })).statusCode).toBe(412)
    await app.close()
  })

  it('authenticates tenant edits, rejects cross-origin writes and prevents privilege changes or invalid amounts', async () => {
    const repository = new MemoryTenantRepository()
    const update = vi.spyOn(repository, 'updateTenantSettings')
    const request = {
      method: 'PATCH' as const, url: `/api/v1/tenants/${validBody.tenantId}`,
      headers: { 'if-match': '"etag-1"' }, payload: { displayName: 'New', hourlyThresholdUsd: '10' },
    }
    const unauthorized = await buildApp({ config: config('easyauth'), repository })
    expect((await unauthorized.inject(request)).statusCode).toBe(401)
    await unauthorized.close()
    const app = await buildApp({ config: config(), repository })
    expect((await app.inject({ ...request, headers: { ...request.headers, origin: 'https://untrusted.example' } })).statusCode).toBe(403)
    for (const payload of [
      { displayName: '', hourlyThresholdUsd: '10' },
      { displayName: 'New', hourlyThresholdUsd: '0' },
      { displayName: 'New', hourlyThresholdUsd: '10', status: 'active' },
    ]) expect((await app.inject({ ...request, payload })).statusCode).toBe(400)
    for (const etag of [null, '*', 'W/"etag-1"', '"etag-1","etag-2"']) {
      expect((await app.inject({ ...request, headers: etag ? { 'if-match': etag } : {} })).statusCode).toBe(428)
    }
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects archived tenant edits and reports busy or unconfirmed storage/audit results explicitly', async () => {
    const repository = new MemoryTenantRepository()
    const created = await repository.createTenant({ ...validBody, notes: '' }, { objectId: 'actor', name: 'Actor' })
    repository.tenants.set(validBody.tenantId, { ...created.tenant, status: 'deleted' })
    const app = await buildApp({ config: config(), repository })
    const request = { method: 'PATCH' as const, url: `/api/v1/tenants/${validBody.tenantId}`,
      headers: { 'if-match': created.tenant.etag }, payload: { displayName: 'New', hourlyThresholdUsd: '10' } }
    expect((await app.inject(request)).json()).toMatchObject({ status: 409, code: 'TENANT_CANNOT_BE_UPDATED' })
    const update = vi.spyOn(repository, 'updateTenantSettings')
    update.mockRejectedValueOnce(new StorageLeaseBusyError())
    expect((await app.inject(request)).json()).toMatchObject({ status: 409, code: 'TENANT_OPERATION_BUSY' })
    update.mockRejectedValueOnce(new Error('Audit/storage unavailable'))
    expect((await app.inject(request)).json()).toMatchObject({ status: 503, code: 'TENANT_UPDATE_FAILED' })
    update.mockRejectedValueOnce(new TenantNotFoundError(validBody.tenantId))
    expect((await app.inject(request)).statusCode).toBe(404)
    await app.close()
  })

  it('returns validation problems and protects duplicate tenant ids', async () => {
    const app = await buildApp({
      config: config(),
      repository: new MemoryTenantRepository(),
    })
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: { ...validBody, hourlyThresholdUsd: '0' },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.headers['content-type']).toContain(
      'application/problem+json',
    )
    expect(invalid.json().code).toBe('VALIDATION_FAILED')

    await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: validBody,
    })
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      payload: validBody,
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().code).toBe('TENANT_ALREADY_EXISTS')
    await app.close()
  })

  it('deletes a pending registration with the current ETag and permits a new registration', async () => {
    const repository = new MemoryTenantRepository()
    const app = await buildApp({ config: config(), repository })
    const created = await app.inject({ method: 'POST', url: '/api/v1/tenants', payload: validBody })
    const remove = vi.spyOn(repository, 'deletePendingTenant')
    const deleted = await app.inject({
      method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {},
      headers: { 'if-match': created.json().tenant.etag, 'x-correlation-id': 'delete-registration-test' },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ tenantId: validBody.tenantId, deleted: true })
    expect(remove).toHaveBeenCalledWith(validBody.tenantId, '"etag-1"',
      { objectId: 'operator-1', name: 'operator@ms-ext.biz' }, 'delete-registration-test')
    expect((await app.inject({ method: 'GET', url: '/api/v1/tenants?includeRemoved=true' })).json().count).toBe(0)
    expect((await app.inject({ method: 'GET', url: `/api/v1/tenants/${validBody.tenantId}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/v1/tenants', payload: validBody })).statusCode).toBe(201)
    await app.close()
  })

  it('requires Entra authentication and same-origin JSON for registration deletion', async () => {
    const repository = new MemoryTenantRepository()
    const remove = vi.spyOn(repository, 'deletePendingTenant')
    const unauthorized = await buildApp({ config: config('easyauth'), repository })
    expect((await unauthorized.inject({
      method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {}, headers: { 'if-match': '"etag-1"' },
    })).statusCode).toBe(401)
    await unauthorized.close()
    const app = await buildApp({ config: config(), repository })
    for (const headers of [
      { origin: 'https://untrusted.example' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await app.inject({
        method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {},
        headers: { 'if-match': '"etag-1"', ...headers },
      })).statusCode).toBe(403)
    }
    expect((await app.inject({
      method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: '{}',
      headers: { 'if-match': '"etag-1"', 'content-type': 'text/plain' },
    })).statusCode).toBe(403)
    expect(remove).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects invalid deletion bodies, IDs and missing, wildcard or multiple ETags', async () => {
    const repository = new MemoryTenantRepository()
    const remove = vi.spyOn(repository, 'deletePendingTenant')
    const app = await buildApp({ config: config(), repository })
    for (const [tenantId, payload] of [
      ['not-a-guid', {}], [validBody.tenantId, { force: true }],
    ] as const) {
      expect((await app.inject({
        method: 'DELETE', url: `/api/v1/tenants/${tenantId}`, payload, headers: { 'if-match': '"etag-1"' },
      })).statusCode).toBe(400)
    }
    for (const etag of [null, '*', 'W/"etag-1"', '"etag-1","etag-2"', '""']) {
      expect((await app.inject({
        method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {},
        headers: etag === null ? {} : { 'if-match': etag },
      })).statusCode).toBe(428)
    }
    expect(remove).not.toHaveBeenCalled()
    await app.close()
  })

  it.each(['discovered', 'active', 'degraded', 'disconnected', 'disabled', 'deleted'] as const)(
    'never hard-deletes a %s tenant', async (status) => {
      const repository = new MemoryTenantRepository()
      const created = await repository.createTenant({ ...validBody, notes: '' }, { objectId: 'actor', name: 'actor' })
      repository.tenants.set(validBody.tenantId, { ...created.tenant, status })
      const app = await buildApp({ config: config(), repository })
      const result = await app.inject({
        method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {}, headers: { 'if-match': created.tenant.etag },
      })
      expect(result.statusCode).toBe(409)
      expect(result.json().code).toBe('TENANT_CANNOT_BE_DELETED')
      expect(repository.tenants.has(validBody.tenantId)).toBe(true)
      await app.close()
    },
  )

  it('reports stale, busy, missing and uncertain deletion outcomes without pretending success', async () => {
    const repository = new MemoryTenantRepository()
    const created = await repository.createTenant({ ...validBody, notes: '' }, { objectId: 'actor', name: 'actor' })
    const app = await buildApp({ config: config(), repository })
    const remove = vi.spyOn(repository, 'deletePendingTenant')
    const request = {
      method: 'DELETE' as const, url: `/api/v1/tenants/${validBody.tenantId}`, payload: {},
      headers: { 'if-match': created.tenant.etag },
    }
    const stale = await app.inject({ ...request, headers: { 'if-match': '"stale"' } })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().code).toBe('TENANT_ETAG_MISMATCH')
    remove.mockRejectedValueOnce(new StorageLeaseBusyError())
    expect((await app.inject(request)).json()).toMatchObject({ status: 409, code: 'TENANT_OPERATION_BUSY' })
    remove.mockRejectedValueOnce(new TenantNotFoundError(validBody.tenantId))
    expect((await app.inject(request)).statusCode).toBe(404)
    remove.mockRejectedValueOnce(new Error('Storage unavailable'))
    expect((await app.inject(request)).json()).toMatchObject({ status: 503, code: 'TENANT_DELETE_FAILED' })
    expect(repository.tenants.has(validBody.tenantId)).toBe(true)
    await app.close()
  })

  it('returns an explicit audit warning when deletion succeeded but completion recording failed', async () => {
    const repository = new MemoryTenantRepository()
    const created = await repository.createTenant({ ...validBody, notes: '' }, { objectId: 'actor', name: 'actor' })
    repository.deletionAuditCompletionRecorded = false
    const app = await buildApp({ config: config(), repository })
    const deleted = await app.inject({
      method: 'DELETE', url: `/api/v1/tenants/${validBody.tenantId}`, payload: {}, headers: { 'if-match': created.tenant.etag },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      deleted: true, warnings: [{ code: 'AUDIT_COMPLETION_WRITE_FAILED' }],
    })
    expect(repository.tenants.has(validBody.tenantId)).toBe(false)
    await app.close()
  })

  it('reports storage readiness failure', async () => {
    const repository = new MemoryTenantRepository()
    repository.ready = false
    const app = await buildApp({ config: config(), repository })
    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().code).toBe('STORAGE_NOT_READY')
    await app.close()
  })

  it('starts authorization sync and returns the latest run', async () => {
    const repository = new MemoryTenantRepository()
    repository.latestRun = {
      schemaVersion: 1,
      runId: '11111111-1111-4111-8111-111111111111',
      status: 'succeeded',
      startedAtUtc: '2026-09-29T08:00:00.000Z',
      finishedAtUtc: '2026-09-29T08:01:00.000Z',
      discoveredTenantCount: 1,
      visibleSubscriptionCount: 2,
      updatedTenantCount: 1,
      errors: [],
    }
    const app = await buildApp({
      config: config(),
      repository,
      authorizationSyncStarter: {
        async start() {
          return { executionName: 'execution-1' }
        },
      },
    })
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/authorization/sync',
    })
    expect(started.statusCode).toBe(202)
    expect(started.json().executionName).toBe('execution-1')

    const latest = await app.inject({
      method: 'GET',
      url: '/api/v1/authorization/runs/latest',
    })
    expect(latest.json().run.status).toBe('succeeded')
    await app.close()
  })

  it('reads subscriptions and enables a discovered tenant', async () => {
    const repository = new MemoryTenantRepository()
    const tenantId = validBody.tenantId
    const created = await repository.createTenant(
      {
        ...validBody,
        hourlyThresholdUsd: '25.00',
        notes: '',
      },
      {
        objectId: 'operator-1',
        name: 'operator@ms-ext.biz',
      },
    )
    repository.tenants.set(tenantId, {
      ...created.tenant,
      status: 'discovered',
    })
    repository.inventories.set(tenantId, {
      schemaVersion: 1,
      revision: 1,
      tenantId,
      expectedSubscriptionIds: [
        '22222222-2222-4222-8222-222222222222',
      ],
      subscriptions: [
        {
          subscriptionId:
            '22222222-2222-4222-8222-222222222222',
          displayName: 'Customer Subscription',
          customerTenantId: tenantId,
          state: 'Enabled',
          firstSeenAtUtc: '2026-09-29T08:00:00.000Z',
          lastSeenAtUtc: '2026-09-29T08:00:00.000Z',
          lastValidatedAtUtc: '2026-09-29T08:00:00.000Z',
        },
      ],
      observedAtUtc: '2026-09-29T08:00:00.000Z',
      updatedAtUtc: '2026-09-29T08:00:00.000Z',
    })
    const app = await buildApp({
      config: config(),
      repository,
    })

    const inventory = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/subscriptions`,
    })
    expect(inventory.json().inventory.subscriptions).toHaveLength(1)

    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/enable`,
      payload: {
        displayName: 'Enabled Customer',
        hourlyThresholdUsd: '30.00',
        etag: created.tenant.etag,
      },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().tenant.status).toBe('active')
    await app.close()
  })
})
