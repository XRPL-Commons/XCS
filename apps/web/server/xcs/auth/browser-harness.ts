import { startOidcProvider } from '../../../test/helpers/oidcProvider'
import { MemoryAuthRepository } from '../../../test/helpers/memoryAuth'
import { OidcProvider } from './oidc'
import { createAuthHandler } from './http'

/** Loaded only by the guarded development branch in xcs-auth; never a production provider. */
export async function createBrowserAuthHarness(value: string) {
  if (
    !import.meta.dev ||
    process.env.XCS_BROWSER_E2E !== '1' ||
    process.env.XCS_AUTH_BROWSER_E2E !== '1'
  ) {
    throw new Error('AUTH_BROWSER_E2E_FORBIDDEN')
  }
  const origin = new URL(value)
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('AUTH_BROWSER_E2E_ORIGIN_INVALID')
  const stub = await startOidcProvider({
    claims: {
      sub: 'xcs-browser-user',
      email: 'recipient@example.test',
      email_verified: true,
      name: 'Test recipient',
    },
  })
  const provider = new OidcProvider({
    issuerUrl: stub.issuer,
    clientId: stub.clientId,
    clientSecret: stub.clientSecret,
    redirectUri: `${origin.origin}/api/auth/callback`,
    allowLoopbackHttp: true,
  })
  return {
    handler: createAuthHandler({
      repository: new MemoryAuthRepository(),
      provider,
      origin: origin.origin,
      idleSeconds: 1800,
      absoluteSeconds: 28800,
    }),
    close: stub.close,
  }
}
