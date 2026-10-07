import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import type { ResourceInventory } from '@tokenusagealert/schemas'
import { BlobUsageStore } from './usage-store.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
describe('separate Models dimension-cache persistence', () => {
  it('keeps the legacy cache intact and strips both cache families from rollback-compatible baseline inventory JSON', async () => {
    const suffix = randomUUID().replaceAll('-', '')
    const names = { usage: `models-usage-${suffix}`, inventory: `models-inventory-${suffix}`, operations: `models-ops-${suffix}` }
    const store = new BlobUsageStore(client, names)
    await store.initialize(true)
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const inventory: ResourceInventory = {
      schemaVersion: 1, tenantId, observedAtUtc: new Date().toISOString(),
      accounts: [{ id: '/mock/account', name: 'mock', kind: 'AIServices', region: 'swedencentral',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
        metricDimensions: ['ModelDeploymentName', 'FeatureName', 'ModelVersion'],
        modelsMetricDimensions: ['ModelDeploymentName', 'ModelName', 'ModelVersion'] }],
      deployments: [], issues: [], subscriptionDiscovery: [],
    }
    try {
      await store.saveInventory(inventory, AbortSignal.timeout(10_000))
      expect(await store.getInventory(tenantId)).toEqual(inventory)
      const container = client.getContainerClient(names.inventory)
      const baseline = JSON.parse((await container.getBlobClient(`tenants/${tenantId}/resources.json`).downloadToBuffer()).toString())
      expect(baseline.accounts[0].metricDimensions).toBeUndefined()
      expect(baseline.accounts[0].modelsMetricDimensions).toBeUndefined()
      const cache = JSON.parse((await container.getBlobClient(`tenants/${tenantId}/resource-cache.json`).downloadToBuffer()).toString())
      expect(cache.metricDimensions['/mock/account']).toEqual(inventory.accounts[0]!.metricDimensions)
      expect(cache.modelsMetricDimensions['/mock/account']).toEqual(inventory.accounts[0]!.modelsMetricDimensions)
    } finally { await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete())) }
  })
})
