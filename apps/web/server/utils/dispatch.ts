import type { H3Event } from 'h3'

import { assertDeclaredLength, BodyTooLargeError, readBoundedBody } from '../xcs/body-limit'
import type { XcsApiContext } from '../xcs/context'
import { mapError } from '../xcs/handlers'
import type { ApiReply, ApiRequest, HttpMethod, RouteDefinition } from '../xcs/http'
import { resolveClientAddress } from './clientAddress'
import { isInProcessRequest } from './inProcessRequest'

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
  assertDeclaredLength(getRequestHeader(event, 'content-length'), limit)
  // An in-process request carries its body in memory rather than on a stream,
  // so there is nothing to abort early; h3 reads it and the size is checked once.
  const raw = isInProcessRequest(event)
    ? await bufferedBody(event, limit)
    : await readBoundedBody(event.node.req, limit)
  if (raw === undefined || raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new BodyParseError(error instanceof Error ? error.message : 'Invalid JSON')
  }
}

async function bufferedBody(event: H3Event, limit: number): Promise<string | undefined> {
  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined) return undefined
  if (Buffer.byteLength(raw, 'utf8') > limit) throw new BodyTooLargeError()
  return raw
}

function applyReply(event: H3Event, reply: ApiReply): unknown {
  for (const [name, value] of Object.entries(reply.headers)) setResponseHeader(event, name, value)
  setResponseStatus(event, reply.statusCode)
  return reply.body
}

/**
 * The JSON 404 envelope every API prefix answers with. The read API owns its
 * prefixes end to end, so a path under one of them that no route covers never
 * falls through to the framework's HTML error document.
 */
export function apiRouteNotFound(event: H3Event): unknown {
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseStatus(event, 404)
  return {
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${event.method}:${event.path} not found`,
  }
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
    return apiRouteNotFound(event)
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
    if (error instanceof BodyTooLargeError) {
      // The rest of the upload is never read. Cutting the request only once the
      // response has flushed is what lets the client see the 413 rather than a
      // reset connection.
      const request = event.node?.req
      event.node?.res?.once('finish', () => {
        request?.destroy?.()
      })
    }
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
