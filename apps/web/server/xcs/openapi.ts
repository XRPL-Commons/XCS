import { xcsFieldDescriptorSchema } from './http-schemas'
import type { RouteDefinition } from './http'

/**
 * The shared schemas the handler table references by `$id` (the way the
 * framework's `addSchema` registered them). They are emitted under
 * `components.schemas` and every `Name#` reference is rewritten to point at
 * them, so the document is self-contained.
 */
const SHARED_SCHEMAS: Record<string, object> = {
  XcsFieldDescriptor: xcsFieldDescriptorSchema,
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface ObjectSchema {
  type?: string
  properties?: Record<string, object>
  required?: string[]
}

/** Converts a framework-style path (`/v1/networks/:network`) to OpenAPI form. */
export function toOpenApiPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/')
}

/**
 * Rewrites `$ref: 'Name#'` (and `Name#/…`) into a local
 * `#/components/schemas/Name` pointer and drops the `$id` keyword, which has no
 * meaning once the schema lives inside `components`.
 */
function localize(value: unknown, used: Set<string>): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => localize(entry, used))
  if (value === null || typeof value !== 'object') return value as JsonValue
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$id') continue
    if (key === '$ref' && typeof entry === 'string') {
      const match = /^([^#/][^#]*)#/u.exec(entry)
      if (match?.[1] !== undefined) {
        used.add(match[1])
        result.$ref = `#/components/schemas/${match[1]}`
        continue
      }
    }
    result[key] = localize(entry, used)
  }
  return result
}

function parametersFrom(
  schema: object | undefined,
  location: 'path' | 'query',
  used: Set<string>,
): JsonValue[] {
  const object = schema as ObjectSchema | undefined
  const properties = object?.properties
  if (properties === undefined) return []
  const required = new Set(object?.required ?? [])
  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    // A path parameter is always required, whatever the schema says.
    required: location === 'path' ? true : required.has(name),
    schema: localize(propertySchema, used),
  }))
}

/**
 * Builds the OpenAPI 3.1 document from the handler table's own route metadata:
 * the same JSON schemas the routes validate against. Routes marked
 * `schema.hide` (the internal metrics routes) are left out, exactly as the
 * framework's swagger plugin left them out.
 */
export function buildOpenApiDocument(
  routes: RouteDefinition[],
  version: string,
): Record<string, JsonValue> {
  const used = new Set<string>()
  const paths: Record<string, Record<string, JsonValue>> = {}
  for (const route of routes) {
    if (route.schema?.hide === true) continue
    const path = toOpenApiPath(route.path)
    const operation: Record<string, JsonValue> = {}
    const parameters = [
      ...parametersFrom(route.schema?.params, 'path', used),
      ...parametersFrom(route.schema?.querystring, 'query', used),
    ]
    if (parameters.length > 0) operation.parameters = parameters
    if (route.schema?.body !== undefined) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: localize(route.schema.body, used) } },
      }
    }
    const responses: Record<string, JsonValue> = {}
    for (const [status, responseSchema] of Object.entries(route.schema?.response ?? {})) {
      responses[status] = {
        description: `${status} response`,
        content: { 'application/json': { schema: localize(responseSchema, used) } },
      }
    }
    // A route with no declared response schema still answers; describe the
    // default success so the operation is a valid OpenAPI object.
    operation.responses =
      Object.keys(responses).length > 0 ? responses : { '200': { description: '200 response' } }
    const entry = paths[path] ?? {}
    entry[route.method.toLowerCase()] = operation
    paths[path] = entry
  }

  const schemas: Record<string, JsonValue> = {}
  for (const name of [...used].sort()) {
    const shared = SHARED_SCHEMAS[name]
    if (shared !== undefined) schemas[name] = localize(shared, used)
  }

  return {
    openapi: '3.1.0',
    info: { title: 'XCS reference read API', version },
    paths: paths as unknown as JsonValue,
    ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
  }
}

/** Method, path and summary of every documented route, for the HTML index. */
export function documentedRoutes(
  routes: RouteDefinition[],
): { method: string; path: string; summary: string }[] {
  return routes
    .filter((route) => route.schema?.hide !== true)
    .map((route) => ({
      method: route.method,
      path: toOpenApiPath(route.path),
      summary: (route.schema as { summary?: string } | undefined)?.summary ?? '',
    }))
}
