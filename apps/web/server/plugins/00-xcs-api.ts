import { createDatabaseClient } from '@xcs-protocol/db'

import { loadApiConfig } from '../xcs/config'
import type { XcsApiContext } from '../xcs/context'
import { fixtureGet, fixtureNotFound, fixtureVerify } from '../xcs/e2e-fixtures'
import { createApiHandlers, createSchemaValidator } from '../xcs/handlers'
import type { ApiHandlers, ApiReply, ApiRequest, RouteDefinition } from '../xcs/http'
import { KuboPinStore } from '../xcs/kubo'
import { IndexerUnavailableError } from '../xcs/ledger-freshness'
import { PostgresOperationalMetricsRepository } from '../xcs/operational-metrics-repository'
import { DisabledPayloadResolver, SafePayloadResolver } from '../xcs/payload-resolver'
import { DemoPinningService } from '../xcs/pinning'
import { PostgresPinningRepository } from '../xcs/pinning-repository'
import { PostgresApiRepository } from '../xcs/repository'
import type { ApiRepository } from '../xcs/types'
import { StaticTrustPolicy } from '../xcs/verification'

/**
 * A repository that opens no connection. The browser end-to-end context builds
 * the real route table only to reuse its paths, schemas and rate limits; every
 * `/v1` route answers from the fixtures instead, and the non-`/v1` routes that
 * do reach the repository (`/health/ready`) report an unavailable indexer.
 */
const unavailableRepository = new Proxy({} as ApiRepository, {
  get(_target, property) {
    if (property === 'then') return undefined
    return () =>
      Promise.reject(
        new IndexerUnavailableError('INDEXER_STATUS_UNAVAILABLE', 'Indexer status unavailable'),
      )
  },
})

/**
 * Serves the deterministic browser end-to-end fixtures through the real route
 * table: same paths, methods, schemas, rate limits and cache headers, with the
 * `/v1` handlers replaced by the canned data. No database client is created.
 */
function createBrowserE2eContext(): XcsApiContext {
  const config = loadApiConfig({
    ...process.env,
    // The fixtures never reach a database; the value only satisfies the
    // configuration contract so the rest of it is loaded the usual way.
    XCS_DATABASE_URL: process.env.XCS_DATABASE_URL ?? 'postgres://127.0.0.1:1/xcs-browser-e2e',
    XCS_DEMO_PINNING_ENABLED: 'false',
    XCS_METRICS_ENABLED: 'false',
  })
  const real = createApiHandlers({
    repository: unavailableRepository,
    resolver: new DisabledPayloadResolver(),
    trustPolicy: new StaticTrustPolicy({ trusted: [], untrusted: [] }),
    allowedOrigins: config.allowedOrigins,
    readinessMaxLedgerAgeSeconds: config.readinessMaxLedgerAgeSeconds,
  })
  const routes: RouteDefinition[] = real.routes.map((route) => {
    if (!route.path.startsWith('/v1/') && route.path !== '/v1') return route
    const validate = createSchemaValidator(route.schema)
    const cacheControlHeaders: Record<string, string> =
      route.cacheControl === undefined ? {} : { 'cache-control': route.cacheControl }
    const withHeaders = (reply: ApiReply): ApiReply => ({
      ...reply,
      headers: { ...cacheControlHeaders, ...reply.headers },
    })
    return {
      ...route,
      handle: async (request: ApiRequest): Promise<ApiReply> => {
        const failure = validate(request)
        if (failure !== undefined) return withHeaders(failure)
        const reply =
          route.method === 'POST' && route.path === '/v1/verify'
            ? fixtureVerify(request.body)
            : fixtureGet(route.path, request.params)
        return withHeaders(reply ?? fixtureNotFound())
      },
    }
  })
  const handlers: ApiHandlers = {
    routes,
    recordRateLimited(): void {},
    async close(): Promise<void> {},
  }

  return {
    config,
    handlers,
    trustedProxyCidrs: config.trustedProxyCidrs,
    async close(): Promise<void> {},
  }
}

function createProductionContext(): XcsApiContext {
  const config = loadApiConfig(process.env)
  const database = createDatabaseClient(config.databaseUrl)
  const repository = new PostgresApiRepository(database.db)
  const pinningService = config.demoPinning.enabled
    ? new DemoPinningService({
        repository: new PostgresPinningRepository(database.db),
        apiRepository: repository,
        store: new KuboPinStore(config.demoPinning.kuboRpcUrl),
        ipHashSecret: config.demoPinning.ipHashSecret,
        enabledNetworks: new Set(config.demoPinning.networks),
        maxLedgerAgeSeconds: config.readinessMaxLedgerAgeSeconds,
      })
    : undefined
  const handlers = createApiHandlers({
    repository,
    resolver: config.payloadFetchEnabled
      ? new SafePayloadResolver(config.ipfsGateway)
      : new DisabledPayloadResolver(),
    trustPolicy: new StaticTrustPolicy({
      trusted: config.trustedIssuers,
      untrusted: config.untrustedIssuers,
    }),
    allowedOrigins: config.allowedOrigins,
    readinessMaxLedgerAgeSeconds: config.readinessMaxLedgerAgeSeconds,
    ...(config.operationalMetrics.enabled
      ? {
          operationalMetrics: {
            token: config.operationalMetrics.token,
            repository: new PostgresOperationalMetricsRepository(database.db),
            observePayloadResolver: config.payloadFetchEnabled,
          },
        }
      : {}),
    ...(pinningService === undefined ? {} : { pinningService }),
  })
  const janitor =
    pinningService === undefined
      ? undefined
      : setInterval(
          () => {
            void pinningService.unpinExpired().catch((error: unknown) => {
              console.error('demo pin cleanup failed', String(error))
            })
          },
          60 * 60 * 1_000,
        )
  janitor?.unref()

  return {
    config,
    handlers,
    trustedProxyCidrs: config.trustedProxyCidrs,
    async close(): Promise<void> {
      if (janitor !== undefined) clearInterval(janitor)
      await handlers.close()
      await database.close()
    },
  }
}

export default defineNitroPlugin((nitro) => {
  const runtime = useRuntimeConfig()
  const context =
    runtime.browserE2eMode === 'enabled' && import.meta.dev
      ? createBrowserE2eContext()
      : createProductionContext()
  nitro.hooks.hook('request', (event) => {
    event.context.xcs = context
  })
  nitro.hooks.hook('close', async () => {
    await context.close()
  })
})
