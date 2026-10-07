import { randomUUID } from 'node:crypto'
import type { ContainerClient } from '@azure/storage-blob'

export function storageErrorCode(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined
  const code: unknown = Reflect.get(error, 'code')
  if (typeof code === 'string') return code
  const details: unknown = Reflect.get(error, 'details')
  return details && typeof details === 'object' ? Reflect.get(details, 'errorCode') : undefined
}

export class StorageLeaseBusyError extends Error {
  constructor() { super('Another execution owns the storage lease.'); this.name = 'StorageLeaseBusyError' }
}

export async function withBlobLease<T>(container: ContainerClient, name: string, operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const lock = container.getBlockBlobClient(name)
  try {
    await lock.upload('', 0, { conditions: { ifNoneMatch: '*' }, abortSignal: signal })
  } catch (error) {
    if (!['BlobAlreadyExists', 'ConditionNotMet', 'LeaseIdMissing'].includes(String(storageErrorCode(error)))) throw error
  }
  const lease = lock.getBlobLeaseClient(randomUUID())
  try {
    await lease.acquireLease(60, { abortSignal: signal })
  } catch (error) {
    if (storageErrorCode(error) === 'LeaseAlreadyPresent') throw new StorageLeaseBusyError()
    throw error
  }
  const controller = new AbortController()
  const leaseSignal = AbortSignal.any([signal, controller.signal])
  let renewal = Promise.resolve()
  const heartbeat = setInterval(() => {
    renewal = renewal.then(async () => {
      if (controller.signal.aborted) return
      try { await lease.renewLease({ abortSignal: signal }) } catch (error) { controller.abort(error) }
    })
  }, 20_000)
  heartbeat.unref()
  try {
    const result = await operation(leaseSignal)
    leaseSignal.throwIfAborted()
    return result
  } finally {
    clearInterval(heartbeat)
    await renewal
    await lease.releaseLease()
  }
}
