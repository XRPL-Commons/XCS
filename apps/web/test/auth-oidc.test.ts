import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OidcProvider } from '../server/xcs/auth/oidc'
import { startOidcProvider, type TestOidcOptions } from './helpers/oidcProvider'

const providers: Awaited<ReturnType<typeof startOidcProvider>>[] = []
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()))
  vi.unstubAllEnvs()
})

async function fixture(options: TestOidcOptions = {}) {
  const server = await startOidcProvider(options)
  providers.push(server)
  const settings = {
    issuerUrl: server.issuer,
    clientId: server.clientId,
    clientSecret: server.clientSecret,
    redirectUri: 'http://127.0.0.1:3000/auth/callback',
    allowLoopbackHttp: true,
  }
  const provider = new OidcProvider(settings)
  const input = {
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
  }
  return {
    server,
    settings,
    provider,
    input,
    async callback() {
      return server.authorize(await provider.authorizationUrl(input))
    },
  }
}

describe('OIDC identity boundary', () => {
  it('discovers, exchanges a PKCE code with basic authentication and verifies its JWKS signature', async () => {
    const { server, provider, input, callback } = await fixture({
      claims: { roles: ['admin'], role: 'admin' },
    })
    const identity = await provider
      .exchange({ ...input, callbackUrl: await callback() })
      .catch((error: unknown) => {
        if (server.rejections.length) throw new Error(server.rejections.join(','))
        throw error
      })
    expect(identity).toEqual({
      issuer: server.issuer,
      subject: 'fictional-subject',
      email: 'learner@example.invalid',
      emailVerified: true,
      displayName: 'Example Learner',
    })
    expect(server.requests).toEqual({ discovery: 1, authorization: 1, token: 1, jwks: 1 })
  })

  it('requests only identity scopes and binds state, nonce, redirect URI and S256', async () => {
    const { provider, input, settings } = await fixture()
    const url = new URL(await provider.authorizationUrl(input))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      scope: 'openid profile email',
      state: input.state,
      nonce: input.nonce,
      redirect_uri: settings.redirectUri,
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('client_secret')).toBe(false)
    expect(url.searchParams.has('code_verifier')).toBe(false)
  })

  it.each([
    ['nonce', { claims: { nonce: 'different-nonce' } }],
    ['missing nonce', { claims: { nonce: undefined } }],
    ['audience', { claims: { aud: 'different-client' } }],
    ['issuer', { claims: { iss: 'https://untrusted.example.invalid' } }],
    ['expired token', { claims: { exp: 1 } }],
    ['invalid signature', { badSignature: true }],
    ['missing ID token', { missingIdToken: true }],
    ['empty subject', { claims: { sub: '' } }],
    ['oversized subject', { claims: { sub: 'a'.repeat(2049) } }],
    ['oversized email', { claims: { email: 'a'.repeat(321) } }],
    ['oversized display name', { claims: { name: 'a'.repeat(513) } }],
  ] satisfies [string, TestOidcOptions][])('rejects %s', async (_label, options) => {
    const { provider, input, callback, server } = await fixture(options)
    await expect(provider.exchange({ ...input, callbackUrl: await callback() })).rejects.toThrow()
    expect(server.requests.token).toBe(1)
    expect(server.rejections).toEqual([])
    if (options.badSignature) expect(server.requests.jwks).toBe(1)
  })

  it('rejects wrong state before sending the authorization code', async () => {
    const { provider, input, callback, server } = await fixture()
    const callbackUrl = await callback()
    callbackUrl.searchParams.set('state', 'wrong-state')
    await expect(provider.exchange({ ...input, callbackUrl })).rejects.toThrow()
    expect(server.requests.token).toBe(0)
  })

  it('rejects a verifier that does not match the authorization challenge', async () => {
    const { provider, input, callback } = await fixture()
    await expect(
      provider.exchange({ ...input, codeVerifier: 'x'.repeat(43), callbackUrl: await callback() }),
    ).rejects.toThrow()
  })

  it('rejects a replayed authorization code', async () => {
    const { provider, input, callback } = await fixture()
    const callbackUrl = await callback()
    await provider.exchange({ ...input, callbackUrl })
    await expect(provider.exchange({ ...input, callbackUrl })).rejects.toThrow()
  })

  it.each([false, 'true', undefined])(
    'does not infer email verification from %s',
    async (emailVerified) => {
      const { provider, input, callback } = await fixture({
        claims: { email_verified: emailVerified },
      })
      expect(
        (await provider.exchange({ ...input, callbackUrl: await callback() })).emailVerified,
      ).toBe(false)
    },
  )

  it('rejects callback URL substitution before sending the code', async () => {
    const { provider, input, callback, server } = await fixture()
    const callbackUrl = await callback()
    callbackUrl.pathname = '/another-callback'
    await expect(provider.exchange({ ...input, callbackUrl })).rejects.toThrow(
      'OIDC_CALLBACK_MISMATCH',
    )
    expect(server.requests.token).toBe(0)
  })

  it('rejects non-loopback HTTP metadata even with the test exception', async () => {
    const { provider, input } = await fixture({
      metadata: { token_endpoint: 'http://example.invalid/token' },
    })
    await expect(provider.authorizationUrl(input)).rejects.toThrow('OIDC_URL_INVALID')
  })

  it('rejects discovery metadata that names another issuer', async () => {
    const { provider, input } = await fixture({
      metadata: { issuer: 'https://other.example.invalid' },
    })
    await expect(provider.authorizationUrl(input)).rejects.toThrow()
  })

  it('rejects an empty authorization context before discovery', async () => {
    const { provider, input, server } = await fixture()
    await expect(provider.authorizationUrl({ ...input, nonce: '' })).rejects.toThrow(
      'OIDC_AUTHORIZATION_CONTEXT_INVALID',
    )
    expect(server.requests.discovery).toBe(0)
  })

  it('requires explicit local HTTP opt-in and prohibits it in production', async () => {
    const { settings } = await fixture()
    expect(() => new OidcProvider({ ...settings, allowLoopbackHttp: false })).toThrow(
      'OIDC_URL_INVALID',
    )
    expect(() => new OidcProvider({ ...settings, issuerUrl: 'http://example.invalid' })).toThrow(
      'OIDC_URL_INVALID',
    )
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => new OidcProvider(settings)).toThrow('OIDC_HTTP_TEST_ONLY')
  })

  it('rejects a discovery-document URL instead of an issuer identifier', async () => {
    const { settings } = await fixture()
    expect(
      () =>
        new OidcProvider({
          ...settings,
          issuerUrl: `${settings.issuerUrl}/.well-known/openid-configuration`,
        }),
    ).toThrow('OIDC_SETTINGS_INVALID')
  })
})
