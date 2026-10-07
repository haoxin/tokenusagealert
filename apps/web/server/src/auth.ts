import type { FastifyRequest } from 'fastify'
import type { Session } from '@tokenusagealert/schemas'
import type { AppConfig } from './config.js'

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Session
  }
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export function resolvePrincipal(
  request: FastifyRequest,
  config: AppConfig,
): Session | undefined {
  if (config.AUTH_MODE === 'development') {
    return {
      objectId: config.DEV_AUTH_OBJECT_ID!,
      name: config.DEV_AUTH_NAME!,
      authMode: 'development',
    }
  }

  const objectId = headerValue(request, 'x-ms-client-principal-id')
  const name = headerValue(request, 'x-ms-client-principal-name')
  if (!objectId || !name) return undefined

  return {
    objectId,
    name,
    authMode: 'easyauth',
  }
}
