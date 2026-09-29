import { createApp, toNodeListener } from 'h3'
import inject from 'light-my-request'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveAddress, deriveKeypair, generateSeed, sign } from 'ripple-keypairs'
import { createAuthHandler, SESSION_COOKIE } from '../server/xcs/auth/http'
import { MemoryAuthRepository } from './helpers/memoryAuth'
import type { Identity } from '../server/xcs/auth/oidc'

const origin = 'https://xcs.example'
const identity: Identity = {
  issuer: 'https://identity.example',
  subject: 'person-1',
  email: 'person@example.com',
  emailVerified: false,
}
function cookie(response: inject.Response, name: string) {
  const values = response.headers['set-cookie']
  const value = (Array.isArray(values) ? values : [values]).find(
    (v) => typeof v === 'string' && v.startsWith(name + '='),
  )
  if (typeof value !== 'string') throw new Error('COOKIE_MISSING')
  return value.split(';')[0]!
}
function setup() {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const repository = new MemoryAuthRepository(() => now)
  const provider = {
    authorizationUrl: async (input: { state: string }) =>
      `https://identity.example/auth?state=${input.state}`,
    exchange: async () => ({ ...identity }),
  }
  const listener = toNodeListener(
    createApp().use(
      createAuthHandler({
        repository,
        provider,
        origin,
        idleSeconds: 1800,
        absoluteSeconds: 28800,
      }),
    ),
  )
  const request = (options: inject.InjectOptions) => inject(listener, options)
  const login = async () => {
    const start = await request({
      method: 'GET',
      url: '/api/auth/login?returnTo=https://evil.example',
    })
    const state = new URL(String(start.headers.location)).searchParams.get('state')!
    const loginCookie = cookie(start, '__Host-xcs-login')
    const callback = await request({
      method: 'GET',
      url: `/api/auth/callback?state=${state}&code=valid`,
      headers: { cookie: loginCookie },
    })
    const sessionCookie = cookie(callback, SESSION_COOKIE)
    const session = await request({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: sessionCookie },
    })
    return { start, callback, state, loginCookie, sessionCookie, session: session.json() }
  }
  return {
    repository,
    provider,
    request,
    login,
    advance: (ms: number) => {
      now += ms
    },
  }
}
afterEach(() => vi.restoreAllMocks())
let app: ReturnType<typeof setup>
beforeEach(() => {
  app = setup()
})

describe('XCS authentication HTTP boundary', () => {
  it('creates a recipient session with secure cookies, reload support and no provider/session tokens in JSON', async () => {
    const signed = await app.login()
    expect(signed.callback.statusCode).toBe(302)
    expect(signed.callback.headers.location).toBe('/account')
    expect(String(signed.callback.headers['set-cookie'])).toMatch(/HttpOnly/i)
    expect(String(signed.callback.headers['set-cookie'])).toMatch(/Secure/i)
    expect(String(signed.callback.headers['set-cookie'])).toMatch(/SameSite=Lax/i)
    expect(signed.session.user.roles).toEqual(['recipient'])
    expect(signed.session.user.organizations).toEqual([])
    expect(JSON.stringify(signed.session)).not.toContain(signed.sessionCookie.split('=')[1])
    const reload = await app.request({
      url: '/api/auth/session',
      headers: { cookie: signed.sessionCookie },
    })
    expect(reload.json().user.id).toBe(signed.session.user.id)
    expect(reload.headers['cache-control']).toBe('private, no-store')
  })
  it('does not grant issuer or admin access to a new account', async () => {
    const signed = await app.login()
    for (const role of ['issuer', 'verifier', 'admin']) {
      expect(
        (
          await app.request({
            url: `/api/auth/access?role=${role}`,
            headers: { cookie: signed.sessionCookie },
          })
        ).statusCode,
      ).toBe(403)
    }
    expect(
      (
        await app.request({
          url: '/api/auth/access?role=recipient',
          headers: { cookie: signed.sessionCookie },
        })
      ).statusCode,
    ).toBe(200)
    expect((await app.request({ url: '/api/auth/access?role=issuer' })).statusCode).toBe(401)
  })
  it('checks current roles and organization audience on every request', async () => {
    const signed = await app.login(),
      org = '11111111-1111-4111-8111-111111111111'
    const account = [...app.repository.accounts.values()][0]!
    account.organizations.push({ id: org, name: 'Organization', roles: ['issuer'] })
    expect(
      (
        await app.request({
          url: `/api/auth/access?role=issuer&organizationId=${org}`,
          headers: { cookie: signed.sessionCookie },
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await app.request({
          url: '/api/auth/access?role=issuer&organizationId=22222222-2222-4222-8222-222222222222',
          headers: { cookie: signed.sessionCookie },
        })
      ).statusCode,
    ).toBe(403)
    account.organizations[0]!.roles = []
    expect(
      (
        await app.request({
          url: '/api/auth/access?role=issuer',
          headers: { cookie: signed.sessionCookie },
        })
      ).statusCode,
    ).toBe(403)
  })
  it('rejects mismatched browser state and cannot replay a consumed callback', async () => {
    const signed = await app.login()
    const wrong = await app.request({
      url: `/api/auth/callback?state=${signed.state}&code=valid`,
      headers: { cookie: '__Host-xcs-login=' + 'x'.repeat(43) },
    })
    expect(wrong.headers.location).toBe('/auth/login?error=signin')
    const replay = await app.request({
      url: `/api/auth/callback?state=${signed.state}&code=valid`,
      headers: { cookie: signed.loginCookie },
    })
    expect(replay.headers.location).toBe('/auth/login?error=signin')
    expect(String(replay.headers['set-cookie'])).not.toContain(SESSION_COOKIE)
  })
  it('redacts provider error details and does not issue a session', async () => {
    app.provider.exchange = async () => {
      throw new Error('secret-provider-response')
    }
    const start = await app.request({ url: '/api/auth/login' })
    const state = new URL(String(start.headers.location)).searchParams.get('state')!
    const response = await app.request({
      url: `/api/auth/callback?state=${state}&code=valid`,
      headers: { cookie: cookie(start, '__Host-xcs-login') },
    })
    expect(response.headers.location).toBe('/auth/login?error=signin')
    expect(response.body).not.toContain('secret-provider-response')
    expect(app.repository.sessions.size).toBe(0)
  })
  it('rejects missing CSRF and cross-origin mutations', async () => {
    const signed = await app.login()
    for (const headers of [
      { cookie: signed.sessionCookie, origin },
      {
        cookie: signed.sessionCookie,
        origin: 'https://evil.example',
        'x-xcs-csrf': signed.session.csrfToken,
      },
    ]) {
      expect(
        (await app.request({ method: 'POST', url: '/api/auth/logout', headers })).statusCode,
      ).toBe(403)
    }
    expect(app.repository.sessions.size).toBe(1)
  })
  it('rotates a session and CSRF token without extending its absolute lifetime', async () => {
    const signed = await app.login()
    const response = await app.request({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: signed.sessionCookie, origin, 'x-xcs-csrf': signed.session.csrfToken },
    })
    expect(response.statusCode).toBe(200)
    expect(cookie(response, SESSION_COOKIE)).not.toBe(signed.sessionCookie)
    expect(response.json().csrfToken).not.toBe(signed.session.csrfToken)
    expect(response.json().absoluteExpiresAt).toBe(signed.session.absoluteExpiresAt)
    expect(
      (
        await app.request({ url: '/api/auth/session', headers: { cookie: signed.sessionCookie } })
      ).json().user,
    ).toBeNull()
  })
  it('logs out the current session and rejects its cookie immediately', async () => {
    const signed = await app.login()
    const response = await app.request({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: signed.sessionCookie, origin, 'x-xcs-csrf': signed.session.csrfToken },
    })
    expect(response.statusCode).toBe(200)
    expect(
      (
        await app.request({ url: '/api/auth/session', headers: { cookie: signed.sessionCookie } })
      ).json().user,
    ).toBeNull()
  })
  it('expires sessions and rejects suspended accounts', async () => {
    const first = await app.login()
    app.advance(1800001)
    expect(
      (
        await app.request({ url: '/api/auth/session', headers: { cookie: first.sessionCookie } })
      ).json().user,
    ).toBeNull()
    const second = await app.login()
    app.repository.suspended.add(second.session.user.id)
    expect(
      (
        await app.request({ url: '/api/auth/session', headers: { cookie: second.sessionCookie } })
      ).json().user,
    ).toBeNull()
  })
  it('links a signed current nonce once and supports unlink without a transaction', async () => {
    const signed = await app.login()
    const keys = deriveKeypair(generateSeed()),
      address = deriveAddress(keys.publicKey)
    const headers = {
      cookie: signed.sessionCookie,
      origin,
      'x-xcs-csrf': signed.session.csrfToken,
      'content-type': 'application/json',
    }
    const challenge = (
      await app.request({
        method: 'POST',
        url: '/api/auth/wallet/challenge',
        headers,
        payload: { address, networkId: 1 },
      })
    ).json()
    expect(challenge.message).toContain(`Origin: ${origin}`)
    const signature = sign(Buffer.from(challenge.message).toString('hex'), keys.privateKey)
    const proof = {
      challengeId: challenge.id,
      signature,
      publicKey: keys.publicKey,
      scheme: 'ripple',
    }
    const linked = await app.request({
      method: 'POST',
      url: '/api/auth/wallet/link',
      headers,
      payload: proof,
    })
    expect(linked.statusCode).toBe(200)
    expect(linked.json().user.wallets[0].address).toBe(address)
    expect(
      (await app.request({ method: 'POST', url: '/api/auth/wallet/link', headers, payload: proof }))
        .statusCode,
    ).toBe(400)
    const unlinked = await app.request({
      method: 'POST',
      url: '/api/auth/wallet/unlink',
      headers,
      payload: { walletId: linked.json().user.wallets[0].id },
    })
    expect(unlinked.json().user.wallets).toEqual([])
  })
  it('rejects an invalid signature, a different session and an expired nonce', async () => {
    const first = await app.login(),
      second = await app.login()
    const keys = deriveKeypair(generateSeed()),
      address = deriveAddress(keys.publicKey)
    const headers = {
      cookie: first.sessionCookie,
      origin,
      'x-xcs-csrf': first.session.csrfToken,
      'content-type': 'application/json',
    }
    const challenge = (
      await app.request({
        method: 'POST',
        url: '/api/auth/wallet/challenge',
        headers,
        payload: { address, networkId: 1 },
      })
    ).json()
    const proof = {
      challengeId: challenge.id,
      signature: sign(Buffer.from(challenge.message).toString('hex'), keys.privateKey),
      publicKey: keys.publicKey,
      scheme: 'ripple',
    }
    expect(
      (
        await app.request({
          method: 'POST',
          url: '/api/auth/wallet/link',
          headers,
          payload: { ...proof, signature: '00'.repeat(64) },
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await app.request({
          method: 'POST',
          url: '/api/auth/wallet/link',
          headers: {
            ...headers,
            cookie: second.sessionCookie,
            'x-xcs-csrf': second.session.csrfToken,
          },
          payload: proof,
        })
      ).statusCode,
    ).toBe(400)
    app.advance(300001)
    expect(
      (await app.request({ method: 'POST', url: '/api/auth/wallet/link', headers, payload: proof }))
        .statusCode,
    ).toBe(400)
  })
  it('rejects oversize and non-JSON challenge requests', async () => {
    const signed = await app.login(),
      headers = { cookie: signed.sessionCookie, origin, 'x-xcs-csrf': signed.session.csrfToken }
    expect(
      (
        await app.request({
          method: 'POST',
          url: '/api/auth/wallet/challenge',
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify({ data: 'a'.repeat(8192) }),
        })
      ).statusCode,
    ).toBe(413)
    expect(
      (
        await app.request({
          method: 'POST',
          url: '/api/auth/wallet/challenge',
          headers: { ...headers, 'content-type': 'text/plain' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(415)
  })
})

describe('private link OIDC handoff', () => {
  const token = 'A'.repeat(43)
  const linkCookie = '__Host-xcs-link-handoff'
  it('requires explicit same-origin JSON and never returns the bearer from the anonymous save', async () => {
    const denied = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff',
      headers: { origin: 'https://other.test' },
      payload: { kind: 'invitation', token },
    })
    expect(denied.statusCode).toBe(403)
    const saved = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff',
      headers: { origin, 'sec-fetch-site': 'same-origin' },
      payload: { kind: 'invitation', token },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ ok: true })
    expect(saved.body).not.toContain(token)
    expect(saved.headers['cache-control']).toBe('private, no-store')
    const header = String(saved.headers['set-cookie'])
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600', 'Path=/'])
      expect(header).toContain(flag)
    const anonymous = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff/consume',
      headers: { origin, cookie: cookie(saved, linkCookie) },
      payload: { kind: 'invitation' },
    })
    expect(anonymous.statusCode).toBe(401)
  })
  it('consumes only the intended link after session and CSRF validation and clears the cookie', async () => {
    const saved = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff',
      headers: { origin },
      payload: { kind: 'presentation', token },
    })
    const signed = await app.login()
    const headers = {
      origin,
      cookie: `${signed.sessionCookie}; ${cookie(saved, linkCookie)}`,
      'x-xcs-csrf': signed.session.csrfToken,
    }
    const forbidden = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff/consume',
      headers: { ...headers, 'x-xcs-csrf': 'wrong' },
      payload: { kind: 'presentation' },
    })
    expect(forbidden.statusCode).toBe(403)
    const other = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff/consume',
      headers,
      payload: { kind: 'invitation' },
    })
    expect(other.json()).toEqual({ token: null })
    expect(other.headers['set-cookie']).toBeUndefined()
    const consumed = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff/consume',
      headers,
      payload: { kind: 'presentation' },
    })
    expect(consumed.json()).toEqual({ token })
    expect(String(consumed.headers['set-cookie'])).toContain('Max-Age=0')
  })
  it('returns from OIDC only to an allowlisted token-free route', async () => {
    const start = await app.request({
      url: '/api/auth/login?returnTo=%2Ffr%2Frecipient%2Finvitations',
    })
    const state = new URL(String(start.headers.location)).searchParams.get('state')!
    const callback = await app.request({
      url: `/api/auth/callback?state=${state}&code=valid`,
      headers: { cookie: cookie(start, '__Host-xcs-login') },
    })
    expect(callback.headers.location).toBe('/fr/recipient/invitations')
  })
  it.each([
    { kind: 'other', token },
    { kind: 'invitation', token: '../unsafe' },
    { kind: 'invitation', token, extra: true },
  ])('rejects malformed or extended handoff bodies', async (payload) => {
    const response = await app.request({
      method: 'POST',
      url: '/api/auth/link-handoff',
      headers: { origin },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})
