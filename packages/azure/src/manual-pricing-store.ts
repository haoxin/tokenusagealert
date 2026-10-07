import { randomUUID } from 'node:crypto'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import {
  ManualPriceDocumentSchema, ManualPriceInputSchema, type ManualPriceDocument, type ManualPriceInput, type ManualPriceVersion,
} from '@tokenusagealert/schemas'
import { storageErrorCode, withBlobLease } from './blob-lease.js'

export class ManualPriceConflictError extends Error {
  constructor(message = '手动价格配置已变化，请刷新后再操作。') { super(message); this.name = 'ManualPriceConflictError' }
}
export class ManualPriceNotFoundError extends Error {
  constructor() { super('手动价格记录不存在。'); this.name = 'ManualPriceNotFoundError' }
}
export class ManualPriceScopeError extends Error {
  constructor(message: string) { super(message); this.name = 'ManualPriceScopeError' }
}
export function manualPriceHeads(document: ManualPriceDocument): ManualPriceVersion[] {
  const latest = new Map<string, ManualPriceVersion>()
  for (const version of document.versions) {
    const previous = latest.get(version.ruleId)
    if (!previous || previous.revision < version.revision) latest.set(version.ruleId, version)
  }
  return [...latest.values()].sort((a, b) => a.modelName.localeCompare(b.modelName))
}
const effectiveHour = (now: Date) => new Date((Math.floor(now.getTime() / 3_600_000) + 1) * 3_600_000).toISOString()
const overlappingRegions = (a: ManualPriceVersion, b: ManualPriceInput) =>
  a.regionScope === 'all' || b.regionScope === 'all' || a.regions.some((region) => b.regions.includes(region))

export class BlobManualPricingStore {
  private readonly configuration: ContainerClient
  private readonly operations: ContainerClient
  constructor(client: BlobServiceClient, names: { configuration?: string; operations?: string } = {}) {
    this.configuration = client.getContainerClient(names.configuration ?? 'configuration')
    this.operations = client.getContainerClient(names.operations ?? 'operations')
  }
  async read(): Promise<{ document: ManualPriceDocument; etag: string | null }> {
    const blob = this.configuration.getBlobClient('manual-pricing.json')
    try {
      const properties = await blob.getProperties()
      if (!properties.etag) throw new Error('Manual pricing file has no ETag.')
      const body = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } })
      return { document: ManualPriceDocumentSchema.parse(JSON.parse(body.toString())), etag: properties.etag }
    } catch (error) {
      if (storageErrorCode(error) === 'BlobNotFound') {
        return { document: { schemaVersion: 1, revision: 0, snapshotId: null, versions: [] }, etag: null }
      }
      throw error
    }
  }
  async save(input: ManualPriceInput, expected: string | null, actor: string, ruleId: string | null = null, now = new Date()) {
    const value = ManualPriceInputSchema.parse(input)
    return this.mutate(expected, actor, async (document) => {
      const heads = manualPriceHeads(document)
      const existing = ruleId ? heads.find((item) => item.ruleId === ruleId) : null
      if (ruleId && !existing) throw new ManualPriceNotFoundError()
      if (heads.some((item) => item.ruleId !== ruleId && item.enabled &&
        item.modelName === value.modelName && (item.modelVersion === null || value.modelVersion === null || item.modelVersion === value.modelVersion) &&
        item.deploymentSku === value.deploymentSku && overlappingRegions(item, value))) {
        throw new ManualPriceScopeError('已有手动价格覆盖相同模型、版本、部署方式和区域，请编辑现有记录或先停用。')
      }
      const effectiveFromUtc = effectiveHour(now)
      let versions = [...document.versions]
      if (existing) {
        versions = versions.filter((item) => item.ruleId !== ruleId || item.effectiveFromUtc < effectiveFromUtc)
          .map((item) => item.ruleId === ruleId && item.effectiveToUtc === null ? { ...item, effectiveToUtc: effectiveFromUtc } : item)
      }
      const item: ManualPriceVersion = {
        ...value, ruleId: existing?.ruleId ?? randomUUID(), revision: (existing?.revision ?? 0) + 1,
        effectiveFromUtc, effectiveToUtc: null, enabled: true, updatedAtUtc: now.toISOString(), updatedByObjectId: actor,
      }
      return { item, versions: [...versions, item] }
    }, now)
  }
  async disable(ruleId: string, expected: string | null, actor: string, now = new Date()) {
    return this.mutate(expected, actor, async (document) => {
      const existing = manualPriceHeads(document).find((item) => item.ruleId === ruleId)
      if (!existing) throw new ManualPriceNotFoundError()
      const effectiveFromUtc = effectiveHour(now)
      const versions = document.versions.filter((item) => item.ruleId !== ruleId || item.effectiveFromUtc < effectiveFromUtc)
        .map((item) => item.ruleId === ruleId && item.effectiveToUtc === null ? { ...item, effectiveToUtc: effectiveFromUtc } : item)
      const item = { ...existing, revision: existing.revision + 1, effectiveFromUtc, effectiveToUtc: null,
        enabled: false, updatedAtUtc: now.toISOString(), updatedByObjectId: actor }
      return { item, versions: [...versions, item] }
    }, now)
  }
  private async mutate(
    expected: string | null, actor: string,
    change: (document: ManualPriceDocument) => Promise<{ item: ManualPriceVersion; versions: ManualPriceVersion[] }>,
    now: Date,
  ) {
    return withBlobLease(this.operations, 'locks/manual-pricing', async (signal) => {
      const current = await this.read()
      if (current.etag !== expected) throw new ManualPriceConflictError()
      const result = await change(current.document)
      const document = ManualPriceDocumentSchema.parse({
        schemaVersion: 1, revision: current.document.revision + 1, snapshotId: randomUUID(), versions: result.versions,
      })
      const body = JSON.stringify(document)
      await this.operations.getBlockBlobClient(`manual-pricing/history/${document.snapshotId}.json`).upload(body, Buffer.byteLength(body), {
        conditions: { ifNoneMatch: '*' }, abortSignal: signal,
        blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
        metadata: { actor, occurred: now.toISOString() },
      })
      try {
        const saved = await this.configuration.getBlockBlobClient('manual-pricing.json').upload(body, Buffer.byteLength(body), {
          conditions: expected ? { ifMatch: expected } : { ifNoneMatch: '*' }, abortSignal: signal,
          blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
        })
        if (!saved.etag) throw new Error('Manual pricing write did not return an ETag.')
        return { item: result.item, document, etag: saved.etag }
      } catch (error) {
        if (['ConditionNotMet', 'BlobAlreadyExists'].includes(String(storageErrorCode(error)))) throw new ManualPriceConflictError()
        throw error
      }
    }, AbortSignal.timeout(60_000))
  }
}
