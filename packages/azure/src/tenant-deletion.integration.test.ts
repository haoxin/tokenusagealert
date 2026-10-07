import { randomUUID } from 'node:crypto'
import { BlobClient, BlobServiceClient, BlockBlobClient } from '@azure/storage-blob'
import { describe, expect, it, vi } from 'vitest'
import { AuditEventSchema, type TenantListItem } from '@tokenusagealert/schemas'
import {
  BlobTenantRepository, TenantCannotBeDeletedError, TenantConcurrencyError, TenantNotFoundError,
} from './index.js'
import { AuthorizationSyncService, FixtureSubscriptionDiscovery } from './authorization.js'
import { StorageLeaseBusyError } from './blob-lease.js'

const connectionString = 'UseDevelopmentStorage=true'
const tenantId = '11111111-1111-4111-8111-111111111111'
const actor = { objectId: 'deletion-test-operator', name: 'operator@ms-ext.biz' }
const request = { tenantId, displayName: '待授权删除测试', hourlyThresholdUsd: '10.00', notes: '' }
const subscription = {
  subscriptionId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Fixture delegated subscription', tenantId, state: 'Enabled',
}

async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = {
    configurationContainerName: `delete-config-${suffix}`, auditContainerName: `delete-audit-${suffix}`,
    inventoryContainerName: `delete-inventory-${suffix}`, operationsContainerName: `delete-ops-${suffix}`,
  }
  const repository = new BlobTenantRepository({ connectionString, autoCreateContainers: true, ...names })
  const service = BlobServiceClient.fromConnectionString(connectionString)
  await repository.initialize()
  const created = await repository.createTenant(request, actor, 'fixture-create')
  const configuration = service.getContainerClient(names.configurationContainerName)
  const audit = service.getContainerClient(names.auditContainerName)
  return {
    repository, created, configuration, audit, service, names,
    cleanup: async () => { await Promise.all(Object.values(names).map((name) => service.getContainerClient(name).delete())) },
  }
}

describe('pending tenant registration hard deletion', () => {
  it('removes the active configuration JSON, preserves other data and permits registration again', async () => {
    const f = await fixture()
    try {
      const preserved = f.service.getContainerClient(f.names.operationsContainerName).getBlockBlobClient(`fixture-history/${tenantId}.json`)
      await preserved.uploadData(Buffer.from('{"amountUsd":"12.00"}'))
      const result = await f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'delete-test')
      expect(result).toEqual({ tenantId, auditCompletionRecorded: true })
      expect(await f.configuration.getBlobClient(`tenants/${tenantId}.json`).exists()).toBe(false)
      expect(await f.repository.listTenants()).toEqual([])
      await expect(f.repository.getTenant(tenantId)).rejects.toBeInstanceOf(TenantNotFoundError)
      expect((await preserved.downloadToBuffer()).toString()).toBe('{"amountUsd":"12.00"}')
      const auditEvents = []
      for await (const blob of f.audit.listBlobsFlat()) {
        auditEvents.push(AuditEventSchema.parse(JSON.parse((await f.audit.getBlobClient(blob.name).downloadToBuffer()).toString())))
      }
      expect(auditEvents.filter((event) => event.action.startsWith('tenant.delete.'))).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'tenant.delete.requested', outcome: 'attempted', actorObjectId: actor.objectId }),
        expect.objectContaining({ action: 'tenant.delete.completed', outcome: 'succeeded', correlationId: 'delete-test' }),
      ]))
      expect((await f.repository.createTenant(request, actor, 'register-again')).tenant.status).toBe('pendingAuthorization')
    } finally { await f.cleanup() }
  })

  it.each(['discovered', 'active', 'degraded', 'disconnected', 'disabled', 'deleted'] as const)(
    'preserves %s tenant configurations', async (status) => {
      const f = await fixture()
      try {
        const { etag: _etag, ...document } = f.created.tenant
        await f.configuration.getBlockBlobClient(`tenants/${tenantId}.json`).uploadData(Buffer.from(JSON.stringify({
          ...document, status, deletedAtUtc: status === 'deleted' ? new Date().toISOString() : null,
        })))
        const tenant = await f.repository.getTenant(tenantId)
        await expect(f.repository.deletePendingTenant(tenantId, tenant.etag, actor, 'protected-status'))
          .rejects.toBeInstanceOf(TenantCannotBeDeletedError)
        expect(await f.repository.getTenant(tenantId)).toEqual(tenant)
      } finally { await f.cleanup() }
    },
  )

  it('rejects a stale ETag and a repeated deletion instead of hiding conflicts', async () => {
    const f = await fixture()
    try {
      await expect(f.repository.deletePendingTenant(tenantId, '"stale"', actor, 'stale'))
        .rejects.toBeInstanceOf(TenantConcurrencyError)
      expect(await f.repository.getTenant(tenantId)).toEqual(f.created.tenant)
      await f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'first-delete')
      await expect(f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'second-delete'))
        .rejects.toBeInstanceOf(TenantNotFoundError)
    } finally { await f.cleanup() }
  })

  it.each(['visible', 'expected'] as const)('refuses deletion while %s subscriptions remain', async (kind) => {
    const f = await fixture()
    try {
      const now = new Date().toISOString()
      await f.repository.writeSubscriptionInventory({
        schemaVersion: 1, revision: 1, tenantId, observedAtUtc: now, updatedAtUtc: now,
        expectedSubscriptionIds: kind === 'expected' ? [subscription.subscriptionId] : [],
        subscriptions: kind === 'visible' ? [{
          subscriptionId: subscription.subscriptionId, displayName: subscription.displayName, customerTenantId: tenantId,
          state: 'Enabled', firstSeenAtUtc: now, lastSeenAtUtc: now, lastValidatedAtUtc: now,
        }] : [],
      })
      await expect(f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'has-scope'))
        .rejects.toBeInstanceOf(TenantCannotBeDeletedError)
      expect(await f.repository.getTenant(tenantId)).toEqual(f.created.tenant)
    } finally { await f.cleanup() }
  })

  it('does not race an authorization operation holding the tenant lease', async () => {
    const f = await fixture()
    const acquired = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = f.repository.withTenantAuthorizationLease(tenantId, async () => {
      acquired.resolve()
      await release.promise
    })
    try {
      await acquired.promise
      await expect(f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'busy'))
        .rejects.toBeInstanceOf(StorageLeaseBusyError)
      expect(await f.repository.getTenant(tenantId)).toEqual(f.created.tenant)
    } finally { release.resolve(); await held; await f.cleanup() }
  })

  it.each(['tenant.delete.requested', 'tenant.delete.completed'] as const)(
    'handles failure writing %s without a misleading outcome', async (failedAction) => {
      const f = await fixture()
      const upload = BlockBlobClient.prototype.upload
      const spy = vi.spyOn(BlockBlobClient.prototype, 'upload').mockImplementation(
        async function(this: BlockBlobClient, body, length, options) {
          if (this.url.startsWith(`${f.audit.url}/`) && typeof body === 'string' &&
            AuditEventSchema.parse(JSON.parse(body)).action === failedAction) throw new Error('Simulated audit failure')
          return upload.call(this, body, length, options)
        },
      )
      try {
        const deletion = f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'audit-failure')
        if (failedAction === 'tenant.delete.requested') {
          await expect(deletion).rejects.toThrow('Simulated audit failure')
          expect(await f.repository.getTenant(tenantId)).toEqual(f.created.tenant)
        } else {
          expect(await deletion).toEqual({ tenantId, auditCompletionRecorded: false })
          expect(await f.configuration.getBlobClient(`tenants/${tenantId}.json`).exists()).toBe(false)
        }
      } finally { spy.mockRestore(); await f.cleanup() }
    },
  )

  it('lists remaining tenants if a listed JSON is concurrently deleted before reading it', async () => {
    const f = await fixture()
    await f.repository.createTenant({ ...request, tenantId: '33333333-3333-4333-8333-333333333333' }, actor, 'other-tenant')
    const targetUrl = f.configuration.getBlobClient(`tenants/${tenantId}.json`).url
    const properties = BlobClient.prototype.getProperties
    let deleteBeforeRead = true
    const spy = vi.spyOn(BlobClient.prototype, 'getProperties').mockImplementation(
      async function(this: BlobClient, options) {
        if (this.url === targetUrl && deleteBeforeRead) {
          deleteBeforeRead = false
          await this.delete()
        }
        return properties.call(this, options)
      },
    )
    try {
      expect((await f.repository.listTenants()).map((tenant) => tenant.tenantId))
        .toEqual(['33333333-3333-4333-8333-333333333333'])
    } finally { spy.mockRestore(); await f.cleanup() }
  })

  it.each([false, true])('synchronizes safely if deletion occurs after its tenant snapshot (delegated=%s)', async (delegated) => {
    const f = await fixture()
    const list = f.repository.listTenants.bind(f.repository)
    const spy = vi.spyOn(f.repository, 'listTenants').mockImplementationOnce(async (): Promise<TenantListItem[]> => {
      const snapshot = await list()
      await f.repository.deletePendingTenant(tenantId, f.created.tenant.etag, actor, 'during-sync')
      return snapshot
    })
    try {
      const run = await new AuthorizationSyncService(f.repository, new FixtureSubscriptionDiscovery(delegated ? [subscription] : [])).run()
      expect(run.status).toBe('succeeded')
      expect(run.errors).toEqual([])
      if (delegated) {
        expect(await f.repository.getTenant(tenantId)).toMatchObject({
          status: 'discovered', hourlyThresholdUsd: null, authorizationSource: 'lighthouse-template',
        })
        expect((await f.repository.getSubscriptionInventory(tenantId))?.subscriptions).toHaveLength(1)
      } else {
        await expect(f.repository.getTenant(tenantId)).rejects.toBeInstanceOf(TenantNotFoundError)
      }
    } finally { spy.mockRestore(); await f.cleanup() }
  })
})
