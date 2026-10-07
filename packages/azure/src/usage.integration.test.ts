import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { collectionWindow } from '@tokenusagealert/domain'
import { HourlyUsageSchema, UsageExecutionSettingsSchema, type UsageRun } from '@tokenusagealert/schemas'
import { BlobUsageStore, UsageTopologyMismatchError } from './usage-store.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const tenantId = '00000000-0000-4000-8000-000000000001'
const signal = () => AbortSignal.timeout(10_000)
async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { usage: `usage-${suffix}`, inventory: `inventory-${suffix}`, operations: `ops-${suffix}` }
  const store = new BlobUsageStore(client, names)
  await store.initialize(true)
  return { names, store, cleanup: async () => { await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete())) } }
}
function hour() {
  return HourlyUsageSchema.parse({
    schemaVersion: 1, tenantId, ...collectionWindow(new Date()),
    collectedAtUtc: new Date().toISOString(), source: 'fixture', status: 'complete', activity: 'noDeployments',
    finality: 'provisional', estimatedCostUsd: '0.000000000000', knownCostUsd: '0.000000000000',
    thresholdUsd: '10.00', inputTokens: '0', outputTokens: '0', priceSnapshotId: null,
    estimatePolicy: 'cached-input-at-standard-rate', pricingRuleVersion: 1,
    validation: 'awaiting-positive-usage-verification',
    coverage: { expectedSubscriptions: 1, successfulSubscriptions: 1, accounts: 0, expectedDeployments: 0, successfulDeployments: 0, pricedDeployments: 0 },
    breakdown: [], issues: [],
  })
}

describe('usage hourly storage and shard coordination', () => {
  it('upserts the same hour without duplicating cost or retroactively changing its threshold', async () => {
    const f = await fixture()
    try {
      const value = hour()
      await f.store.withLease(async (leaseSignal) => {
        await f.store.saveHours([value], leaseSignal)
        await f.store.saveHours([{ ...value, thresholdUsd: '99.00' }], leaseSignal)
      }, signal())
      const saved = await f.store.hours(tenantId, 24)
      expect(saved).toHaveLength(1)
      expect(saved[0]?.thresholdUsd).toBe('10.00')
      expect(saved[0]?.revision).toBeUndefined()
      expect(saved[0]?.finality).toBe('provisional')
    } finally { await f.cleanup() }
  })

  it('stores shard views and run results independently and guards resharding', async () => {
    const f = await fixture()
    try {
      const a = new BlobUsageStore(client, { ...f.names, shardId: 0, shardCount: 2 })
      const b = new BlobUsageStore(client, { ...f.names, shardId: 1, shardCount: 2 })
      const now = new Date().toISOString()
      await Promise.all([a, b].map((store, shardId) => store.withLease(async (leaseSignal) => {
        const run: UsageRun = {
          schemaVersion: 1, runId: randomUUID(), status: 'succeeded', source: 'fixture', startedAtUtc: now, finishedAtUtc: now,
          ...collectionWindow(new Date()), tenantCount: 0, processedTenantCount: 0, skippedTenantCount: 0, deploymentCount: 0, issues: [],
          execution: UsageExecutionSettingsSchema.parse({ shardId, shardCount: 2 }),
        }
        await store.writeRun(run, leaseSignal)
        await store.saveView({
          schemaVersion: 1, runId: run.runId, shardId, shardCount: 2, generatedAtUtc: now, ...collectionWindow(new Date()), tenants: [],
        }, leaseSignal)
      }, signal())))
      expect(await a.views()).toHaveLength(2)
      expect(await a.allRuns()).toHaveLength(2)
      await expect(f.store.withLease(async () => true, signal())).rejects.toBeInstanceOf(UsageTopologyMismatchError)
    } finally { await f.cleanup() }
  })
})
