import type { H3Event } from 'h3'

import type { XcsApiContext } from '../xcs/context'
import { mapError } from '../xcs/handlers'
import type { ApiReply, ApiRequest, HttpMethod, RouteDefinition } from '../xcs/http'
import { resolveClientAddress } from './clientAddress'

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024

class BodyParseError extends Error {}

export function requestClientAddress(event: H3Event, trustedProxyCidrs: string[]): string {
  return resolveClientAddress(
    getRequestIP(event),
    getRequestHeader(event, 'x-forwarded-for'),
    trustedProxyCidrs,
  )
}

function singleValueHeaders(event: H3Event): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(getRequestHeaders(event)).map(([name, value]) => [
      name,
      Array.isArray(value) ? value[0] : value,
    ]),
  )
}

async function readJsonBody(event: H3Event, limit: number): Promise<unknown> {
  const declaredLength = Number(getRequestHeader(event, 'content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw Object.assign(new Error('Request body is too large'), { statusCode: 413 })
  }
  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined || raw.length === 0) return undefined
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    throw Object.assign(new Error('Request body is too large'), { statusCode: 413 })
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new BodyParseError(error instanceof Error ? error.message : 'Invalid JSON')
  }
}

function applyReply(event: H3Event, reply: ApiReply): unknown {
  for (const [name, value] of Object.entries(reply.headers)) setResponseHeader(event, name, value)
  setResponseStatus(event, reply.statusCode)
  return reply.body
}

/**
 * Bridges one Nitro route to its entry in the framework-free handler table. The
 * adapters carry the table's own path so a route is matched by identity rather
 * than by re-deriving it from the URL.
 */
export async function dispatch(event: H3Event, method: HttpMethod, path: string): Promise<unknown> {
  const { handlers, trustedProxyCidrs } = event.context.xcs as XcsApiContext
  const route: RouteDefinition | undefined = handlers.routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (route === undefined) {
    // A route the handler table did not register (demo pinning, operational
    // metrics) is absent, exactly as it was before it had an adapter file.
    setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
    setResponseStatus(event, 404)
    return {
      statusCode: 404,
      error: 'Not Found',
      message: `Route ${method}:${event.path} not found`,
    }
  }

  const cacheControlHeaders: Record<string, string> =
    route.cacheControl === undefined ? {} : { 'cache-control': route.cacheControl }
  try {
    const body =
      method === 'POST'
        ? await readJsonBody(event, route.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES)
        : undefined
    const request: ApiRequest = {
      params: getRouterParams(event, { decode: true }) as Record<string, string>,
      query: getQuery(event) as ApiRequest['query'],
      body,
      headers: singleValueHeaders(event),
      ip: requestClientAddress(event, trustedProxyCidrs),
    }
    return applyReply(event, await route.handle(request))
  } catch (error) {
    if (error instanceof BodyParseError) {
      return applyReply(event, {
        statusCode: 400,
        headers: cacheControlHeaders,
        body: { error: 'VALIDATION_ERROR', message: error.message },
      })
    }
    const mapped = mapError(error)
    return applyReply(event, {
      statusCode: mapped.statusCode,
      headers: { ...cacheControlHeaders, ...mapped.headers },
      body: mapped.body,
    })
  }
}
