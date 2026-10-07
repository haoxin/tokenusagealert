import { randomUUID } from 'node:crypto'
import { BlobServiceClient } from '@azure/storage-blob'
import { describe, expect, it } from 'vitest'
import { ManualPriceDocumentSchema, type ManualPriceInput } from '@tokenusagealert/schemas'
import {
  BlobManualPricingStore, ManualPriceConflictError, ManualPriceNotFoundError, ManualPriceScopeError, manualPriceHeads,
} from './manual-pricing-store.js'
import { StorageLeaseBusyError } from './blob-lease.js'

const client = BlobServiceClient.fromConnectionString('UseDevelopmentStorage=true')
const actor = '00000000-0000-4000-8000-000000000001'
const input: ManualPriceInput = { modelName: 'gpt-6.1-sol', modelVersion: null, deploymentSku: 'GlobalStandard',
  regionScope: 'selected', regions: ['swedencentral'], inputUsdPerMillion: '3', outputUsdPerMillion: '7', note: 'Local fixture only' }
async function fixture() {
  const suffix = randomUUID().replaceAll('-', '')
  const names = { configuration: `manual-config-${suffix}`, operations: `manual-ops-${suffix}` }
  await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).create()))
  const store = new BlobManualPricingStore(client, names)
  return { store, names, cleanup: async () => {
    await Promise.all(Object.values(names).map((name) => client.getContainerClient(name).delete()))
  } }
}
async function history(container: string) {
  const items = []
  const store = client.getContainerClient(container)
  for await (const blob of store.listBlobsFlat({ prefix: 'manual-pricing/history/' })) {
    items.push(ManualPriceDocumentSchema.parse(JSON.parse((await store.getBlobClient(blob.name).downloadToBuffer()).toString())))
  }
  return items
}

describe('versioned manual pricing JSON (Azurite)', () => {
  it('creates a next-hour price with a strong ETag and immutable audit snapshot; missing configuration is not an invented price', async () => {
    const f = await fixture()
    try {
      expect(await f.store.read()).toEqual({ document: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] }, etag: null })
      const saved = await f.store.save(input, null, actor, null, new Date('2026-10-05T10:13:45.000Z'))
      expect(saved.item).toMatchObject({ effectiveFromUtc: '2026-10-05T11:00:00.000Z', revision: 1,
        inputUsdPerMillion: '3', updatedByObjectId: actor })
      expect(await f.store.read()).toEqual({ document: saved.document, etag: saved.etag })
      expect(await history(f.names.operations)).toEqual([saved.document])
      await expect(f.store.save(input, null, actor)).rejects.toBeInstanceOf(ManualPriceConflictError)
      await expect(f.store.save(input, '"stale"', actor)).rejects.toBeInstanceOf(ManualPriceConflictError)
      expect((await f.store.read()).document.revision).toBe(1)
    } finally { await f.cleanup() }
  })

  it('keeps past price intervals and audit documents unchanged on edit and disable', async () => {
    const f = await fixture()
    try {
      const first = await f.store.save(input, null, actor, null, new Date('2026-10-05T10:13:00.000Z'))
      const edited = await f.store.save({ ...input, inputUsdPerMillion: '4' }, first.etag, actor,
        first.item.ruleId, new Date('2026-10-05T11:23:00.000Z'))
      expect(edited.document.versions[0]).toMatchObject({ revision: 1, inputUsdPerMillion: '3',
        effectiveFromUtc: '2026-10-05T11:00:00.000Z', effectiveToUtc: '2026-10-05T12:00:00.000Z' })
      expect(edited.item).toMatchObject({ revision: 2, inputUsdPerMillion: '4', effectiveFromUtc: '2026-10-05T12:00:00.000Z' })
      const stopped = await f.store.disable(first.item.ruleId, edited.etag, actor, new Date('2026-10-05T12:33:00.000Z'))
      expect(stopped.document.versions).toHaveLength(3)
      expect(stopped.document.versions[1]).toMatchObject({ enabled: true, effectiveToUtc: '2026-10-05T13:00:00.000Z' })
      expect(manualPriceHeads(stopped.document)).toEqual([stopped.item])
      expect(stopped.item).toMatchObject({ revision: 3, enabled: false, effectiveFromUtc: '2026-10-05T13:00:00.000Z' })
      expect(await history(f.names.operations)).toEqual(expect.arrayContaining([first.document, edited.document, stopped.document]))
    } finally { await f.cleanup() }
  })

  it('replaces not-yet-effective same-hour edits in the current document while retaining every audit snapshot', async () => {
    const f = await fixture()
    try {
      const first = await f.store.save(input, null, actor, null, new Date('2026-10-05T10:13:00.000Z'))
      const edited = await f.store.save({ ...input, outputUsdPerMillion: '9' }, first.etag, actor,
        first.item.ruleId, new Date('2026-10-05T10:40:00.000Z'))
      expect(edited.document.versions).toHaveLength(1)
      expect(edited.item).toMatchObject({ revision: 2, outputUsdPerMillion: '9', effectiveFromUtc: '2026-10-05T11:00:00.000Z' })
      expect(await history(f.names.operations)).toHaveLength(2)
      expect((await history(f.names.operations)).some((item) => item.snapshotId === first.document.snapshotId)).toBe(true)
    } finally { await f.cleanup() }
  })

  it('rejects overlapping wildcard/version and all-region scopes but permits disjoint regions and deployment types', async () => {
    const f = await fixture()
    try {
      let saved = await f.store.save(input, null, actor)
      await expect(f.store.save({ ...input, modelVersion: '2026-09-29' }, saved.etag, actor)).rejects.toBeInstanceOf(ManualPriceScopeError)
      await expect(f.store.save({ ...input, regionScope: 'all', regions: [] }, saved.etag, actor)).rejects.toBeInstanceOf(ManualPriceScopeError)
      saved = await f.store.save({ ...input, regions: ['eastus'] }, saved.etag, actor)
      saved = await f.store.save({ ...input, deploymentSku: 'Standard' }, saved.etag, actor)
      expect(manualPriceHeads(saved.document)).toHaveLength(3)
    } finally { await f.cleanup() }
  })

  it('permits specific versions with distinct versions and rejects a wildcard over either', async () => {
    const f = await fixture()
    try {
      let saved = await f.store.save({ ...input, modelVersion: 'v1' }, null, actor)
      saved = await f.store.save({ ...input, modelVersion: 'v2' }, saved.etag, actor)
      await expect(f.store.save(input, saved.etag, actor)).rejects.toBeInstanceOf(ManualPriceScopeError)
      expect(manualPriceHeads((await f.store.read()).document)).toHaveLength(2)
    } finally { await f.cleanup() }
  })

  it('does not mutate configuration for an unknown rule or malformed price', async () => {
    const f = await fixture()
    try {
      await expect(f.store.disable(randomUUID(), null, actor)).rejects.toBeInstanceOf(ManualPriceNotFoundError)
      await expect(f.store.save(input, null, actor, randomUUID())).rejects.toBeInstanceOf(ManualPriceNotFoundError)
      await expect(f.store.save({ ...input, regions: [] }, null, actor)).rejects.toThrow()
      expect((await f.store.read()).document.revision).toBe(0)
      expect(await history(f.names.operations)).toHaveLength(0)
    } finally { await f.cleanup() }
  })

  it('serializes competing writers instead of overwriting the same initial configuration', async () => {
    const f = await fixture()
    try {
      const results = await Promise.allSettled([
        f.store.save(input, null, actor), f.store.save({ ...input, regions: ['eastus'] }, null, actor),
      ])
      expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
      const failed = results.find((item) => item.status === 'rejected')
      expect(failed?.status === 'rejected' &&
        (failed.reason instanceof ManualPriceConflictError || failed.reason instanceof StorageLeaseBusyError)).toBe(true)
      expect((await f.store.read()).document.revision).toBe(1)
    } finally { await f.cleanup() }
  })

  it('surfaces malformed persisted JSON instead of falling back to an empty list', async () => {
    const f = await fixture()
    try {
      const body = '{"schemaVersion":1,"versions":"not-an-array"}'
      await client.getContainerClient(f.names.configuration).getBlockBlobClient('manual-pricing.json').upload(body, Buffer.byteLength(body))
      await expect(f.store.read()).rejects.toThrow()
    } finally { await f.cleanup() }
  })
})
