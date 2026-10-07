import { randomUUID } from 'node:crypto'
import {
  BlobServiceClient,
  type ContainerClient,
} from '@azure/storage-blob'
import { DefaultAzureCredential } from '@azure/identity'
import { mapConcurrent } from '@tokenusagealert/domain'
import { storageErrorCode, withBlobLease } from './blob-lease.js'
import {
  AuditEventSchema,
  AuthorizationSyncRunSchema,
  SubscriptionInventoryDocumentSchema,
  RemovedSubscriptionsDocumentSchema,
  TenantConfigSchema,
  TenantIdSchema,
  UpdateTenantSettingsRequestSchema,
  type AuditEvent,
  type AuthorizationSyncRun,
  type CreateTenantRequest,
  type EnableTenantRequest,
  type UpdateTenantSettingsRequest,
  type SubscriptionInventoryDocument,
  type TenantConfig,
  type TenantListItem,
} from '@tokenusagealert/schemas'

export interface AuthenticatedActor {
  objectId: string
  name: string
}

export interface BlobTenantRepositoryOptions {
  connectionString?: string
  accountUrl?: string
  managedIdentityClientId?: string
  autoCreateContainers: boolean
  configurationContainerName?: string
  auditContainerName?: string
  inventoryContainerName?: string
  operationsContainerName?: string
}

export interface CreateTenantResult {
  tenant: TenantListItem
  auditCompletionRecorded: boolean
}

export interface DeleteTenantRegistrationResult {
  tenantId: string
  auditCompletionRecorded: boolean
}

export class TenantAlreadyExistsError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} already exists`)
    this.name = 'TenantAlreadyExistsError'
  }
}

export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} was not found`)
    this.name = 'TenantNotFoundError'
  }
}

export class TenantConcurrencyError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} was modified by another operation`)
    this.name = 'TenantConcurrencyError'
  }
}

export class TenantCannotBeEnabledError extends Error {
  constructor(
    readonly tenantId: string,
    message: string,
  ) {
    super(message)
    this.name = 'TenantCannotBeEnabledError'
  }
}

export class TenantCannotBeDeletedError extends Error {
  constructor(readonly tenantId: string, message: string) {
    super(message)
    this.name = 'TenantCannotBeDeletedError'
  }
}

export class TenantCannotBeUpdatedError extends Error {
  constructor(readonly tenantId: string) {
    super('已解除管理的租户不能修改当前名称或限额，请先重新登记或完成授权接入。')
    this.name = 'TenantCannotBeUpdatedError'
  }
}

function isStorageConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const statusCode = Reflect.get(error, 'statusCode')
  const code = Reflect.get(error, 'code')
  return (
    statusCode === 409 ||
    statusCode === 412 ||
    code === 'BlobAlreadyExists' ||
    code === 'ConditionNotMet'
  )
}

function isBlobNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (
    Reflect.get(error, 'statusCode') === 404 ||
    Reflect.get(error, 'code') === 'BlobNotFound'
  )
}

export function createBlobServiceClient(
  options: BlobTenantRepositoryOptions,
): BlobServiceClient {
  if (options.connectionString) {
    return BlobServiceClient.fromConnectionString(options.connectionString)
  }

  if (!options.accountUrl) {
    throw new Error(
      'Blob repository requires connectionString or accountUrl',
    )
  }

  const credential = options.managedIdentityClientId
    ? new DefaultAzureCredential({
        managedIdentityClientId: options.managedIdentityClientId,
      })
    : new DefaultAzureCredential()

  return new BlobServiceClient(options.accountUrl, credential)
}

async function downloadJson<T>(
  container: ContainerClient,
  blobName: string,
): Promise<{ value: T; etag: string }> {
  const blobClient = container.getBlobClient(blobName)
  const properties = await blobClient.getProperties()

  if (!properties.etag) {
    throw new Error(`Blob ${blobName} did not return an ETag`)
  }
  const buffer = await blobClient.downloadToBuffer(0, undefined, {
    conditions: { ifMatch: properties.etag },
  })

  return {
    value: JSON.parse(buffer.toString('utf8')) as T,
    etag: properties.etag,
  }
}

export class BlobTenantRepository {
  private readonly configuration: ContainerClient
  private readonly audit: ContainerClient
  private readonly inventory: ContainerClient
  private readonly operations: ContainerClient
  private readonly autoCreateContainers: boolean

  constructor(options: BlobTenantRepositoryOptions) {
    const service = createBlobServiceClient(options)
    this.configuration = service.getContainerClient(
      options.configurationContainerName ?? 'configuration',
    )
    this.audit = service.getContainerClient(
      options.auditContainerName ?? 'audit',
    )
    this.inventory = service.getContainerClient(
      options.inventoryContainerName ?? 'inventory',
    )
    this.operations = service.getContainerClient(
      options.operationsContainerName ?? 'operations',
    )
    this.autoCreateContainers = options.autoCreateContainers
  }

  async initialize(): Promise<void> {
    if (this.autoCreateContainers) {
      await Promise.all([
        this.configuration.createIfNotExists(),
        this.audit.createIfNotExists(),
        this.inventory.createIfNotExists(),
        this.operations.createIfNotExists(),
      ])
    }

    await this.checkReady()
  }

  async checkReady(): Promise<void> {
    await Promise.all([
      this.configuration.getProperties(),
      this.audit.getProperties(),
      this.inventory.getProperties(),
      this.operations.getProperties(),
    ])
  }

  withAuthorizationSyncLease<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withBlobLease(this.operations, 'locks/authorization-sync', work, AbortSignal.timeout(12 * 60_000))
  }

  withTenantAuthorizationLease<T>(tenantId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = TenantIdSchema.parse(tenantId)
    return withBlobLease(this.operations, `locks/tenant-authorization/${id}`, work, AbortSignal.timeout(12 * 60_000))
  }

  async listTenants(): Promise<TenantListItem[]> {
    const names: string[] = []
    for await (const blob of this.configuration.listBlobsFlat({
      prefix: 'tenants/',
    })) {
      if (blob.name.endsWith('.json')) names.push(blob.name)
    }
    const results = await mapConcurrent(names, 16, async (name) => {
      try {
        const { value, etag } = await downloadJson<unknown>(this.configuration, name)
        return { ...TenantConfigSchema.parse(value), etag }
      } catch (error) {
        if (storageErrorCode(error) === 'BlobNotFound') return null
        throw error
      }
    })
    const tenants = results.flatMap((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value ? [result.value] : []
    })
    return tenants.sort((left, right) =>
      right.createdAtUtc.localeCompare(left.createdAtUtc),
    )
  }

  async getTenant(tenantIdInput: string): Promise<TenantListItem> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    try {
      const { value, etag } = await downloadJson<unknown>(
        this.configuration,
        this.tenantBlobName(tenantId),
      )
      return {
        ...TenantConfigSchema.parse(value),
        etag,
      }
    } catch (error) {
      if (isBlobNotFound(error)) {
        throw new TenantNotFoundError(tenantId)
      }
      throw error
    }
  }

  async createTenant(
    request: CreateTenantRequest,
    actor: AuthenticatedActor,
    correlationId: string,
    now = new Date(),
  ): Promise<CreateTenantResult> {
    let existing: TenantListItem | null = null
    try { existing = await this.getTenant(request.tenantId) } catch (error) {
      if (!(error instanceof TenantNotFoundError)) throw error
    }
    if (existing?.status === 'deleted') {
      return this.withTenantAuthorizationLease(request.tenantId, async () => {
        const current = await this.getTenant(request.tenantId)
        if (current.status !== 'deleted') throw new TenantAlreadyExistsError(current.tenantId)
        const tenant = await this.updateTenantDocument(current, {
          displayName: request.displayName, hourlyThresholdUsd: request.hourlyThresholdUsd, notes: request.notes,
          status: 'pendingAuthorization', authorizationSource: 'manual-preregistration',
          deletedAtUtc: null, revision: current.revision + 1, updatedAtUtc: now.toISOString(),
        }, {
          action: 'tenant.create.completed', actorObjectId: actor.objectId, actorName: actor.name,
          changedFields: ['displayName', 'hourlyThresholdUsd', 'notes', 'status', 'deletedAtUtc'], correlationId,
        })
        return { tenant, auditCompletionRecorded: true }
      })
    }
    const occurredAtUtc = now.toISOString()
    const changedFields = [
      'displayName',
      'hourlyThresholdUsd',
      'notes',
      'status',
    ]
    const tenant: TenantConfig = TenantConfigSchema.parse({
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
      createdAtUtc: occurredAtUtc,
      updatedAtUtc: occurredAtUtc,
      deletedAtUtc: null,
    })

    await this.writeAudit({
      schemaVersion: 1,
      eventId: randomUUID(),
      action: 'tenant.create.requested',
      outcome: 'attempted',
      actorObjectId: actor.objectId,
      actorName: actor.name,
      targetType: 'tenant',
      targetId: tenant.tenantId,
      changedFields,
      occurredAtUtc,
      correlationId,
    })

    const blobClient = this.configuration.getBlockBlobClient(
      this.tenantBlobName(tenant.tenantId),
    )
    const body = `${JSON.stringify(tenant, null, 2)}\n`

    try {
      const response = await blobClient.upload(
        body,
        Buffer.byteLength(body),
        {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
          conditions: {
            ifNoneMatch: '*',
          },
        },
      )

      if (!response.etag) {
        throw new Error('Tenant blob upload did not return an ETag')
      }

      let auditCompletionRecorded = true
      try {
        await this.writeAudit({
          schemaVersion: 1,
          eventId: randomUUID(),
          action: 'tenant.create.completed',
          outcome: 'succeeded',
          actorObjectId: actor.objectId,
          actorName: actor.name,
          targetType: 'tenant',
          targetId: tenant.tenantId,
          changedFields,
          occurredAtUtc: new Date().toISOString(),
          correlationId,
        })
      } catch {
        auditCompletionRecorded = false
      }

      return {
        tenant: { ...tenant, etag: response.etag },
        auditCompletionRecorded,
      }
    } catch (error) {
      if (isStorageConflict(error)) {
        throw new TenantAlreadyExistsError(tenant.tenantId)
      }
      throw error
    }
  }

  async createDiscoveredTenant(
    tenantIdInput: string,
    displayName: string,
    correlationId: string,
    now = new Date(),
  ): Promise<TenantListItem> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    try {
      return await this.getTenant(tenantId)
    } catch (error) {
      if (!(error instanceof TenantNotFoundError)) throw error
    }

    const occurredAtUtc = now.toISOString()
    const tenant = TenantConfigSchema.parse({
      schemaVersion: 1,
      revision: 1,
      tenantId,
      displayName,
      status: 'discovered',
      authorizationSource: 'lighthouse-template',
      hourlyThresholdUsd: null,
      notes: '',
      createdByObjectId: 'authorization-sync-job',
      createdByName: 'authorization-sync-job',
      createdAtUtc: occurredAtUtc,
      updatedAtUtc: occurredAtUtc,
      deletedAtUtc: null,
    })
    const body = `${JSON.stringify(tenant, null, 2)}\n`
    const blobClient = this.configuration.getBlockBlobClient(
      this.tenantBlobName(tenantId),
    )

    try {
      const response = await blobClient.upload(
        body,
        Buffer.byteLength(body),
        {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
          conditions: { ifNoneMatch: '*' },
        },
      )
      if (!response.etag) {
        throw new Error('Discovered tenant upload did not return an ETag')
      }
      await this.writeAudit({
        schemaVersion: 1,
        eventId: randomUUID(),
        action: 'tenant.authorization.synced',
        outcome: 'succeeded',
        actorObjectId: 'authorization-sync-job',
        actorName: 'authorization-sync-job',
        targetType: 'tenant',
        targetId: tenantId,
        changedFields: ['status', 'authorizationSource'],
        occurredAtUtc,
        correlationId,
      })
      return { ...tenant, etag: response.etag }
    } catch (error) {
      if (isStorageConflict(error)) return this.getTenant(tenantId)
      throw error
    }
  }

  async deletePendingTenant(
    tenantIdInput: string,
    expectedEtag: string,
    actor: AuthenticatedActor,
    correlationId: string,
    now = new Date(),
  ): Promise<DeleteTenantRegistrationResult> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    return this.withTenantAuthorizationLease(tenantId, async (signal) => {
      const tenant = await this.getTenant(tenantId)
      if (tenant.etag !== expectedEtag) throw new TenantConcurrencyError(tenantId)
      if (tenant.status !== 'pendingAuthorization') {
        throw new TenantCannotBeDeletedError(tenantId, '只能删除“等待客户授权”的预登记；已授权租户请使用解除管理。')
      }
      const inventory = await this.getSubscriptionInventory(tenantId)
      if (inventory?.subscriptions.length || inventory?.expectedSubscriptionIds.length) {
        throw new TenantCannotBeDeletedError(tenantId, '该租户仍有已委派或待核验的订阅，请先同步授权并使用解除管理。')
      }
      const audit: AuditEvent = {
        schemaVersion: 1, eventId: randomUUID(), action: 'tenant.delete.requested', outcome: 'attempted',
        actorObjectId: actor.objectId, actorName: actor.name,
        targetType: 'tenant', targetId: tenantId, changedFields: ['registration'],
        occurredAtUtc: now.toISOString(), correlationId,
      }
      signal.throwIfAborted()
      await this.writeAudit(audit)
      try {
        await this.configuration.getBlockBlobClient(this.tenantBlobName(tenantId)).delete({
          conditions: { ifMatch: expectedEtag }, abortSignal: signal,
        })
      } catch (error) {
        if (isStorageConflict(error)) throw new TenantConcurrencyError(tenantId)
        if (storageErrorCode(error) === 'BlobNotFound') throw new TenantNotFoundError(tenantId)
        throw error
      }
      let auditCompletionRecorded = true
      try {
        await this.writeAudit({
          ...audit, eventId: randomUUID(), action: 'tenant.delete.completed',
          outcome: 'succeeded', occurredAtUtc: new Date().toISOString(),
        })
      } catch {
        auditCompletionRecorded = false
      }
      return { tenantId, auditCompletionRecorded }
    })
  }

  async updateTenantAuthorization(
    tenant: TenantListItem,
    status: TenantConfig['status'],
    correlationId: string,
    now = new Date(),
  ): Promise<TenantListItem> {
    if (tenant.status === status) return tenant
    return this.updateTenantDocument(
      tenant,
      {
        status,
        deletedAtUtc: status === 'deleted' ? now.toISOString() : null,
        revision: tenant.revision + 1,
        updatedAtUtc: now.toISOString(),
      },
      {
        action: 'tenant.authorization.synced',
        actorObjectId: 'authorization-sync-job',
        actorName: 'authorization-sync-job',
        changedFields: ['status', 'deletedAtUtc'],
        correlationId,
      },
    )
  }

  async updateTenantSettings(
    tenantIdInput: string,
    input: UpdateTenantSettingsRequest,
    expectedEtag: string,
    actor: AuthenticatedActor,
    correlationId: string,
    now = new Date(),
  ): Promise<TenantListItem> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    const value = UpdateTenantSettingsRequestSchema.parse(input)
    return this.withTenantAuthorizationLease(tenantId, async (signal) => {
      const tenant = await this.getTenant(tenantId)
      if (tenant.etag !== expectedEtag) throw new TenantConcurrencyError(tenantId)
      if (tenant.status === 'deleted') throw new TenantCannotBeUpdatedError(tenantId)
      if (tenant.displayName === value.displayName && tenant.hourlyThresholdUsd === value.hourlyThresholdUsd) return tenant
      signal.throwIfAborted()
      return this.updateTenantDocument(tenant, {
        displayName: value.displayName, hourlyThresholdUsd: value.hourlyThresholdUsd,
        revision: tenant.revision + 1, updatedAtUtc: now.toISOString(),
      }, {
        action: 'tenant.settings.updated', actorObjectId: actor.objectId, actorName: actor.name,
        changedFields: ['displayName', 'hourlyThresholdUsd'], correlationId,
      })
    })
  }

  async enableTenant(
    tenantIdInput: string,
    request: EnableTenantRequest,
    actor: AuthenticatedActor,
    correlationId: string,
    now = new Date(),
  ): Promise<TenantListItem> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    return this.withTenantAuthorizationLease(tenantId, async () => {
    const tenant = await this.getTenant(tenantId)
    if (tenant.etag !== request.etag) {
      throw new TenantConcurrencyError(tenantId)
    }
    if (tenant.status !== 'discovered' && tenant.status !== 'disabled') {
      throw new TenantCannotBeEnabledError(
        tenantId,
        `Tenant in ${tenant.status} status cannot be enabled`,
      )
    }
    const inventory = await this.getSubscriptionInventory(tenantId)
    if (!inventory || !inventory.subscriptions.some((item) => item.state.toLowerCase() === 'enabled') ||
      now.getTime() - Date.parse(inventory.observedAtUtc) > 2 * 3_600_000) {
      throw new TenantCannotBeEnabledError(
        tenantId,
        'Tenant has no recently verified enabled delegated subscriptions; synchronize authorization first.',
      )
    }

    return this.updateTenantDocument(
      tenant,
      {
        displayName: request.displayName,
        hourlyThresholdUsd: request.hourlyThresholdUsd,
        status: inventory.subscriptions.every((item) => item.state.toLowerCase() === 'enabled') ? 'active' : 'degraded',
        revision: tenant.revision + 1,
        updatedAtUtc: now.toISOString(),
      },
      {
        action: 'tenant.enabled',
        actorObjectId: actor.objectId,
        actorName: actor.name,
        changedFields: [
          'displayName',
          'hourlyThresholdUsd',
          'status',
        ],
        correlationId,
      },
    )
    })
  }

  async getSubscriptionInventory(
    tenantIdInput: string,
  ): Promise<SubscriptionInventoryDocument | null> {
    const tenantId = TenantIdSchema.parse(tenantIdInput)
    try {
      const { value } = await downloadJson<unknown>(
        this.inventory,
        this.inventoryBlobName(tenantId),
      )
      const inventory = SubscriptionInventoryDocumentSchema.parse(value)
      let removed = inventory.removedSubscriptions ?? []
      try {
        const archive = await downloadJson<unknown>(this.inventory, `tenants/${tenantId}/removed-subscriptions.json`)
        const document = RemovedSubscriptionsDocumentSchema.parse(archive.value)
        if (document.tenantId !== tenantId) throw new Error('Removed-subscription archive belongs to a different tenant.')
        const visible = new Set(inventory.subscriptions.map((item) => item.subscriptionId))
        removed = document.items.filter((item) => !visible.has(item.subscriptionId))
      } catch (error) {
        if (!isBlobNotFound(error)) throw error
      }
      return { ...inventory, removedSubscriptions: removed }
    } catch (error) {
      if (isBlobNotFound(error)) return null
      throw error
    }
  }

  async writeSubscriptionInventory(
    inventoryInput: SubscriptionInventoryDocument,
  ): Promise<SubscriptionInventoryDocument> {
    const inventory =
      SubscriptionInventoryDocumentSchema.parse(inventoryInput)
    const { removedSubscriptions, ...activeInventory } = inventory
    if (removedSubscriptions) {
      await this.upsertJson(this.inventory, `tenants/${inventory.tenantId}/removed-subscriptions.json`,
        RemovedSubscriptionsDocumentSchema.parse({
          schemaVersion: 1, tenantId: inventory.tenantId, items: removedSubscriptions,
        }))
    }
    await this.upsertJson(
      this.inventory,
      this.inventoryBlobName(inventory.tenantId),
      activeInventory,
    )
    return inventory
  }

  async writeAuthorizationSyncRun(
    runInput: AuthorizationSyncRun,
  ): Promise<void> {
    const run = AuthorizationSyncRunSchema.parse(runInput)
    const startedAt = new Date(run.startedAtUtc)
    const year = startedAt.getUTCFullYear()
    const month = String(startedAt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(startedAt.getUTCDate()).padStart(2, '0')
    const runName = `runs/authorization/${year}/${month}/${day}/${run.runId}.json`
    await this.upsertJson(this.operations, runName, run)
    await this.upsertJson(
      this.operations,
      'runs/authorization/latest.json',
      run,
    )
  }

  async getLatestAuthorizationSyncRun(): Promise<AuthorizationSyncRun | null> {
    try {
      const { value } = await downloadJson<unknown>(
        this.operations,
        'runs/authorization/latest.json',
      )
      return AuthorizationSyncRunSchema.parse(value)
    } catch (error) {
      if (isBlobNotFound(error)) return null
      throw error
    }
  }

  private tenantBlobName(tenantId: string): string {
    return `tenants/${tenantId}.json`
  }

  private inventoryBlobName(tenantId: string): string {
    return `tenants/${tenantId}/subscriptions.json`
  }

  private async updateTenantDocument(
    current: TenantListItem,
    changes: Partial<TenantConfig>,
    audit: {
      action: AuditEvent['action']
      actorObjectId: string
      actorName: string
      changedFields: string[]
      correlationId: string
    },
  ): Promise<TenantListItem> {
    const { etag: _etag, ...currentDocument } = current
    const next = TenantConfigSchema.parse({
      ...currentDocument,
      ...changes,
    })
    const body = `${JSON.stringify(next, null, 2)}\n`
    try {
      const response = await this.configuration
        .getBlockBlobClient(this.tenantBlobName(current.tenantId))
        .upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
          conditions: { ifMatch: current.etag },
        })
      if (!response.etag) {
        throw new Error('Tenant update did not return an ETag')
      }
      await this.writeAudit({
        schemaVersion: 1,
        eventId: randomUUID(),
        action: audit.action,
        outcome: 'succeeded',
        actorObjectId: audit.actorObjectId,
        actorName: audit.actorName,
        targetType: 'tenant',
        targetId: current.tenantId,
        changedFields: audit.changedFields,
        occurredAtUtc: next.updatedAtUtc,
        correlationId: audit.correlationId,
      })
      return { ...next, etag: response.etag }
    } catch (error) {
      if (isStorageConflict(error)) {
        throw new TenantConcurrencyError(current.tenantId)
      }
      throw error
    }
  }

  private async upsertJson(
    container: ContainerClient,
    blobName: string,
    value: unknown,
  ): Promise<void> {
    const blob = container.getBlockBlobClient(blobName)
    const body = `${JSON.stringify(value, null, 2)}\n`
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const properties = await blob.getProperties()
        if (!properties.etag) {
          throw new Error(`Blob ${blobName} did not return an ETag`)
        }
        await blob.upload(body, Buffer.byteLength(body), {
          blobHTTPHeaders: {
            blobContentType: 'application/json; charset=utf-8',
          },
          conditions: { ifMatch: properties.etag },
        })
        return
      } catch (error) {
        if (isBlobNotFound(error)) {
          try {
            await blob.upload(body, Buffer.byteLength(body), {
              blobHTTPHeaders: {
                blobContentType: 'application/json; charset=utf-8',
              },
              conditions: { ifNoneMatch: '*' },
            })
            return
          } catch (createError) {
            if (!isStorageConflict(createError)) throw createError
          }
        } else if (!isStorageConflict(error)) {
          throw error
        }
      }
    }
    throw new Error(`Failed to update ${blobName} after 3 attempts`)
  }

  private async writeAudit(eventInput: AuditEvent): Promise<void> {
    const event = AuditEventSchema.parse(eventInput)
    const occurredAt = new Date(event.occurredAtUtc)
    const year = occurredAt.getUTCFullYear()
    const month = String(occurredAt.getUTCMonth() + 1).padStart(2, '0')
    const day = String(occurredAt.getUTCDate()).padStart(2, '0')
    const safeTimestamp = event.occurredAtUtc.replaceAll(':', '-')
    const blobName = `${year}/${month}/${day}/${safeTimestamp}-${event.eventId}.json`
    const body = `${JSON.stringify(event, null, 2)}\n`

    await this.audit.getBlockBlobClient(blobName).upload(
      body,
      Buffer.byteLength(body),
      {
        blobHTTPHeaders: {
          blobContentType: 'application/json; charset=utf-8',
        },
        conditions: {
          ifNoneMatch: '*',
        },
      },
    )
  }
}
