import {
  ManualPriceListResponseSchema, ManualPriceMutationResponseSchema, ProblemDetailsSchema, type ManualPriceInput,
} from '@tokenusagealert/schemas'
import { ApiError } from './api'

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const result = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init,
    headers: { accept: 'application/json, application/problem+json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body: unknown = await result.json()
  if (!result.ok) {
    const problem = ProblemDetailsSchema.safeParse(body)
    if (problem.success) throw new ApiError(problem.data)
    throw new Error(`手动价格请求失败（HTTP ${result.status}）。`)
  }
  return body
}
export async function getManualPricing(signal?: AbortSignal) {
  return ManualPriceListResponseSchema.parse(await call('/api/v1/settings/manual-pricing', signal ? { signal } : {}))
}
export async function saveManualPrice(value: ManualPriceInput, etag: string | null, id: string | null) {
  return ManualPriceMutationResponseSchema.parse(await call(`/api/v1/settings/manual-pricing${id ? `/${id}` : ''}`, {
    method: id ? 'PATCH' : 'POST', body: JSON.stringify(value), headers: etag ? { 'if-match': etag } : { 'if-none-match': '*' },
  }))
}
export async function disableManualPrice(id: string, etag: string) {
  return ManualPriceMutationResponseSchema.parse(await call(`/api/v1/settings/manual-pricing/${id}/disable`, {
    method: 'POST', body: '{}', headers: { 'if-match': etag },
  }))
}
