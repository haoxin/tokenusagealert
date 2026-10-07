import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it, vi } from 'vitest'
import {
  BlobTenantRepository,
  TenantAlreadyExistsError,
} from './index.js'
import {
  AuthorizationSyncService,
  FixtureSubscriptionDiscovery,
} from './authorization.js'

const connectionString = 'UseDevelopmentStorage=true'

function containerName(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

describe('BlobTenantRepository with Azurite', () => {
  it('creates, lists, reads and protects a tenant document', async () => {
    const configurationContainerName = containerName('configuration')
    const auditContainerName = containerName('audit')
    const repository = new BlobTenantRepository({
      connectionString,
      autoCreateContainers: true,
      configurationContainerName,
      auditContainerName,
    })
    await repository.initialize()

    const request = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      displayName: '客户 A',
      hourlyThresholdUsd: '25.00',
      notes: '',
    } as const
    const actor = {
      objectId: 'operator-1',
      name: 'operator@ms-ext.biz',
    }

    const created = await repository.createTenant(
      request,
      actor,
      'correlation-1',
      new Date('2026-09-29T08:00:00.000Z'),
    )
    expect(created.tenant.status).toBe('pendingAuthorization')
    expect(created.tenant.createdByObjectId).toBe(actor.objectId)
    expect(created.auditCompletionRecorded).toBe(true)

    const listed = await repository.listTenants()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.tenantId).toBe(request.tenantId)

    const read = await repository.getTenant(request.tenantId)
    expect(read).toEqual(listed[0])

    await expect(
      repository.createTenant(request, actor, 'correlation-2'),
    ).rejects.toBeInstanceOf(TenantAlreadyExistsError)

    const blobService =
      BlobServiceClient.fromConnectionString(connectionString)
    const audit = blobService.getContainerClient(auditContainerName)
    const auditBlobs = []
    for await (const blob of audit.listBlobsFlat()) {
      auditBlobs.push(blob.name)
    }
    expect(auditBlobs).toHaveLength(3)
  })

  it('discovers, enables, archives revoked authorization and requires explicit re-enablement', async () => {
    const repository = new BlobTenantRepository({
      connectionString,
      autoCreateContainers: true,
      configurationContainerName: containerName('configuration'),
      auditContainerName: containerName('audit'),
      inventoryContainerName: containerName('inventory'),
      operationsContainerName: containerName('operations'),
    })
    await repository.initialize()
    const tenantId = '92078590-b3a5-4c46-aaea-74360df451d0'
    const subscriptionId = '5b643b3a-b486-4197-b5a0-e7eb33e33657'
    await repository.createTenant(
      {
        tenantId,
        displayName: '客户测试租户',
        hourlyThresholdUsd: '10.00',
        notes: '',
      },
      {
        objectId: 'operator-1',
        name: 'operator@ms-ext.biz',
      },
      'create-correlation',
    )

    const discovered = new AuthorizationSyncService(
      repository,
      new FixtureSubscriptionDiscovery([
        {
          subscriptionId,
          displayName: 'Pay-As-You-Go-TEMP',
          tenantId,
          state: 'Enabled',
        },
      ]),
    )
    const discoveredRun = await discovered.run()
    expect(discoveredRun.status).toBe('succeeded')
    expect(discoveredRun.visibleSubscriptionCount).toBe(1)

    const discoveredTenant = await repository.getTenant(tenantId)
    expect(discoveredTenant.status).toBe('discovered')
    const inventory = await repository.getSubscriptionInventory(tenantId)
    expect(inventory?.subscriptions).toHaveLength(1)
    expect(inventory?.subscriptions[0]?.subscriptionId).toBe(
      subscriptionId,
    )

    const activeTenant = await repository.enableTenant(
      tenantId,
      {
        displayName: '客户测试租户',
        hourlyThresholdUsd: '15.00',
        etag: discoveredTenant.etag,
      },
      {
        objectId: 'operator-1',
        name: 'operator@ms-ext.biz',
      },
      'enable-correlation',
    )
    expect(activeTenant.status).toBe('active')

    const disconnected = new AuthorizationSyncService(
      repository,
      new FixtureSubscriptionDiscovery([]),
    )
    const disconnectedRun = await disconnected.run()
    expect(disconnectedRun.status).toBe('succeeded')
    expect((await repository.getTenant(tenantId)).status).toBe(
      'deleted',
    )
    expect((await repository.getTenant(tenantId)).deletedAtUtc).not.toBeNull()
    expect((await repository.getSubscriptionInventory(tenantId))?.removedSubscriptions?.[0]).toMatchObject({ subscriptionId, reason: 'collector-access-removed' })
    expect((await repository.getSubscriptionInventory(tenantId))?.expectedSubscriptionIds).toEqual([])
    expect(
      (await repository.getLatestAuthorizationSyncRun())?.runId,
    ).toBe(disconnectedRun.runId)

    await discovered.run()
    const reauthorized = await repository.getTenant(tenantId)
    expect(reauthorized.status).toBe('discovered')
    expect(reauthorized.deletedAtUtc).toBeNull()
    expect(reauthorized.hourlyThresholdUsd).toBe('15.00')
    expect((await repository.getSubscriptionInventory(tenantId))?.removedSubscriptions).toEqual([])
    expect((await repository.enableTenant(tenantId, {
      displayName: reauthorized.displayName, hourlyThresholdUsd: '15.00', etag: reauthorized.etag,
    }, { objectId: 'operator-1', name: 'operator@ms-ext.biz' }, 'enable-again')).status).toBe('active')
  })

  it('removes only confirmed subscriptions and preserves tenant documents when discovery or verification fails', async () => {
    const names = {
      configurationContainerName: containerName('configuration'),
      auditContainerName: containerName('audit'),
      inventoryContainerName: containerName('inventory'),
      operationsContainerName: containerName('operations'),
    }
    const repository = new BlobTenantRepository({ connectionString, autoCreateContainers: true, ...names })
    const service = BlobServiceClient.fromConnectionString(connectionString)
    await repository.initialize()
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const actor = { objectId: 'test-operator', name: 'operator@ms-ext.biz' }
    const a = { subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantId, displayName: 'Subscription A', state: 'Enabled' }
    const b = { subscriptionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tenantId, displayName: 'Subscription B', state: 'Enabled' }
    try {
      await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([a, b])).run()
      const tenant = await repository.getTenant(tenantId)
      await repository.enableTenant(tenantId, { displayName: 'Customer', hourlyThresholdUsd: '10.00', etag: tenant.etag }, actor, 'enable')
      const before = await repository.getSubscriptionInventory(tenantId)
      const beforeTenant = await repository.getTenant(tenantId)
      const failed = await new AuthorizationSyncService(repository, {
        async listVisibleSubscriptions() { throw new Error('Page 2 timed out') },
        async verifyMissingSubscription() { throw new Error('Must not verify an incomplete list') },
      }).run()
      expect(failed.status).toBe('failed')
      expect(await repository.getSubscriptionInventory(tenantId)).toEqual(before)
      expect(await repository.getTenant(tenantId)).toEqual(beforeTenant)
      const unknown = await new AuthorizationSyncService(repository, {
        async listVisibleSubscriptions() { return [a] },
        async verifyMissingSubscription() { throw new Error('429 cannot confirm access loss') },
      }).run()
      expect(unknown.status).toBe('succeededWithWarnings')
      expect(await repository.getSubscriptionInventory(tenantId)).toEqual(before)
      expect(await repository.getTenant(tenantId)).toEqual(beforeTenant)
      await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([a])).run()
      expect((await repository.getTenant(tenantId)).status).toBe('active')
      expect(await repository.getSubscriptionInventory(tenantId)).toMatchObject({
        expectedSubscriptionIds: [a.subscriptionId],
        subscriptions: [expect.objectContaining({ subscriptionId: a.subscriptionId })],
        removedSubscriptions: [expect.objectContaining({ subscriptionId: b.subscriptionId })],
      })
      await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([{ ...a, state: 'Disabled' }])).run()
      expect((await repository.getTenant(tenantId)).status).toBe('degraded')
      expect((await repository.getSubscriptionInventory(tenantId))?.subscriptions[0]?.state).toBe('Disabled')
      const crash = vi.spyOn(repository, 'updateTenantAuthorization').mockRejectedValueOnce(new Error('crash after inventory removal'))
      const interrupted = await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([])).run()
      expect(interrupted.status).toBe('succeededWithWarnings')
      crash.mockRestore()
      expect((await repository.getTenant(tenantId)).status).toBe('degraded')
      await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([])).run()
      expect((await repository.getTenant(tenantId)).status).toBe('deleted')
      await repository.createTenant({ tenantId, displayName: 'Re-registered', hourlyThresholdUsd: '12.50', notes: '' }, actor, 'register-again')
      expect((await repository.getTenant(tenantId)).status).toBe('pendingAuthorization')
      await new AuthorizationSyncService(repository, new FixtureSubscriptionDiscovery([])).run()
      expect((await repository.getTenant(tenantId)).status).toBe('pendingAuthorization')
    } finally {
      await Promise.all(Object.values(names).map((name) => service.getContainerClient(name).delete()))
    }
  })
})
