import { Ajv, type ValidateFunction } from 'ajv'

import { xcsFieldDescriptorSchema } from '../../server/xcs/http-schemas.js'
import type { ApiHandlers, HttpMethod, RouteDefinition } from '../../server/xcs/http.js'

/**
 * The handler table declares a response schema per status code but, unlike the
 * framework it replaced, does not serialize through it. The injector validates
 * against it instead, so an undeclared or malformed response field fails a test
 * rather than leaking to a caller.
 */
const responseAjv = new Ajv({
  removeAdditional: false,
  coerceTypes: false,
  allErrors: false,
  strict: false,
  logger: false,
})
responseAjv.addSchema(xcsFieldDescriptorSchema)

const responseValidators = new WeakMap<object, ValidateFunction>()

function responseValidator(schema: object): ValidateFunction {
  const cached = responseValidators.get(schema)
  if (cached !== undefined) return cached
  const compiled = responseAjv.compile(schema)
  responseValidators.set(schema, compiled)
  return compiled
}

/**
 * The serialized body is what the schema describes, so the guard validates the
 * JSON round-trip rather than the in-memory value: a `Date` field declared as a
 * string reaches the caller as its ISO form, exactly as it did before.
 */
function assertDeclaredResponse(
  route: RouteDefinition,
  statusCode: number,
  serialized: string | undefined,
): void {
  const schema = route.schema?.response?.[statusCode]
  if (schema === undefined || serialized === undefined) return
  const body: unknown = JSON.parse(serialized)
  const validate = responseValidator(schema)
  if (validate(body)) return
  const error = validate.errors?.[0]
  throw new Error(
    `${route.method} ${route.path} responded ${statusCode} with a body its schema does not declare: ` +
      `${error === undefined ? 'unknown error' : `${error.instancePath || '/'} ${error.message ?? ''}`} ` +
      `(${JSON.stringify(body)?.slice(0, 400)})`,
  )
}

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
      assertDeclaredResponse(route, reply.statusCode, body)
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
