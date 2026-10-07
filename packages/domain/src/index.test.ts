import { describe, expect, it } from 'vitest'
import { reconcileAuthorization } from './index.js'

const subA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const subB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const subC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('reconcileAuthorization', () => {
  it('moves a preregistered tenant to discovered', () => {
    expect(
      reconcileAuthorization({
        currentStatus: 'pendingAuthorization',
        previousExpectedSubscriptionIds: [],
        visibleSubscriptionIds: [subA, subB],
      }),
    ).toEqual({
      nextStatus: 'discovered',
      expectedSubscriptionIds: [subA, subB],
      missingSubscriptionIds: [],
      addedSubscriptionIds: [subA, subB],
    })
  })

  it('keeps a discovered tenant awaiting explicit enablement', () => {
    expect(
      reconcileAuthorization({
        currentStatus: 'discovered',
        previousExpectedSubscriptionIds: [subA],
        visibleSubscriptionIds: [subA],
      }).nextStatus,
    ).toBe('discovered')
  })

  it('degrades an active tenant when an expected subscription disappears', () => {
    const result = reconcileAuthorization({
      currentStatus: 'active',
      previousExpectedSubscriptionIds: [subA, subB],
      visibleSubscriptionIds: [subA],
    })
    expect(result.nextStatus).toBe('degraded')
    expect(result.missingSubscriptionIds).toEqual([subB])
  })

  it('adds new visible subscriptions to the expected set', () => {
    const result = reconcileAuthorization({
      currentStatus: 'active',
      previousExpectedSubscriptionIds: [subA],
      visibleSubscriptionIds: [subA, subC],
    })
    expect(result.nextStatus).toBe('active')
    expect(result.expectedSubscriptionIds).toEqual([subA, subC])
    expect(result.addedSubscriptionIds).toEqual([subC])
  })

  it('disconnects and restores an active tenant', () => {
    const disconnected = reconcileAuthorization({
      currentStatus: 'active',
      previousExpectedSubscriptionIds: [subA],
      visibleSubscriptionIds: [],
    })
    expect(disconnected.nextStatus).toBe('disconnected')

    const restored = reconcileAuthorization({
      currentStatus: disconnected.nextStatus,
      previousExpectedSubscriptionIds: disconnected.expectedSubscriptionIds,
      visibleSubscriptionIds: [subA],
    })
    expect(restored.nextStatus).toBe('discovered')
  })

  it('does not automatically enable disabled or reauthorized tenants', () => {
    expect(
      reconcileAuthorization({
        currentStatus: 'disabled',
        previousExpectedSubscriptionIds: [subA],
        visibleSubscriptionIds: [],
      }).nextStatus,
    ).toBe('disabled')
    expect(
      reconcileAuthorization({
        currentStatus: 'deleted',
        previousExpectedSubscriptionIds: [subA],
        visibleSubscriptionIds: [subA],
      }).nextStatus,
    ).toBe('discovered')
  })

  it('shrinks expected scope only after an explicit removal confirmation', () => {
    const result = reconcileAuthorization({
      currentStatus: 'degraded',
      previousExpectedSubscriptionIds: [subA, subB],
      visibleSubscriptionIds: [subA],
      confirmedRemovedSubscriptionIds: [subB],
    })
    expect(result).toMatchObject({
      nextStatus: 'active', expectedSubscriptionIds: [subA], missingSubscriptionIds: [],
    })
  })

  it.each(['active', 'degraded', 'discovered', 'disabled', 'disconnected'] as const)(
    'archives %s tenants when every previous subscription is confirmed removed', (currentStatus) => {
      expect(reconcileAuthorization({
        currentStatus, previousExpectedSubscriptionIds: [subA], visibleSubscriptionIds: [],
        confirmedRemovedSubscriptionIds: [subA],
      }).nextStatus).toBe('deleted')
    },
  )

  it('does not treat a disabled subscription or an unauthorised preregistration as a removal', () => {
    expect(reconcileAuthorization({
      currentStatus: 'active', previousExpectedSubscriptionIds: [subA],
      visibleSubscriptionIds: [], unavailableSubscriptionIds: [subA],
    })).toMatchObject({ nextStatus: 'degraded', expectedSubscriptionIds: [subA] })
    expect(reconcileAuthorization({
      currentStatus: 'pendingAuthorization', previousExpectedSubscriptionIds: [],
      visibleSubscriptionIds: [],
    }).nextStatus).toBe('pendingAuthorization')
  })
})
