import { createDatabaseClient } from '@xcs-protocol/db'

import { loadApiConfig } from '../xcs/config'
import type { XcsApiContext } from '../xcs/context'
import { createApiHandlers } from '../xcs/handlers'
import { KuboPinStore } from '../xcs/kubo'
import { PostgresOperationalMetricsRepository } from '../xcs/operational-metrics-repository'
import { DisabledPayloadResolver, SafePayloadResolver } from '../xcs/payload-resolver'
import { DemoPinningService } from '../xcs/pinning'
import { PostgresPinningRepository } from '../xcs/pinning-repository'
import { PostgresApiRepository } from '../xcs/repository'
import { StaticTrustPolicy } from '../xcs/verification'

/**
 * The browser end-to-end fixtures land in the next task. Until then the branch
 * fails loudly instead of silently falling back to a real database.
 */
function createBrowserE2eContext(): XcsApiContext {
  throw new Error('BROWSER_E2E_FIXTURES_UNAVAILABLE')
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
