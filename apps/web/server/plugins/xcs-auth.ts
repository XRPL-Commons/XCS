import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { createDatabaseClient } from '../lib/db/index.js'
import { loadAuthConfig } from '../xcs/auth/config'
import {
  createAuthHandler,
  readAuthSession,
  requireAuthSession,
  requireAuthRole,
  requireCsrf,
} from '../xcs/auth/http'
import { OidcProvider } from '../xcs/auth/oidc'
import { PostgresAuthRepository } from '../xcs/auth/repository'
import type { H3Event } from 'h3'
import type { Session } from '../xcs/auth/types'

declare module 'h3' {
  interface H3EventContext {
    xcsRequireAdmin?: (event: H3Event, mutation: boolean) => Promise<Session>
    xcsRequireSession?: (event: H3Event, mutation: boolean) => Promise<Session>
    xcsReadSession?: (event: H3Event) => Promise<Session | null>
  }
}

export default defineNitroPlugin(async (nitroApp) => {
  if (!import.meta.dev && process.env.XCS_AUTH_BROWSER_E2E === '1')
    throw new Error('AUTH_BROWSER_E2E_FORBIDDEN')
  const runtime = useRuntimeConfig()
  if (
    import.meta.dev &&
    runtime.browserE2eMode === 'enabled' &&
    process.env.XCS_AUTH_BROWSER_E2E === '1'
  ) {
    const { createBrowserAuthHarness } = await import('../xcs/auth/browser-harness')
    const harness = await createBrowserAuthHarness(process.env.XCS_AUTH_TEST_ORIGIN ?? '')
    nitroApp.hooks.hook('request', (event) => {
      event.context.xcsAuth = harness.handler
    })
    nitroApp.hooks.hook('close', harness.close)
    return
  }
  const config = loadAuthConfig(process.env)
  if (!config) return
  const database = createDatabaseClient(config.databaseUrl, { onNotice: () => undefined })
  const repository = new PostgresAuthRepository(database)
  const provider = new OidcProvider({
    ...config,
    redirectUri: `${config.origin}/api/auth/callback`,
  })
  const handler = createAuthHandler({ ...config, repository, provider })
  nitroApp.hooks.hook('request', (event) => {
    event.context.xcsAuth = handler
    event.context.xcsReadSession = (request) => readAuthSession(request, repository)
    event.context.xcsRequireSession = async (request, mutation) => {
      const session = await requireAuthSession(request, repository)
      if (mutation) requireCsrf(request, session, config.origin)
      return session
    }
    event.context.xcsRequireAdmin = async (request, mutation) => {
      const session = await requireAuthRole(request, repository, 'admin')
      if (mutation) requireCsrf(request, session, config.origin)
      return session
    }
  })
  nitroApp.hooks.hook('close', database.close)
})
