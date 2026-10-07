import type { TenantConfig } from '@tokenusagealert/schemas'

export * from './pricing.js'
export * from './usage.js'
export * from './usage-summary.js'
export * from './concurrency.js'
export * from './alerts.js'
export * from './compact-pricing.js'

export interface ReconcileAuthorizationInput {
  currentStatus: TenantConfig['status']
  previousExpectedSubscriptionIds: string[]
  visibleSubscriptionIds: string[]
  confirmedRemovedSubscriptionIds?: string[]
  unavailableSubscriptionIds?: string[]
}

export interface ReconcileAuthorizationResult {
  nextStatus: TenantConfig['status']
  expectedSubscriptionIds: string[]
  missingSubscriptionIds: string[]
  addedSubscriptionIds: string[]
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function reconcileAuthorization({
  currentStatus,
  previousExpectedSubscriptionIds,
  visibleSubscriptionIds,
  confirmedRemovedSubscriptionIds = [],
  unavailableSubscriptionIds = [],
}: ReconcileAuthorizationInput): ReconcileAuthorizationResult {
  const visible = uniqueSorted(visibleSubscriptionIds)
  const previousExpected = uniqueSorted(previousExpectedSubscriptionIds)
  const removed = new Set(confirmedRemovedSubscriptionIds)
  const expected = uniqueSorted([
    ...previousExpected.filter((id) => !removed.has(id)), ...visible, ...unavailableSubscriptionIds,
  ])
  const visibleSet = new Set(visible)
  const previousExpectedSet = new Set(previousExpected)
  const missing = expected.filter((id) => !visibleSet.has(id))
  const added = visible.filter((id) => !previousExpectedSet.has(id))

  let nextStatus = currentStatus
  if (expected.length === 0 && confirmedRemovedSubscriptionIds.length > 0 && currentStatus !== 'pendingAuthorization') {
    nextStatus = 'deleted'
  } else if ((currentStatus === 'pendingAuthorization' || currentStatus === 'deleted' || currentStatus === 'disconnected') &&
    (visible.length > 0 || unavailableSubscriptionIds.length > 0)) {
    nextStatus = 'discovered'
  } else if (
    currentStatus === 'active' ||
    currentStatus === 'degraded'
  ) {
    if (visible.length === 0 && unavailableSubscriptionIds.length === 0) {
      nextStatus = 'disconnected'
    } else if (missing.length > 0) {
      nextStatus = 'degraded'
    } else {
      nextStatus = 'active'
    }
  }

  return {
    nextStatus,
    expectedSubscriptionIds: expected,
    missingSubscriptionIds: missing,
    addedSubscriptionIds: added,
  }
}
