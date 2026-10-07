import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DefaultAzureCredential } from '@azure/identity'
import { mapConcurrent, reconcileAuthorization } from '@tokenusagealert/domain'
import {
  AuthorizationSyncRunSchema,
  SubscriptionInventoryDocumentSchema,
  TenantIdSchema,
  type AuthorizationSyncRun,
  type SubscriptionInventoryDocument,
  type RemovedSubscription,
  type TenantListItem,
} from '@tokenusagealert/schemas'
import { z } from 'zod'
import { TenantNotFoundError, type BlobTenantRepository } from './index.js'

export interface VisibleSubscription {
  subscriptionId: string
  displayName: string
  tenantId: string
  state: string
}

export interface SubscriptionDiscovery {
  listVisibleSubscriptions(signal?: AbortSignal): Promise<VisibleSubscription[]>
  verifyMissingSubscription(subscriptionId: string, tenantId: string, signal?: AbortSignal): Promise<
    { status: 'removed' } | { status: 'visible'; subscription: VisibleSubscription }
  >
}

export interface AuthorizationSyncStarter {
  start(): Promise<{ executionName: string }>
}

const ArmSubscriptionSchema = z
  .object({
    subscriptionId: TenantIdSchema,
    displayName: z.string().min(1),
    tenantId: TenantIdSchema,
    state: z.string().min(1),
  })
  .passthrough()

const ArmSubscriptionPageSchema = z
  .object({
    value: z.array(ArmSubscriptionSchema),
    nextLink: z.string().url().nullish(),
  })
  .passthrough()

function credential(clientId?: string) {
  return clientId
    ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
    : new DefaultAzureCredential()
}

export class ArmSubscriptionDiscovery implements SubscriptionDiscovery {
  private readonly fetcher: typeof fetch
  private readonly tokenCredential: { getToken(scope: string): Promise<{ token: string } | null> }
  private completedSnapshot: Set<string> | undefined

  constructor(
    private readonly managingTenantId: string,
    managedIdentityClientId?: string,
    options: {
      fetcher?: typeof fetch
      credential?: { getToken(scope: string): Promise<{ token: string } | null> }
    } = {},
  ) {
    this.managingTenantId = TenantIdSchema.parse(managingTenantId)
    this.fetcher = options.fetcher ?? fetch
    this.tokenCredential = options.credential ?? credential(managedIdentityClientId)
  }

  private async read(url: URL, externalSignal?: AbortSignal): Promise<Response> {
    if (url.origin !== 'https://management.azure.com' || url.username || url.password) {
      throw new Error('Unexpected authorization discovery URL.')
    }
    const token = await this.tokenCredential.getToken('https://management.azure.com/.default')
    if (!token) throw new Error('Unable to acquire Azure management token.')
    const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(externalSignal ? [externalSignal] : [])])
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${token.token}` },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      })
      if (attempt === 2 || ![429, 500, 502, 503, 504].includes(response.status)) return response
      const retryAfter = response.headers.get('retry-after')
      const wait = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : retryAfter && Number.isFinite(Date.parse(retryAfter))
          ? Math.max(0, Date.parse(retryAfter) - Date.now()) : 1000 * 2 ** attempt
      await response.body?.cancel()
      await delay(wait, undefined, { signal })
    }
    throw new Error('Authorization discovery retry limit reached.')
  }

  async listVisibleSubscriptions(signal?: AbortSignal): Promise<VisibleSubscription[]> {
    this.completedSnapshot = undefined
    const subscriptions: VisibleSubscription[] = []
    const visited = new Set<string>()
    let nextUrl: string | null | undefined =
      'https://management.azure.com/subscriptions?api-version=2022-12-01'
    while (nextUrl) {
      const url = new URL(nextUrl)
      if (url.pathname !== '/subscriptions' || visited.has(url.href) || visited.size >= 1000) {
        throw new Error('Authorization discovery pagination is invalid or incomplete.')
      }
      visited.add(url.href)
      const response = await this.read(url, signal)
      if (!response.ok) {
        throw new Error(
          `ARM subscriptions list failed with ${response.status}`,
        )
      }
      const page = ArmSubscriptionPageSchema.parse(await response.json())
      subscriptions.push(
        ...page.value
          .filter(
            (subscription) =>
              subscription.tenantId !== this.managingTenantId,
          )
          .map((subscription) => ({
            subscriptionId: subscription.subscriptionId,
            displayName: subscription.displayName,
            tenantId: subscription.tenantId,
            state: subscription.state,
          })),
      )
      nextUrl = page.nextLink
    }
    this.completedSnapshot = new Set(subscriptions.map((item) => item.subscriptionId))
    return subscriptions
  }

  async verifyMissingSubscription(subscriptionId: string, tenantId: string, signal?: AbortSignal) {
    const id = TenantIdSchema.parse(subscriptionId)
    const response = await this.read(new URL(`https://management.azure.com/subscriptions/${id}?api-version=2022-12-01`), signal)
    if (response.ok) {
      const subscription = ArmSubscriptionSchema.parse(await response.json())
      if (subscription.subscriptionId !== id || subscription.tenantId !== tenantId) {
        throw new Error('The subscription ownership could not be verified; no automatic removal was applied.')
      }
      return { status: 'visible' as const, subscription }
    }
    const error = z.object({ error: z.object({ code: z.string() }).passthrough() }).safeParse(await response.json())
    const crossTenantAccessRemoved = response.status === 401 && error.success &&
      error.data.error.code === 'InvalidAuthenticationTokenTenant' &&
      tenantId !== this.managingTenantId && this.completedSnapshot !== undefined &&
      !this.completedSnapshot.has(id)
    if (error.success &&
      ((response.status === 403 && error.data.error.code === 'AuthorizationFailed') ||
        (response.status === 404 && error.data.error.code === 'SubscriptionNotFound') ||
        crossTenantAccessRemoved)) {
      return { status: 'removed' as const }
    }
    throw new Error(`Subscription access verification failed with HTTP ${response.status} (${error.success ? error.data.error.code : 'unrecognized response'}); its previous state was retained.`)
  }
}

export class FixtureSubscriptionDiscovery
  implements SubscriptionDiscovery
{
  constructor(
    private readonly subscriptions: VisibleSubscription[],
  ) {}

  async listVisibleSubscriptions(): Promise<VisibleSubscription[]> {
    return this.subscriptions
  }
  async verifyMissingSubscription(subscriptionId: string, tenantId: string) {
    const subscription = this.subscriptions.find((item) => item.subscriptionId === subscriptionId && item.tenantId === tenantId)
    return subscription ? { status: 'visible' as const, subscription } : { status: 'removed' as const }
  }
}

export class ArmContainerAppsJobStarter
  implements AuthorizationSyncStarter
{
  constructor(
    private readonly subscriptionId: string,
    private readonly resourceGroup: string,
    private readonly jobName: string,
    private readonly managedIdentityClientId?: string,
  ) {}

  async start(): Promise<{ executionName: string }> {
    const token = await credential(
      this.managedIdentityClientId,
    ).getToken('https://management.azure.com/.default')
    if (!token) throw new Error('Unable to acquire Azure management token')
    const url =
      `https://management.azure.com/subscriptions/${this.subscriptionId}` +
      `/resourceGroups/${this.resourceGroup}/providers/Microsoft.App/jobs/` +
      `${this.jobName}/start?api-version=2025-01-01`
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    if (!response.ok) {
      throw new Error(
        `Container Apps Job start failed with ${response.status}`,
      )
    }
    const result = z.object({ name: z.string().min(1) }).parse(await response.json())
    return {
      executionName: result.name,
    }
  }
}

export class InlineAuthorizationSyncStarter
  implements AuthorizationSyncStarter
{
  constructor(private readonly service: AuthorizationSyncService) {}

  async start(): Promise<{ executionName: string }> {
    const run = await this.service.run()
    return { executionName: run.runId }
  }
}

export class AuthorizationSyncService {
  constructor(
    private readonly repository: BlobTenantRepository,
    private readonly discovery: SubscriptionDiscovery,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(): Promise<AuthorizationSyncRun> {
    return this.repository.withAuthorizationSyncLease((signal) => this.runLocked(signal))
  }

  private async runLocked(signal: AbortSignal): Promise<AuthorizationSyncRun> {
    const runId = randomUUID()
    const startedAtUtc = this.now().toISOString()
    let run: AuthorizationSyncRun = {
      schemaVersion: 1,
      runId,
      status: 'running',
      startedAtUtc,
      finishedAtUtc: null,
      discoveredTenantCount: 0,
      visibleSubscriptionCount: 0,
      updatedTenantCount: 0,
      errors: [],
    }
    await this.repository.writeAuthorizationSyncRun(run)

    try {
      const subscriptions =
        await this.discovery.listVisibleSubscriptions(signal)
      const groups = new Map<string, VisibleSubscription[]>()
      const uniqueSubscriptions = new Set<string>()
      for (const subscription of subscriptions) {
        if (uniqueSubscriptions.has(subscription.subscriptionId)) {
          throw new Error('Duplicate subscription IDs in discovery response; previous authorization inventory was retained.')
        }
        uniqueSubscriptions.add(subscription.subscriptionId)
        const group = groups.get(subscription.tenantId) ?? []
        group.push(subscription)
        groups.set(subscription.tenantId, group)
      }
      const allTenants = await this.repository.listTenants()
      const tenantById = new Map(allTenants.map((tenant) => [tenant.tenantId, tenant]))
      let updatedTenantCount = 0

      const ids = [...new Set([...groups.keys(), ...tenantById.keys()])]
      const results = await mapConcurrent(ids, 8, async (tenantId) => {
        const original = tenantById.get(tenantId)
        if (!groups.has(tenantId) && original?.status === 'deleted') return
        await this.repository.withTenantAuthorizationLease(tenantId, async (tenantSignal) => {
        const scopeSignal = AbortSignal.any([signal, tenantSignal])
        try {
          scopeSignal.throwIfAborted()
          let tenant: TenantListItem
          try {
            tenant = await this.repository.getTenant(tenantId)
          } catch (error) {
            if (!(error instanceof TenantNotFoundError)) throw error
            if (!groups.has(tenantId)) return
            tenant = await this.repository.createDiscoveredTenant(
              tenantId,
              `Azure Lighthouse 租户 ${tenantId.slice(0, 8)}`,
              runId,
              this.now(),
            )
          }
          const previous =
            await this.repository.getSubscriptionInventory(tenantId)
          const visible = [...(groups.get(tenantId) ?? [])]
          const visibleIds = new Set(visible.map((item) => item.subscriptionId))
          const previousIds = [...new Set([
            ...(previous?.expectedSubscriptionIds ?? []),
            ...(previous?.subscriptions.map((item) => item.subscriptionId) ?? []),
          ])]
          if (visible.length === 0 && previousIds.length === 0) {
            // Recover an interrupted inventory-first removal without requiring a second access-loss event.
            if (previous?.removedSubscriptions?.length && !['pendingAuthorization', 'deleted'].includes(tenant.status)) {
              await this.repository.updateTenantAuthorization(tenant, 'deleted', runId, this.now())
              updatedTenantCount += 1
            }
            return
          }
          const missing = previousIds.filter((id) => !visibleIds.has(id))
          const checks = await mapConcurrent(missing, 4, (id) => this.discovery.verifyMissingSubscription(id, tenantId, scopeSignal), scopeSignal)
          const removed: string[] = []
          // A failed verification leaves this tenant's inventory and config unchanged.
          for (const [index, result] of checks.entries()) {
            if (result.status === 'rejected') throw result.reason
            if (result.value.status === 'removed') removed.push(missing[index]!)
            else visible.push(result.value.subscription)
          }
          const enabled = visible.filter((item) => item.state.toLowerCase() === 'enabled')
          const unavailable = visible.filter((item) => item.state.toLowerCase() !== 'enabled')
          const reconciliation = reconcileAuthorization({
            currentStatus: tenant.status,
            previousExpectedSubscriptionIds: previousIds,
            visibleSubscriptionIds: enabled.map((subscription) => subscription.subscriptionId),
            unavailableSubscriptionIds: unavailable.map((subscription) => subscription.subscriptionId),
            confirmedRemovedSubscriptionIds: removed,
          })
          const inventory = this.inventoryDocument(
            tenantId,
            visible,
            previous,
            reconciliation.expectedSubscriptionIds,
            removed,
          )
          scopeSignal.throwIfAborted()
          await this.repository.writeSubscriptionInventory(inventory)
          scopeSignal.throwIfAborted()
          const updated =
            await this.repository.updateTenantAuthorization(
              tenant,
              reconciliation.nextStatus,
              runId,
              this.now(),
            )
          if (updated.revision !== tenant.revision) {
            updatedTenantCount += 1
          }
        } catch (error) {
          run.errors.push({
            tenantId,
            code: 'TENANT_SYNC_FAILED',
            message:
              error instanceof Error ? error.message : 'Unknown error',
          })
        }
        })
      }, signal)
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          run.errors.push({
            tenantId: ids[index]!,
            code: 'TENANT_SYNC_FAILED',
            message: result.reason instanceof Error ? result.reason.message : 'Authorization synchronization failed.',
          })
        }
      }

      run = AuthorizationSyncRunSchema.parse({
        ...run,
        status:
          run.errors.length > 0
            ? 'succeededWithWarnings'
            : 'succeeded',
        finishedAtUtc: this.now().toISOString(),
        discoveredTenantCount: groups.size,
        visibleSubscriptionCount: subscriptions.length,
        updatedTenantCount,
      })
    } catch (error) {
      run = AuthorizationSyncRunSchema.parse({
        ...run,
        status: 'failed',
        finishedAtUtc: this.now().toISOString(),
        errors: [
          {
            tenantId: null,
            code: 'SUBSCRIPTION_DISCOVERY_FAILED',
            message:
              error instanceof Error ? error.message : 'Unknown error',
          },
        ],
      })
    }

    signal.throwIfAborted()
    await this.repository.writeAuthorizationSyncRun(run)
    return run
  }

  private inventoryDocument(
    tenantId: string,
    visible: VisibleSubscription[],
    previous: SubscriptionInventoryDocument | null,
    expectedSubscriptionIds: string[],
    removedIds: string[],
  ): SubscriptionInventoryDocument {
    const now = this.now().toISOString()
    const previousItems = new Map(
      (previous?.subscriptions ?? []).map((item) => [
        item.subscriptionId,
        item,
      ]),
    )
    const currentIds = new Set(visible.map((item) => item.subscriptionId))
    const removed = new Map((previous?.removedSubscriptions ?? [])
      .filter((item) => !currentIds.has(item.subscriptionId)).map((item) => [item.subscriptionId, item]))
    for (const subscriptionId of removedIds) {
      const before = previousItems.get(subscriptionId)
      const archived: RemovedSubscription = {
        subscriptionId, customerTenantId: tenantId,
        displayName: before?.displayName ?? subscriptionId,
        lastSeenAtUtc: before?.lastSeenAtUtc ?? null,
        removedAtUtc: now, reason: 'collector-access-removed',
      }
      removed.set(subscriptionId, archived)
    }
    return SubscriptionInventoryDocumentSchema.parse({
      schemaVersion: 1,
      revision: (previous?.revision ?? 0) + 1,
      tenantId,
      expectedSubscriptionIds,
      subscriptions: visible.map((subscription) => ({
        subscriptionId: subscription.subscriptionId,
        displayName: subscription.displayName,
        customerTenantId: subscription.tenantId,
        state: subscription.state,
        firstSeenAtUtc:
          previousItems.get(subscription.subscriptionId)?.firstSeenAtUtc ??
          now,
        lastSeenAtUtc: now,
        lastValidatedAtUtc: now,
      })),
      removedSubscriptions: [...removed.values()].sort((a, b) => b.removedAtUtc.localeCompare(a.removedAtUtc)),
      observedAtUtc: now,
      updatedAtUtc: now,
    })
  }
}
