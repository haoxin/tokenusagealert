import { randomUUID } from 'node:crypto'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { mapConcurrent } from '@tokenusagealert/domain'
import {
  OffboardingOperationSchema, type OffboardingOperation, type OffboardingPreviewResponse,
} from '@tokenusagealert/schemas'
import { z } from 'zod'
import type { BlobTenantRepository } from './index.js'
import type { AuthorizationSyncStarter } from './authorization.js'
import { storageErrorCode, withBlobLease } from './blob-lease.js'
import { OffboardingError, type DelegationRemovalClient } from './offboarding-arm.js'

export * from './offboarding-arm.js'

export class BlobOffboardingStore {
  private readonly operations: ContainerClient
  constructor(client: BlobServiceClient, container = 'operations') { this.operations = client.getContainerClient(container) }
  async read(id: string) {
    z.string().uuid().parse(id)
    try {
      const blob = this.operations.getBlobClient(`offboarding/operations/${id}.json`)
      const properties = await blob.getProperties()
      if (!properties.etag) throw new Error('Offboarding operation has no ETag.')
      const body = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } })
      return { operation: OffboardingOperationSchema.parse(JSON.parse(body.toString('utf8'))), etag: properties.etag }
    } catch (error) {
      if (storageErrorCode(error) === 'BlobNotFound') throw new OffboardingError('OFFBOARDING_NOT_FOUND', '解除操作不存在。', 404)
      throw error
    }
  }
  async write(operation: OffboardingOperation, etag: string | null) {
    const value = OffboardingOperationSchema.parse(operation)
    const body = JSON.stringify(value)
    const response = await this.operations.getBlockBlobClient(`offboarding/operations/${value.id}.json`).upload(body, Buffer.byteLength(body), {
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
    })
    if (!response.etag) throw new Error('Offboarding write did not return an ETag.')
    return response.etag
  }
  async audit(operation: OffboardingOperation, action: string, target: string | null = null) {
    const body = JSON.stringify({
      operationId: operation.id, tenantId: operation.tenantId, requestedByObjectId: operation.requestedByObjectId,
      action, target, occurredAtUtc: new Date().toISOString(),
    })
    await this.operations.getBlockBlobClient(`offboarding/audit/${randomUUID()}.json`).upload(body, Buffer.byteLength(body), {
      conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
    })
  }
  lease<T>(operationId: string, work: (signal: AbortSignal) => Promise<T>) {
    z.string().uuid().parse(operationId)
    return withBlobLease(this.operations, `locks/offboarding/${operationId}`, work, AbortSignal.timeout(150_000))
  }
  tenantLease<T>(tenantId: string, work: (signal: AbortSignal) => Promise<T>) {
    z.string().uuid().parse(tenantId)
    return withBlobLease(this.operations, `locks/offboarding-tenant/${tenantId}`, work, AbortSignal.timeout(150_000))
  }
  async generation(tenantId: string): Promise<{ id: string; etag: string }> {
    z.string().uuid().parse(tenantId)
    const blob = this.operations.getBlockBlobClient(`offboarding/generations/${tenantId}.json`)
    let properties
    try { properties = await blob.getProperties() }
    catch (error) {
      if (storageErrorCode(error) !== 'BlobNotFound') throw error
      const id = randomUUID()
      const result = await blob.uploadData(Buffer.from(JSON.stringify({ id })), { conditions: { ifNoneMatch: '*' } })
      if (!result.etag) throw new Error('Missing generation ETag.')
      return { id, etag: result.etag }
    }
    if (!properties.etag) throw new Error('Missing generation ETag.')
    const buffer = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } })
    const data = z.object({ id: z.string().uuid() }).parse(JSON.parse(buffer.toString('utf8')))
    return { id: data.id, etag: properties.etag }
  }
  async consumeGeneration(tenantId: string, generation: string) {
    const current = await this.generation(tenantId)
    if (current.id !== generation) throw new OffboardingError('OFFBOARDING_PLAN_SUPERSEDED', '该租户已有其他解除操作，旧预览失效；请同步并重新预览。')
    await this.operations.getBlockBlobClient(`offboarding/generations/${tenantId}.json`).uploadData(
      Buffer.from(JSON.stringify({ id: randomUUID() })), { conditions: { ifMatch: current.etag } },
    )
  }
}

type TenantRepository = Pick<BlobTenantRepository, 'getTenant' | 'getSubscriptionInventory'>
export class OffboardingService {
  constructor(
    private readonly repository: TenantRepository,
    private readonly client: DelegationRemovalClient,
    private readonly store: BlobOffboardingStore,
    private readonly sync: AuthorizationSyncStarter | undefined,
  ) {}

  private async scope(tenantId: string, subscriptionId: string | null) {
    const tenant = await this.repository.getTenant(tenantId)
    const inventory = await this.repository.getSubscriptionInventory(tenantId)
    if (tenant.status === 'deleted' || !inventory || Date.now() - Date.parse(inventory.observedAtUtc) > 2 * 3_600_000) {
      throw new OffboardingError('AUTHORIZATION_REFRESH_REQUIRED', '租户已归档或授权清单过期，请先同步 Lighthouse。')
    }
    const subscriptions = inventory.subscriptions.filter((item) => subscriptionId === null || item.subscriptionId === subscriptionId)
    if (!subscriptions.length || subscriptions.length > 1000 ||
      subscriptions.some((item) => item.customerTenantId !== tenantId)) {
      throw new OffboardingError('INVALID_OFFBOARDING_SCOPE', '解除范围不在当前租户授权清单内，或超过本次上限。')
    }
    return { tenant, subscriptions }
  }

  async preview(tenantId: string, subscriptionId: string | null, actor: string): Promise<OffboardingPreviewResponse> {
    return this.store.tenantLease(tenantId, async (leaseSignal) => {
      const { tenant, subscriptions } = await this.scope(tenantId, subscriptionId)
      const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(110_000)])
      const result = await mapConcurrent(subscriptions, 4,
        (item) => this.client.inspect(tenantId, item.subscriptionId, item.displayName, signal), signal)
      const blockers: OffboardingPreviewResponse['blockers'] = result.flatMap((item, index) => item.status === 'fulfilled' ? [] : [{
        subscriptionId: subscriptions[index]!.subscriptionId,
        code: item.reason instanceof OffboardingError ? item.reason.code : 'OFFBOARDING_PREVIEW_FAILED',
        message: item.reason instanceof OffboardingError ? item.reason.message : '委派范围预览未完成；未执行任何解除。',
      }])
      if (blockers.length) return { configured: true, identity: this.client.identity, operation: null, blockers }
      const now = new Date().toISOString()
      const operation = OffboardingOperationSchema.parse({
        schemaVersion: 1, id: randomUUID(), tenantId, tenantName: tenant.displayName, subscriptionId,
        requestedByObjectId: actor, scopeGeneration: (await this.store.generation(tenantId)).id,
        createdAtUtc: now, updatedAtUtc: now,
        expiresAtUtc: new Date(Date.now() + 10 * 60_000).toISOString(),
        status: 'prepared', targets: result.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
        synchronizationRequested: false, synchronizationError: null,
      })
      await this.store.write(operation, null)
      await this.store.audit(operation, 'offboarding.previewed')
      return { configured: true, identity: this.client.identity, operation, blockers: [] }
    })
  }

  async get(id: string, actor: string) {
    const stored = await this.store.read(id)
    if (stored.operation.requestedByObjectId !== actor) {
      throw new OffboardingError('OFFBOARDING_ACTOR_MISMATCH', '请由发起预览的运维人员继续确认。', 403)
    }
    return stored
  }

  async execute(id: string, confirmation: string, actor: string): Promise<OffboardingOperation> {
    return this.store.lease(id, async (signal) => {
      const stored = await this.get(id, actor)
      let operation = stored.operation
      let etag = stored.etag
      if (operation.status !== 'prepared') return operation
      return this.store.tenantLease(operation.tenantId, async (tenantSignal) => {
      const executionSignal = AbortSignal.any([signal, tenantSignal])
      if (Date.now() >= Date.parse(operation.expiresAtUtc)) throw new OffboardingError('OFFBOARDING_PLAN_EXPIRED', '预览已过期，请重新核对。')
      if (confirmation !== (operation.subscriptionId ?? operation.tenantId)) {
        throw new OffboardingError('OFFBOARDING_CONFIRMATION_REQUIRED', '请准确输入目标租户或订阅 ID 后确认。', 400)
      }
      const { subscriptions } = await this.scope(operation.tenantId, operation.subscriptionId)
      const expected = operation.targets.map((item) => item.subscriptionId).sort().join('|')
      if (subscriptions.map((item) => item.subscriptionId).sort().join('|') !== expected) {
        throw new OffboardingError('OFFBOARDING_SCOPE_CHANGED', '预览后租户授权范围发生变化，需重新预览。')
      }
      await this.store.audit(operation, 'offboarding.confirmed')
      // Invalidate other previews before deletion so they cannot later revoke a recreated delegation.
      await this.store.consumeGeneration(operation.tenantId, operation.scopeGeneration)
      operation = { ...operation, status: 'executing', updatedAtUtc: new Date().toISOString() }
      etag = await this.store.write(operation, etag)
      // Deliberately serialize destructive writes. Each submission is journaled before calling Azure.
      for (let index = 0; index < operation.targets.length; index++) {
        if (executionSignal.aborted) {
          for (const target of operation.targets.slice(index)) {
            target.state = 'notAttempted'; target.message = '本次达到执行时限，未请求解除。请刷新范围后另行操作。'
          }
          break
        }
        const target = operation.targets[index]!
        try {
          operation.targets[index] = await this.client.remove(operation.tenantId, target, async () => {
            executionSignal.throwIfAborted()
            await this.store.audit(operation, 'offboarding.submission-started', target.assignmentId)
            operation.targets[index] = { ...target, state: 'unknown', message: '删除请求即将提交，尚未取得响应。' }
            etag = await this.store.write(operation, etag)
          }, executionSignal)
        } catch (error) {
          const submitted = operation.targets[index]!.state === 'unknown'
          operation.targets[index] = {
            ...target, state: submitted ? 'unknown' : 'failed',
            message: error instanceof OffboardingError ? error.message
              : submitted ? '请求结果未知，请先同步授权核对；不会自动重发。' : '校验或记录失败，未提交该委派的解除请求。',
          }
        }
        operation.updatedAtUtc = new Date().toISOString()
        etag = await this.store.write(operation, etag)
      }
      const states = operation.targets.map((item) => item.state)
      operation.status = states.every((state) => state === 'submitted') ? 'submitted'
        : states.some((state) => state === 'submitted') ? 'partial'
          : states.includes('unknown') ? 'unknown' : 'failed'
      if (this.sync && states.some((state) => ['submitted', 'unknown'].includes(state))) {
        try { await this.sync.start(); operation.synchronizationRequested = true }
        catch {
          operation.synchronizationRequested = false
          operation.synchronizationError = '解除请求已有处理结果，但启动授权同步失败；请手动同步 Lighthouse 后核对。'
          await this.store.audit(operation, 'offboarding.authorization-sync-start-failed')
        }
      }
      operation.updatedAtUtc = new Date().toISOString()
      await this.store.write(operation, etag)
      await this.store.audit(operation, `offboarding.${operation.status}`)
      return operation
      })
    })
  }
}
