import type { FastifyRequest } from 'fastify'

export function isStrongEntityTag(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^"[^"\r\n]+"$/.test(value)
}

export function isSameOriginJson(request: FastifyRequest): boolean {
  if (!request.headers['content-type']?.startsWith('application/json') || request.headers['sec-fetch-site'] === 'cross-site') return false
  if (!request.headers.origin) return true
  try {
    const origin = new URL(request.headers.origin)
    const host = request.headers['x-forwarded-host'] ?? request.headers.host
    return typeof host === 'string' && origin.host === new URL(`${origin.protocol}//${host}`).host
  } catch { return false }
}
