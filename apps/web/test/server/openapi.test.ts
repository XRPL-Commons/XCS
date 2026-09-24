import { describe, expect, it } from 'vitest'

import { createApiHandlers } from '../../server/xcs/handlers.js'
import type { ApiHandlers, RouteDefinition } from '../../server/xcs/http.js'
import type {
  OperationalMetricsRepository,
  OperationalMetricsSnapshot,
} from '../../server/xcs/operational-metrics.js'
import type { DemoPinningService } from '../../server/xcs/pinning.js'
import type { ApiRepository } from '../../server/xcs/types.js'
import { StaticTrustPolicy } from '../../server/xcs/verification.js'
import { buildOpenApiDocument, toOpenApiPath } from '../../server/xcs/openapi.js'

const METRICS_TOKEN = 'operational-metrics-token-0123456789'

/** No route is ever called here; only the route table's metadata is read. */
const repository = new Proxy({} as ApiRepository, {
  get: () => () => Promise.reject(new Error('not called')),
})

const metricsRepository: OperationalMetricsRepository = {
  snapshot: async () => ({}) as unknown as OperationalMetricsSnapshot,
}

async function handlers(): Promise<ApiHandlers> {
  return createApiHandlers({
    repository,
    resolver: { resolve: async () => new Uint8Array() },
    trustPolicy: new StaticTrustPolicy(),
    pinningService: {} as unknown as DemoPinningService,
    operationalMetrics: { token: METRICS_TOKEN, repository: metricsRepository },
  })
}

function operations(document: Record<string, unknown>): { path: string; method: string }[] {
  const paths = document.paths as Record<string, Record<string, unknown>>
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({ path, method })),
  )
}

describe('buildOpenApiDocument', () => {
  it('describes every non-hidden route and no internal route', async () => {
    const api = await handlers()
    const routes = api.routes as RouteDefinition[]
    const document = buildOpenApiDocument(routes, '9.9.9')
    const described = operations(document)

    const expected = routes.filter(
      (route) => route.schema?.hide !== true && route.path.startsWith('/v1/'),
    )
    expect(expected.length).toBeGreaterThan(0)
    for (const route of expected) {
      expect(described).toContainEqual({
        path: toOpenApiPath(route.path),
        method: route.method.toLowerCase(),
      })
    }

    const hidden = routes.filter((route) => route.schema?.hide === true)
    expect(hidden.length).toBeGreaterThan(0)
    expect(described.some((operation) => operation.path.startsWith('/internal'))).toBe(false)
    await api.close()
  })

  it('uses the OpenAPI path parameter form and declares each route response', async () => {
    const api = await handlers()
    const routes = api.routes as RouteDefinition[]
    const document = buildOpenApiDocument(routes, '9.9.9')
    const paths = document.paths as Record<string, Record<string, { responses: object }>>

    for (const path of Object.keys(paths)) {
      expect(path).not.toContain(':')
    }
    expect(Object.keys(paths)).toContain('/v1/networks/{network}/status')

    for (const route of routes) {
      if (route.schema?.hide === true) continue
      const operation = paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()]
      expect(operation).toBeDefined()
      const statuses = Object.keys(route.schema?.response ?? {})
      for (const status of statuses) {
        expect(Object.keys(operation!.responses)).toContain(status)
      }
    }
    await api.close()
  })

  it('is a self-contained JSON document with the expected top-level shape', async () => {
    const api = await handlers()
    const document = buildOpenApiDocument(api.routes as RouteDefinition[], '9.9.9')
    const serialized = JSON.stringify(document)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    expect(parsed.openapi).toBe('3.1.0')
    expect(parsed.info).toEqual({ title: 'XCS reference read API', version: '9.9.9' })
    expect(parsed.paths).toBeTypeOf('object')
    // Every `$ref` resolves inside this document: no `Name#` form survives.
    for (const reference of serialized.match(/"\$ref":"[^"]+"/gu) ?? []) {
      expect(reference).toContain('"#/components/schemas/')
    }
    expect(serialized).not.toContain('"$id"')
    await api.close()
  })
})
