import type { ApiHandlers, HttpMethod, RouteDefinition } from '../../server/xcs/http.js'

export interface InjectOptions {
  method: HttpMethod
  url: string
  payload?: unknown
  headers?: Record<string, string>
  ip?: string
}

export interface InjectResponse {
  statusCode: number
  headers: Record<string, string>
  json: () => never
  body: string
}

function lowerCase(headers: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
}

/** A minimal `:param` path matcher; no dependency, no wildcards. */
function matchPath(routePath: string, pathname: string): Record<string, string> | undefined {
  const routeSegments = routePath.split('/')
  const requestSegments = pathname.split('/')
  if (routeSegments.length !== requestSegments.length) return undefined
  const params: Record<string, string> = {}
  for (const [index, routeSegment] of routeSegments.entries()) {
    const requestSegment = requestSegments[index]!
    if (routeSegment.startsWith(':')) {
      if (requestSegment === '') return undefined
      params[routeSegment.slice(1)] = decodeURIComponent(requestSegment)
      continue
    }
    if (routeSegment !== requestSegment) return undefined
  }
  return params
}

export function createInjector(handlers: ApiHandlers) {
  return async function inject(options: InjectOptions): Promise<InjectResponse> {
    const [pathname = '', search = ''] = options.url.split('?')
    const query = Object.fromEntries(new URLSearchParams(search))
    for (const route of handlers.routes as RouteDefinition[]) {
      if (route.method !== options.method) continue
      const params = matchPath(route.path, pathname)
      if (params === undefined) continue
      const reply = await route.handle({
        params,
        query,
        body: options.payload,
        headers: lowerCase(options.headers ?? {}),
        ip: options.ip ?? '127.0.0.1',
      })
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
      return {
        statusCode: reply.statusCode,
        headers: reply.headers,
        json: () => JSON.parse(body) as never,
        body,
      }
    }
    const notFound = JSON.stringify({
      error: 'NOT_FOUND',
      message: 'Route not found',
    })
    return {
      statusCode: 404,
      headers: {},
      json: () => JSON.parse(notFound) as never,
      body: notFound,
    }
  }
}
