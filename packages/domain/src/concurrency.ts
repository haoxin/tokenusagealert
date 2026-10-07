export type TaskResult<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<TaskResult<R>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.')
  const results = new Array<TaskResult<R>>(items.length)
  let next = 0
  // Create workers, not one pending Promise per tenant/subscription.
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      if (signal?.aborted) {
        results[index] = { status: 'rejected', reason: signal.reason }
        continue
      }
      try { results[index] = { status: 'fulfilled', value: await work(items[index]!, index) } }
      catch (reason) { results[index] = { status: 'rejected', reason } }
    }
  }))
  return results
}

interface Waiter { start: () => void; cancel: () => void }

export class RequestLimiter {
  private active = 0
  private readonly queue: Waiter[] = []
  peak = 0
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Request limit must be positive.')
  }

  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      const waiter: Waiter = {
        start: () => {
          signal.removeEventListener('abort', waiter.cancel)
          this.active += 1
          this.peak = Math.max(this.peak, this.active)
          resolve()
        },
        cancel: () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          reject(signal.reason)
        },
      }
      if (this.active < this.limit) waiter.start()
      else { this.queue.push(waiter); signal.addEventListener('abort', waiter.cancel, { once: true }) }
    })
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      this.active -= 1
      this.queue.shift()?.start()
    }
  }
}

export function tenantShard(tenantId: string, shardCount: number): number {
  let hash = 2166136261
  for (const character of tenantId.toLowerCase()) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) % shardCount
}
