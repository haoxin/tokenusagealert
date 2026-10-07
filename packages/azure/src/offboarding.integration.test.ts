import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it, vi } from 'vitest'
import type { OffboardingTarget, SubscriptionInventoryDocument, TenantListItem } from '@tokenusagealert/schemas'
import { BlobOffboardingStore, OffboardingError, OffboardingService, type DelegationRemovalClient } from './offboarding.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const tenantId = '11111111-1111-4111-8111-111111111111'
const subId = '22222222-2222-4222-8222-222222222222'
const target: OffboardingTarget = {
  subscriptionId: subId, displayName: 'Fixture subscription',
  assignmentId: `/subscriptions/${subId}/providers/Microsoft.ManagedServices/registrationAssignments/${tenantId}`,
  definitionId: `/subscriptions/${subId}/providers/Microsoft.ManagedServices/registrationDefinitions/${tenantId}`,
  fingerprint: 'a'.repeat(64), state: 'ready', message: null,
}
async function fixture() {
  const container = client.getContainerClient(`offboarding-${randomUUID().replaceAll('-', '')}`)
  await container.createIfNotExists()
  const store = new BlobOffboardingStore(client, container.containerName)
  const now = new Date().toISOString()
  const tenant: TenantListItem = {
    schemaVersion: 1, revision: 1, tenantId, displayName: 'Fixture tenant', status: 'active',
    hourlyThresholdUsd: '10.00', authorizationSource: 'lighthouse-template', notes: '',
    createdByName: 'operator', createdByObjectId: 'operator', createdAtUtc: now, updatedAtUtc: now,
    deletedAtUtc: null, etag: '"one"',
  }
  const inventory: SubscriptionInventoryDocument = {
    schemaVersion: 1, revision: 1, tenantId, expectedSubscriptionIds: [subId],
    subscriptions: [{ subscriptionId: subId, displayName: target.displayName, customerTenantId: tenantId, state: 'Enabled',
      firstSeenAtUtc: now, lastSeenAtUtc: now, lastValidatedAtUtc: now }],
    observedAtUtc: now, updatedAtUtc: now,
  }
  const repository = {
    async getTenant() { return tenant },
    async getSubscriptionInventory() { return inventory },
  }
  const remover: DelegationRemovalClient = {
    identity: { clientId: randomUUID(), principalId: randomUUID(), collectorPrincipalId: randomUUID(), managingTenantId: randomUUID(), offerName: 'AOAI Cost Usage Monitoring' },
    inspect: vi.fn(async () => ({ ...target })),
    remove: vi.fn(async (_tenant, item, before) => { await before(); return { ...item, state: 'submitted', message: 'Mock accepted' } }),
  }
  const sync = { start: vi.fn(async () => ({ executionName: 'fixture-sync' })) }
  return {
    store, tenant, inventory, remover, sync,
    service: new OffboardingService(repository, remover, store, sync),
    cleanup: () => container.delete(),
  }
}

describe('offboarding confirmation journal', () => {
  it('persists preview, requires the same operator and exact target ID, and never repeats a consumed operation', async () => {
    const f = await fixture()
    try {
      const result = await f.service.preview(tenantId, subId, 'operator')
      expect(result.operation?.status).toBe('prepared')
      expect(f.remover.remove).not.toHaveBeenCalled()
      const id = result.operation!.id
      await expect(f.service.execute(id, tenantId, 'operator')).rejects.toMatchObject({ code: 'OFFBOARDING_CONFIRMATION_REQUIRED' })
      await expect(f.service.execute(id, subId, 'another-operator')).rejects.toMatchObject({ code: 'OFFBOARDING_ACTOR_MISMATCH' })
      expect(f.remover.remove).not.toHaveBeenCalled()
      const executed = await f.service.execute(id, subId, 'operator')
      expect(executed.status).toBe('submitted')
      expect(executed.synchronizationRequested).toBe(true)
      await f.service.execute(id, subId, 'operator')
      expect(f.remover.remove).toHaveBeenCalledTimes(1)
      expect((await f.store.read(id)).operation.status).toBe('submitted')
    } finally { await f.cleanup() }
  })

  it('persists a reused definition reference without changing the subscription to be offboarded', async () => {
    const f = await fixture()
    const sharedDefinitionId = target.definitionId.replace(subId, '33333333-3333-4333-8333-333333333333')
    vi.mocked(f.remover.inspect).mockResolvedValue({ ...target, definitionId: sharedDefinitionId })
    try {
      const preview = await f.service.preview(tenantId, subId, 'operator')
      const operation = (await f.store.read(preview.operation!.id)).operation
      expect(operation.targets[0]).toMatchObject({
        subscriptionId: subId, assignmentId: target.assignmentId, definitionId: sharedDefinitionId,
      })
      const submitted = await f.service.execute(operation.id, subId, 'operator')
      expect(submitted.status).toBe('submitted')
      expect(submitted.targets[0]?.definitionId).toBe(sharedDefinitionId)
      expect(submitted.targets[0]?.subscriptionId).toBe(subId)
      expect(f.remover.remove).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })

  it('does not prepare destructive work for legacy authorizations or an expired plan', async () => {
    const f = await fixture()
    try {
      vi.mocked(f.remover.inspect).mockRejectedValueOnce(new OffboardingError('CUSTOMER_REAUTHORIZATION_REQUIRED', 'Customer approval required'))
      const denied = await f.service.preview(tenantId, null, 'operator')
      expect(denied.operation).toBeNull()
      expect(denied.blockers[0]?.code).toBe('CUSTOMER_REAUTHORIZATION_REQUIRED')
      expect(f.remover.remove).not.toHaveBeenCalled()
      const result = await f.service.preview(tenantId, subId, 'operator')
      const stored = await f.store.read(result.operation!.id)
      await f.store.write({ ...stored.operation, expiresAtUtc: '2020-01-01T00:00:00.000Z' }, stored.etag)
      await expect(f.service.execute(stored.operation.id, subId, 'operator')).rejects.toMatchObject({ code: 'OFFBOARDING_PLAN_EXPIRED' })
      expect(f.remover.remove).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('retains partial outcomes and explicit sync failures instead of reporting success', async () => {
    const f = await fixture()
    try {
      vi.mocked(f.remover.remove).mockImplementationOnce(async (_tenant, item, before) => {
        await before()
        return { ...item, state: 'unknown', message: 'Network result unknown' }
      })
      f.sync.start.mockRejectedValueOnce(new Error('Sync unavailable'))
      const preview = await f.service.preview(tenantId, null, 'operator')
      const operation = await f.service.execute(preview.operation!.id, tenantId, 'operator')
      expect(operation.status).toBe('unknown')
      expect(operation.synchronizationRequested).toBe(false)
      expect(operation.synchronizationError).toContain('同步失败')
      await f.service.execute(operation.id, tenantId, 'operator')
      expect(f.remover.remove).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })

  it('refuses to delete from an outdated tenant-level scope', async () => {
    const f = await fixture()
    try {
      const preview = await f.service.preview(tenantId, null, 'operator')
      f.inventory.subscriptions.push({ ...f.inventory.subscriptions[0]!, subscriptionId: randomUUID() })
      await expect(f.service.execute(preview.operation!.id, tenantId, 'operator')).rejects.toMatchObject({ code: 'OFFBOARDING_SCOPE_CHANGED' })
      expect(f.remover.remove).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('invalidates all older previews after one confirmed operation', async () => {
    const f = await fixture()
    try {
      const first = await f.service.preview(tenantId, subId, 'operator')
      const second = await f.service.preview(tenantId, subId, 'operator')
      await f.service.execute(first.operation!.id, subId, 'operator')
      await expect(f.service.execute(second.operation!.id, subId, 'operator')).rejects.toMatchObject({ code: 'OFFBOARDING_PLAN_SUPERSEDED' })
      expect(f.remover.remove).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  })
})
