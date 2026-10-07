import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapConcurrent, RequestLimiter, tenantShard } from './concurrency.js'

describe('bounded hierarchical scheduling', () => {
  it('runs only the configured worker count and isolates one failed item', async () => {
    let active = 0
    let peak = 0
    let completed = 0
    const results = await mapConcurrent(Array.from({ length: 200 }, (_, i) => i), 8, async (i) => {
      active += 1; peak = Math.max(peak, active)
      try {
        await delay(1)
        if (i === 50) throw new Error('one tenant failed')
        completed += 1
        return i
      } finally { active -= 1 }
    })
    expect(peak).toBe(8)
    expect(completed).toBe(199)
    expect(results[50]?.status).toBe('rejected')
    expect(results[199]).toEqual({ status: 'fulfilled', value: 199 })
  })

  it('does not launch queued work after cancellation', async () => {
    const controller = new AbortController()
    let calls = 0
    const results = await mapConcurrent([1, 2, 3, 4, 5], 1, async () => {
      calls += 1
      controller.abort(new Error('deadline'))
      return true
    }, controller.signal)
    expect(calls).toBe(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(4)
  })

  it('shares one HTTP cap across nested tenant/subscription workers', async () => {
    const limiter = new RequestLimiter(5)
    let active = 0
    let peak = 0
    await mapConcurrent([1, 2, 3, 4], 4, async () => mapConcurrent(Array.from({ length: 20 }), 8, async () =>
      limiter.run(async () => {
        active += 1; peak = Math.max(peak, active)
        await delay(1)
        active -= 1
      }, AbortSignal.timeout(5000)),
    ))
    expect(peak).toBe(5)
    expect(limiter.peak).toBe(5)
  })

  it('distributes each tenant to exactly one stable shard', () => {
    for (const count of [1, 2, 4, 8, 16]) {
      const owners = Array.from({ length: 500 }, (_, i) => tenantShard(`tenant-${i}`, count))
      expect(owners.every((owner) => owner >= 0 && owner < count)).toBe(true)
      expect(new Set(owners).size).toBe(count)
      expect(tenantShard('TENANT-A', count)).toBe(tenantShard('tenant-a', count))
    }
  })
})
