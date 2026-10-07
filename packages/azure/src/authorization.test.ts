import { describe, expect, it, vi } from 'vitest'
import { ArmSubscriptionDiscovery } from './authorization.js'

const managing = '11111111-1111-4111-8111-111111111111'
const customer = '22222222-2222-4222-8222-222222222222'
const subscription = {
  subscriptionId: '33333333-3333-4333-8333-333333333333', displayName: 'Customer subscription',
  tenantId: customer, state: 'Enabled',
}
const credential = { async getToken() { return { token: 'test-only-not-a-real-token' } } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'retry-after': '0' } })

describe('authorization discovery evidence', () => {
  it('keeps disabled subscriptions visible and follows every page before returning a complete snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [{ ...subscription, state: 'Disabled' }], nextLink: 'https://management.azure.com/subscriptions?api-version=2022-12-01&$skiptoken=next' }))
      .mockResolvedValueOnce(json({ value: [{ ...subscription, subscriptionId: '44444444-4444-4444-8444-444444444444' }], nextLink: null }))
    const source = new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
    const values = await source.listVisibleSubscriptions()
    expect(values.map((item) => item.state)).toEqual(['Disabled', 'Enabled'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects a failed second page, unsafe nextLink and repeated pagination', async () => {
    for (const nextLink of ['https://untrusted.example/subscriptions', 'https://management.azure.com/subscriptions?api-version=2022-12-01']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [subscription], nextLink }))
      await expect(new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential }).listVisibleSubscriptions()).rejects.toThrow()
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [subscription], nextLink: 'https://management.azure.com/subscriptions?$skiptoken=next' }))
      .mockResolvedValue(json({ error: { code: 'ServerBusy' } }, 503))
    await expect(new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential }).listVisibleSubscriptions()).rejects.toThrow(/503/)
  })

  it.each([[403, 'AuthorizationFailed'], [404, 'SubscriptionNotFound']] as const)(
    'recognizes an independent access-loss check (%s/%s)', async (status, code) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code } }, status))
      const source = new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
      expect(await source.verifyMissingSubscription(subscription.subscriptionId, customer)).toEqual({ status: 'removed' })
      expect(fetcher.mock.calls[0]?.[1]?.method).not.toBe('DELETE')
    },
  )

  it.each([[401, 'InvalidAuthenticationToken'], [403, 'ForbiddenByPolicy'], [404, 'InvalidResourceType'], [429, 'TooManyRequests'], [500, 'InternalError']] as const)(
    'does not treat HTTP %s/%s as proof of revoked authorization', async (status, code) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ error: { code } }, status))
      await expect(new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
        .verifyMissingSubscription(subscription.subscriptionId, customer)).rejects.toThrow()
    },
  )

  it('retains a subscription when a direct GET proves it is still accessible', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(subscription))
    expect(await new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
      .verifyMissingSubscription(subscription.subscriptionId, customer)).toMatchObject({ status: 'visible', subscription })
  })

  it('recognizes the Lighthouse wrong-tenant response only after a complete same-identity discovery proves absence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input))
      return url.pathname === '/subscriptions'
        ? json({ value: [], nextLink: null })
        : json({ error: { code: 'InvalidAuthenticationTokenTenant' } }, 401)
    })
    const source = new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
    await expect(source.verifyMissingSubscription(subscription.subscriptionId, customer)).rejects.toThrow(/401/)
    await source.listVisibleSubscriptions()
    expect(await source.verifyMissingSubscription(subscription.subscriptionId, customer)).toEqual({ status: 'removed' })
    await expect(source.verifyMissingSubscription(subscription.subscriptionId, managing)).rejects.toThrow(/401/)
  })

  it('does not use an older successful snapshot when the next enumeration fails', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [], nextLink: null }))
      .mockResolvedValueOnce(json({ error: { code: 'InvalidAuthenticationToken' } }, 401))
      .mockResolvedValueOnce(json({ error: { code: 'InvalidAuthenticationTokenTenant' } }, 401))
    const source = new ArmSubscriptionDiscovery(managing, undefined, { fetcher, credential })
    await source.listVisibleSubscriptions()
    await expect(source.listVisibleSubscriptions()).rejects.toThrow(/401/)
    await expect(source.verifyMissingSubscription(subscription.subscriptionId, customer)).rejects.toThrow(/401/)
  })
})
