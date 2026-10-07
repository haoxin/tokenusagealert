import { describe, expect, it, vi } from 'vitest'
import { ArmDelegationRemovalClient, LIGHTHOUSE_DELETE_ROLE } from './offboarding-arm.js'
import type { OffboardingIdentity } from '@tokenusagealert/schemas'

const managing = '11111111-1111-4111-8111-111111111111'
const customer = '22222222-2222-4222-8222-222222222222'
const subscription = '33333333-3333-4333-8333-333333333333'
const identity: OffboardingIdentity = {
  managingTenantId: managing, offerName: 'AOAI Cost Usage Monitoring',
  clientId: '44444444-4444-4444-8444-444444444444',
  principalId: '55555555-5555-4555-8555-555555555555',
  collectorPrincipalId: '66666666-6666-4666-8666-666666666666',
}
const assignmentId = `/subscriptions/${subscription}/providers/Microsoft.ManagedServices/registrationAssignments/77777777-7777-4777-8777-777777777777`
const definitionId = `/subscriptions/${subscription}/providers/Microsoft.ManagedServices/registrationDefinitions/88888888-8888-4888-8888-888888888888`
const credential = { async getToken() { return { token: 'local-test-only' } } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const signal = () => AbortSignal.timeout(5000)

function assignment() {
  return {
    id: assignmentId,
    properties: {
      registrationDefinitionId: definitionId,
      provisioningState: 'Succeeded',
      registrationDefinition: {
        id: definitionId,
        properties: {
          managedByTenantId: managing, manageeTenantId: customer, registrationDefinitionName: identity.offerName,
          authorizations: [
            { principalId: identity.collectorPrincipalId, roleDefinitionId: 'acdd72a7-3385-48ef-bd42-f606fba81ae7' },
            { principalId: identity.principalId, roleDefinitionId: LIGHTHOUSE_DELETE_ROLE },
          ],
          eligibleAuthorizations: [] as unknown[],
        },
      },
    },
  }
}

describe('separate Lighthouse offboarding identity', () => {
  it('previews read-only and deletes only the validated registration assignment after another read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (init?.method === 'DELETE') {
        expect(url.pathname.toLowerCase()).toBe(assignmentId.toLowerCase())
        return new Response(null, { status: 202 })
      }
      expect(url.searchParams.get('$expandRegistrationDefinition')).toBe('true')
      return json({ value: [assignment()] })
    })
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    const plan = await client.inspect(customer, subscription, 'Customer Sub', signal())
    expect(plan.state).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
    const beforeDelete = vi.fn(async () => {})
    expect((await client.remove(customer, plan, beforeDelete, signal())).state).toBe('submitted')
    expect(beforeDelete).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET', 'DELETE'])
  })

  it('supports a same-customer definition reused from another subscription and deletes only the target assignment', async () => {
    const shared = assignment()
    const sharedDefinitionId = definitionId.replace(subscription, '99999999-9999-4999-8999-999999999999')
    shared.properties.registrationDefinitionId = sharedDefinitionId.toLowerCase()
    shared.properties.registrationDefinition.id = sharedDefinitionId
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      expect(url.pathname.toLowerCase()).toContain(`/subscriptions/${subscription}/`)
      if (init?.method === 'DELETE') {
        expect(url.pathname.toLowerCase()).toBe(assignmentId.toLowerCase())
        expect(url.pathname.toLowerCase()).not.toContain('registrationdefinitions')
        return new Response(null, { status: 204 })
      }
      return json({ value: [shared] })
    })
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    const target = await client.inspect(customer, subscription, 'Reused offer', signal())
    expect(target.definitionId).toBe(sharedDefinitionId.toLowerCase())
    expect(target.assignmentId).toBe(assignmentId.toLowerCase())
    const before = vi.fn(async () => {})
    expect((await client.remove(customer, target, before, signal())).state).toBe('submitted')
    expect(before).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET', 'DELETE'])
  })

  it.each([401, 403])('requires customer reauthorization on HTTP %s without trying DELETE', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    await expect(client.inspect(customer, subscription, 'Sub', signal())).rejects.toMatchObject({ code: 'CUSTOMER_REAUTHORIZATION_REQUIRED' })
    expect(fetcher.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true)
  })

  it.each([
    'customer', 'managing', 'offer', 'collector', 'offboard', 'extra-principal', 'resource-group',
    'other-assignment-subscription', 'definition-resource-group', 'definition-invalid-subscription',
    'definition-invalid-name', 'definition-metadata-mismatch', 'eligible', 'missing-metadata',
  ] as const)(
    'refuses a mismatched or overbroad %s scope', async (change) => {
      const item = assignment()
      const properties = item.properties.registrationDefinition.properties
      if (change === 'customer') properties.manageeTenantId = identity.clientId
      if (change === 'managing') properties.managedByTenantId = identity.clientId
      if (change === 'offer') properties.registrationDefinitionName = 'Another MSP'
      if (change === 'collector') properties.authorizations[0]!.principalId = identity.clientId
      if (change === 'offboard') properties.authorizations[1]!.principalId = identity.clientId
      if (change === 'extra-principal') properties.authorizations.push({ principalId: identity.clientId, roleDefinitionId: LIGHTHOUSE_DELETE_ROLE })
      if (change === 'resource-group') item.id = assignmentId.replace('/providers/', '/resourceGroups/another/providers/')
      if (change === 'other-assignment-subscription') item.id = assignmentId.replace(subscription, identity.clientId)
      if (change === 'definition-resource-group') {
        item.properties.registrationDefinitionId = definitionId.replace('/providers/', '/resourceGroups/another/providers/')
        item.properties.registrationDefinition.id = item.properties.registrationDefinitionId
      }
      if (change === 'definition-invalid-subscription') {
        item.properties.registrationDefinitionId = definitionId.replace(subscription, 'not-a-guid')
        item.properties.registrationDefinition.id = item.properties.registrationDefinitionId
      }
      if (change === 'definition-invalid-name') {
        item.properties.registrationDefinitionId = definitionId.replace('88888888-8888-4888-8888-888888888888', 'not-a-guid')
        item.properties.registrationDefinition.id = item.properties.registrationDefinitionId
      }
      if (change === 'definition-metadata-mismatch') item.properties.registrationDefinition.id = definitionId.replace(subscription, identity.clientId)
      if (change === 'eligible') properties.eligibleAuthorizations.push({ principalId: identity.clientId })
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [change === 'missing-metadata' ? { id: assignmentId } : item] }))
      await expect(new ArmDelegationRemovalClient(identity, { credential, fetcher }).inspect(customer, subscription, 'Sub', signal())).rejects.toThrow()
      expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)
    },
  )

  it('blocks another delegation that shares the Collector even if the chosen offer is correct', async () => {
    const other = assignment()
    other.id = assignmentId.replace('77777777', '99999999')
    other.properties.registrationDefinition.properties.registrationDefinitionName = 'Shared Collector Offer'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [assignment(), other] }))
    await expect(new ArmDelegationRemovalClient(identity, { credential, fetcher }).inspect(customer, subscription, 'Sub', signal()))
      .rejects.toMatchObject({ code: 'SHARED_COLLECTOR_DELEGATION' })
  })

  it('revalidates the fingerprint and refuses a changed assignment', async () => {
    const changed = assignment()
    changed.id = assignmentId.replace('77777777', '99999999')
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [assignment()] }))
      .mockResolvedValueOnce(json({ value: [changed] }))
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    const plan = await client.inspect(customer, subscription, 'Sub', signal())
    const before = vi.fn(async () => {})
    await expect(client.remove(customer, plan, before, signal())).rejects.toMatchObject({ code: 'DELEGATION_CHANGED' })
    expect(before).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)
  })

  it('invalidates a preview if the reused definition reference changes before confirmation', async () => {
    const first = assignment()
    first.properties.registrationDefinitionId = definitionId.replace(subscription, '99999999-9999-4999-8999-999999999999')
    first.properties.registrationDefinition.id = first.properties.registrationDefinitionId
    const changed = structuredClone(first)
    changed.properties.registrationDefinitionId = definitionId
    changed.properties.registrationDefinition.id = definitionId
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ value: [first] }))
      .mockResolvedValueOnce(json({ value: [changed] }))
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    const target = await client.inspect(customer, subscription, 'Reused offer', signal())
    const before = vi.fn(async () => {})
    await expect(client.remove(customer, target, before, signal())).rejects.toMatchObject({ code: 'DELEGATION_CHANGED' })
    expect(before).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false)
  })

  it('records an uncertain delete without retrying it automatically', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') throw new TypeError('Connection interrupted')
      return json({ value: [assignment()] })
    })
    const client = new ArmDelegationRemovalClient(identity, { credential, fetcher })
    const plan = await client.inspect(customer, subscription, 'Sub', signal())
    const result = await client.remove(customer, plan, async () => {}, signal())
    expect(result.state).toBe('unknown')
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(1)
  })

  it('rejects unsafe pagination and refuses to use the Reader identity as the deleter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({
      value: [assignment()], nextLink: 'https://untrusted.example/subscriptions',
    }))
    await expect(new ArmDelegationRemovalClient(identity, { credential, fetcher }).inspect(customer, subscription, 'Sub', signal())).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(() => new ArmDelegationRemovalClient({ ...identity, principalId: identity.collectorPrincipalId }, { credential, fetcher })).toThrow(/共用/)
  })
})
