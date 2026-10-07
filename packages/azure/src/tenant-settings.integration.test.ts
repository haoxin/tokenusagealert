import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { AuditEventSchema } from '@tokenusagealert/schemas'
import { BlobTenantRepository, TenantCannotBeUpdatedError, TenantConcurrencyError } from './index.js'
import { AuthorizationSyncService, FixtureSubscriptionDiscovery } from './authorization.js'
import { BlobUsageStore, EmptyUsageSource, UsageCollectionService } from './usage.js'
import { StorageLeaseBusyError } from './blob-lease.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const tenantId = '11111111-1111-4111-8111-111111111111'
const actor = { objectId: 'operator', name: 'local.operator@ms-ext.biz' }
async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { configuration: `edit-config-${suffix}`, audit: `edit-audit-${suffix}`,
    inventory: `edit-inventory-${suffix}`, operations: `edit-ops-${suffix}`, usage: `edit-usage-${suffix}` }
  const repository = new BlobTenantRepository({
    connectionString: 'UseDevelopmentStorage=true', autoCreateContainers: true,
    configurationContainerName: names.configuration, auditContainerName: names.audit,
    inventoryContainerName: names.inventory, operationsContainerName: names.operations,
  })
  const usage = new BlobUsageStore(client, names)
  await repository.initialize(); await usage.initialize(true)
  let now = new Date('2026-10-05T02:15:00.000Z')
  await repository.createTenant({ tenantId, displayName: '原租户名称', hourlyThresholdUsd: '10.00', notes: 'Preserve notes' }, actor, 'create', now)
  await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([{
    subscriptionId: '22222222-2222-4222-8222-222222222222', tenantId, displayName: 'Fixture subscription', state: 'Enabled',
  }]), () => now).run()
  const discovered = await repository.getTenant(tenantId)
  await repository.enableTenant(tenantId, {
    displayName: discovered.displayName, hourlyThresholdUsd: '10.00', etag: discovered.etag,
  }, actor, 'enable', now)
  const collector = new UsageCollectionService(repository, usage, { async getUsagePriceBook() {
    return { kind: 'usage-price-book' as const, official: null,
      manual: { schemaVersion: 1 as const, revision: 0, snapshotId: null, versions: [] } }
  } }, new EmptyUsageSource(), { now: () => now })
  return {
    repository, usage, collector, names, setNow: (date: Date) => { now = date },
    cleanup: async () => { await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete())) },
  }
}

describe('managed tenant name and hourly limit updates', () => {
  it('persists new fields with audit while preserving authorization, history and the threshold of an already-calculated hour', async () => {
    const f = await fixture()
    try {
      await f.collector.run()
      const before = await f.repository.getTenant(tenantId)
      const inventory = await f.repository.getSubscriptionInventory(tenantId)
      const edited = await f.repository.updateTenantSettings(tenantId, {
        displayName: ' 新租户名称 ', hourlyThresholdUsd: '15.7500',
      }, before.etag, actor, 'tenant-edit')
      expect(edited).toMatchObject({
        displayName: '新租户名称', hourlyThresholdUsd: '15.75', status: before.status,
        notes: before.notes, authorizationSource: before.authorizationSource, createdByObjectId: before.createdByObjectId,
      })
      expect(await f.repository.getTenant(tenantId)).toEqual(edited)
      expect(await f.repository.getSubscriptionInventory(tenantId)).toEqual(inventory)
      await f.collector.run()
      f.setNow(new Date('2026-10-05T03:15:00.000Z'))
      await f.collector.run()
      const hours = await f.usage.hours(tenantId, 24, new Date('2026-10-05T04:00:00.000Z'))
      expect(hours.map((hour) => [hour.windowStartUtc, hour.thresholdUsd])).toEqual([
        ['2026-10-05T01:00:00.000Z', '10.00'],
        ['2026-10-05T02:00:00.000Z', '15.75'],
      ])
      const events = []
      const audit = client.getContainerClient(f.names.audit)
      for await (const blob of audit.listBlobsFlat()) {
        events.push(AuditEventSchema.parse(JSON.parse((await audit.getBlobClient(blob.name).downloadToBuffer()).toString())))
      }
      expect(events.find((event) => event.action === 'tenant.settings.updated')).toMatchObject({
        actorObjectId: actor.objectId, correlationId: 'tenant-edit', changedFields: ['displayName', 'hourlyThresholdUsd'],
      })
    } finally { await f.cleanup() }
  })

  it.each(['pendingAuthorization', 'discovered', 'active', 'degraded', 'disconnected', 'disabled'] as const)(
    'allows editing a current %s tenant without changing its state', async (status) => {
      const f = await fixture()
      try {
        const previous = await f.repository.getTenant(tenantId)
        const current = await f.repository.updateTenantAuthorization(previous, status, 'fixture-status')
        const updated = await f.repository.updateTenantSettings(tenantId, {
          displayName: 'Editable tenant', hourlyThresholdUsd: '25.00',
        }, current.etag, actor, 'edit-state')
        expect(updated.status).toBe(status)
        expect(updated.hourlyThresholdUsd).toBe('25.00')
      } finally { await f.cleanup() }
    },
  )

  it('rejects stale or archived edits, keeps no-op revisions stable and coordinates with tenant authorization leases', async () => {
    const f = await fixture()
    const release = Promise.withResolvers<void>()
    let held: Promise<void> | null = null
    try {
      const tenant = await f.repository.getTenant(tenantId)
      const input = { displayName: tenant.displayName, hourlyThresholdUsd: tenant.hourlyThresholdUsd! }
      expect(await f.repository.updateTenantSettings(tenantId, input, tenant.etag, actor, 'no-op')).toEqual(tenant)
      await expect(f.repository.updateTenantSettings(tenantId, input, '"stale"', actor, 'stale')).rejects.toBeInstanceOf(TenantConcurrencyError)
      const acquired = Promise.withResolvers<void>()
      held = f.repository.withTenantAuthorizationLease(tenantId, async () => { acquired.resolve(); await release.promise })
      await acquired.promise
      await expect(f.repository.updateTenantSettings(tenantId, input, tenant.etag, actor, 'busy')).rejects.toBeInstanceOf(StorageLeaseBusyError)
      release.resolve(); await held; held = null
      const archived = await f.repository.updateTenantAuthorization(tenant, 'deleted', 'archive')
      await expect(f.repository.updateTenantSettings(tenantId, input, archived.etag, actor, 'archived')).rejects.toBeInstanceOf(TenantCannotBeUpdatedError)
      expect(await f.repository.getTenant(tenantId)).toEqual(archived)
    } finally { release.resolve(); if (held) await held; await f.cleanup() }
  })
})
