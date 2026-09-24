import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createAppToken, hashAppToken } from '../../lib/db/index.js'
import { isValidClassicAddress } from 'xrpl'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import {
  createError,
  createRouter,
  defineEventHandler,
  getCookie,
  getHeader,
  getQuery,
  setCookie,
  deleteCookie,
  sendRedirect,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { readJsonBody } from '../private-body'
import type { AuthIdentityProvider } from './oidc'
import { hasRole, type AuthRepository, type Session, type AppRole } from './types'
import { verifyWalletProof } from './wallet-proof'
import { authReturnPath } from '../../../app/utils/authReturnPath'

export const SESSION_COOKIE = '__Host-xcs-session'
const LOGIN_COOKIE = '__Host-xcs-login'
const LINK_COOKIE = '__Host-xcs-link-handoff'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COOKIE = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' }
export interface AuthRuntimeOptions {
  repository: AuthRepository
  provider: AuthIdentityProvider
  origin: string
  idleSeconds: number
  absoluteSeconds: number
}
const failure = (statusCode: number, message: string): never => {
  throw createError({ statusCode, message })
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
function cookieHash(event: H3Event): string | null {
  return hashAppToken(getCookie(event, SESSION_COOKIE) ?? '')
}
export async function readAuthSession(
  event: H3Event,
  repository: AuthRepository,
): Promise<Session | null> {
  const hash = cookieHash(event)
  return hash ? repository.session(hash) : null
}
export async function requireAuthSession(
  event: H3Event,
  repository: AuthRepository,
): Promise<Session> {
  return (await readAuthSession(event, repository)) ?? failure(401, 'AUTH_REQUIRED')
}
export async function requireAuthRole(
  event: H3Event,
  repository: AuthRepository,
  role: AppRole,
  organizationId?: string,
): Promise<Session> {
  const session = await requireAuthSession(event, repository)
  if (!hasRole(session.account, role, organizationId)) failure(403, 'AUTH_NOT_AUTHORIZED')
  return session
}
export function requireCsrf(event: H3Event, session: Session, origin: string): void {
  if (
    getHeader(event, 'origin') !== origin ||
    !equal(getHeader(event, 'x-xcs-csrf') ?? '', session.csrfToken)
  ) {
    failure(403, 'AUTH_CSRF_REJECTED')
  }
  const site = getHeader(event, 'sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') failure(403, 'AUTH_CSRF_REJECTED')
}
function sessionResponse(session: Session | null) {
  return {
    enabled: true,
    user: session?.account ?? null,
    ...(session
      ? {
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
          absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        }
      : {}),
  }
}
async function body(event: H3Event): Promise<Record<string, unknown>> {
  const input = await readJsonBody(event, 4096)
  if (!input || typeof input !== 'object' || Array.isArray(input))
    failure(400, 'AUTH_INPUT_INVALID')
  return input as Record<string, unknown>
}
function only(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) failure(400, 'AUTH_INPUT_INVALID')
}

export function createAuthHandler(options: AuthRuntimeOptions) {
  const { repository, provider, origin, idleSeconds, absoluteSeconds } = options
  const router = createRouter()
  const limits = new RateLimiterMemory({ points: 120, duration: 60 })
  const mutations = new RateLimiterMemory({ points: 20, duration: 60 })
  const sessionInput = () => ({
    ...createAppToken(),
    csrfToken: createAppToken().token,
    idleSeconds,
    absoluteSeconds,
  })
  const mutation = async (event: H3Event) => {
    const session = await requireAuthSession(event, repository)
    requireCsrf(event, session, origin)
    await mutations.consume(`user:${session.userId}`)
    return session
  }
  router.get(
    '/api/auth/session',
    defineEventHandler(async (event) => sessionResponse(await readAuthSession(event, repository))),
  )
  router.post(
    '/api/auth/link-handoff',
    defineEventHandler(async (event) => {
      // Pre-authentication handoff: the browser must initiate an explicit same-origin POST.
      // Merely opening a link cannot set the cookie or claim/disclose anything.
      const site = getHeader(event, 'sec-fetch-site')
      if (getHeader(event, 'origin') !== origin || (site && site !== 'same-origin'))
        failure(403, 'AUTH_CSRF_REJECTED')
      await mutations.consume(
        `handoff:${event.context.xcsClientAddress ?? event.node.req.socket.remoteAddress ?? 'unknown'}`,
      )
      const input = await body(event)
      only(input, ['kind', 'token'])
      if (
        !['invitation', 'presentation'].includes(String(input.kind)) ||
        typeof input.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.token)
      )
        failure(400, 'AUTH_INPUT_INVALID')
      setCookie(event, LINK_COOKIE, `${input.kind}.${input.token}`, { ...COOKIE, maxAge: 600 })
      return { ok: true }
    }),
  )
  router.post(
    '/api/auth/link-handoff/consume',
    defineEventHandler(async (event) => {
      await mutation(event)
      const input = await body(event)
      only(input, ['kind'])
      if (!['invitation', 'presentation'].includes(String(input.kind)))
        failure(400, 'AUTH_INPUT_INVALID')
      const stored = getCookie(event, LINK_COOKIE)
      const match = /^(invitation|presentation)\.([A-Za-z0-9_-]{43})$/.exec(stored ?? '')
      // A different page must not destroy a still-pending link of the other kind.
      if (!match || match[1] !== input.kind) return { token: null }
      deleteCookie(event, LINK_COOKIE, COOKIE)
      return { token: match[2] }
    }),
  )
  router.get(
    '/api/auth/login',
    defineEventHandler(async (event) => {
      await mutations.consume(
        `login:${event.context.xcsClientAddress ?? event.node.req.socket.remoteAddress ?? 'unknown'}`,
      )
      const query = getQuery(event)
      const returnTo = authReturnPath(query.returnTo)
      const state = createAppToken(),
        browser = createAppToken()
      const nonce = createAppToken().token,
        codeVerifier = createAppToken().token
      const url = await provider.authorizationUrl({ state: state.token, nonce, codeVerifier })
      await repository.saveLogin({
        stateHash: state.tokenHash,
        browserHash: browser.tokenHash,
        nonce,
        codeVerifier,
        returnTo,
        expiresAt: new Date(Date.now() + 600000),
      })
      setCookie(event, LOGIN_COOKIE, browser.token, { ...COOKIE, maxAge: 600 })
      return sendRedirect(event, url, 302)
    }),
  )
  router.get(
    '/api/auth/callback',
    defineEventHandler(async (event) => {
      const query = getQuery(event)
      const browserHash = hashAppToken(getCookie(event, LOGIN_COOKIE) ?? '')
      deleteCookie(event, LOGIN_COOKIE, COOKIE)
      const stateHash = typeof query.state === 'string' ? hashAppToken(query.state) : null
      if (!browserHash || !stateHash) return sendRedirect(event, '/auth/login?error=signin', 302)
      const login = await repository.consumeLogin(stateHash, browserHash)
      if (!login) return sendRedirect(event, '/auth/login?error=signin', 302)
      try {
        if (
          query.error ||
          typeof query.code !== 'string' ||
          typeof query.state !== 'string' ||
          query.code.length > 4096
        )
          throw new Error('AUTH_CALLBACK_INVALID')
        const callbackUrl = new URL('/api/auth/callback', origin)
        callbackUrl.searchParams.set('code', query.code)
        callbackUrl.searchParams.set('state', query.state)
        if (query.iss !== undefined) {
          if (typeof query.iss !== 'string') throw new Error('AUTH_CALLBACK_INVALID')
          callbackUrl.searchParams.set('iss', query.iss)
        }
        const identity = await provider.exchange({
          callbackUrl,
          state: query.state,
          nonce: login.nonce,
          codeVerifier: login.codeVerifier,
        })
        const input = sessionInput()
        await repository.createSession(identity, input, cookieHash(event) ?? undefined)
        setCookie(event, SESSION_COOKIE, input.token, { ...COOKIE, maxAge: idleSeconds })
        return sendRedirect(event, login.returnTo, 302)
      } catch {
        // Provider errors and request URLs can contain tokens or personal data.
        return sendRedirect(event, '/auth/login?error=signin', 302)
      }
    }),
  )
  router.post(
    '/api/auth/refresh',
    defineEventHandler(async (event) => {
      const session = await mutation(event)
      const input = sessionInput()
      if (!(await repository.refresh(session.tokenHash, input))) failure(401, 'AUTH_REQUIRED')
      const updated = await repository.session(input.tokenHash)
      if (!updated) failure(401, 'AUTH_REQUIRED')
      setCookie(event, SESSION_COOKIE, input.token, {
        ...COOKIE,
        maxAge: Math.max(0, Math.floor((updated.expiresAt.getTime() - Date.now()) / 1000)),
      })
      return sessionResponse(updated)
    }),
  )
  router.post(
    '/api/auth/logout',
    defineEventHandler(async (event) => {
      const session = await mutation(event)
      await repository.logout(session.id)
      deleteCookie(event, SESSION_COOKIE, COOKIE)
      deleteCookie(event, LINK_COOKIE, COOKIE)
      return { ok: true }
    }),
  )
  router.get(
    '/api/auth/access',
    defineEventHandler(async (event) => {
      const query = getQuery(event)
      const role = query.role
      if (typeof role !== 'string' || !['admin', 'recipient', 'issuer', 'verifier'].includes(role))
        failure(400, 'AUTH_INPUT_INVALID')
      const organizationId = query.organizationId
      if (
        organizationId !== undefined &&
        (typeof organizationId !== 'string' || !UUID.test(organizationId))
      )
        failure(400, 'AUTH_INPUT_INVALID')
      await requireAuthRole(
        event,
        repository,
        role as AppRole,
        organizationId as string | undefined,
      )
      return { authorized: true }
    }),
  )
  router.post(
    '/api/auth/wallet/challenge',
    defineEventHandler(async (event) => {
      const session = await mutation(event)
      const input = await body(event)
      only(input, ['address', 'networkId'])
      // The existing XCS wallet flows are Testnet-only. Network is signed, never inferred from an address.
      if (
        typeof input.address !== 'string' ||
        !isValidClassicAddress(input.address) ||
        input.networkId !== 1
      )
        failure(400, 'AUTH_WALLET_INPUT_INVALID')
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + 300000)
      const message = [
        'XCS wallet ownership proof',
        `Origin: ${origin}`,
        `User: ${session.userId}`,
        `Session: ${session.id}`,
        `Network: 1 (XRPL Testnet)`,
        `Address: ${input.address}`,
        `Challenge: ${id}`,
        `Nonce: ${createAppToken().token}`,
        `Expires: ${expiresAt.toISOString()}`,
        'This message links this wallet to your XCS account. It does not authorize a transaction.',
      ].join('\n')
      if (
        !(await repository.saveChallenge(session.tokenHash, {
          id,
          sessionId: session.id,
          networkId: 1,
          address: input.address as string,
          message,
          expiresAt,
        }))
      )
        failure(401, 'AUTH_REQUIRED')
      return { id, message, expiresAt: expiresAt.toISOString() }
    }),
  )
  router.post(
    '/api/auth/wallet/link',
    defineEventHandler(async (event) => {
      const session = await mutation(event),
        input = await body(event)
      only(input, ['challengeId', 'signature', 'publicKey', 'scheme'])
      if (
        typeof input.challengeId !== 'string' ||
        !UUID.test(input.challengeId) ||
        typeof input.signature !== 'string' ||
        typeof input.publicKey !== 'string' ||
        !['ripple', 'otsu'].includes(String(input.scheme))
      )
        failure(400, 'AUTH_WALLET_PROOF_INVALID')
      const challenge = await repository.challenge(session.tokenHash, input.challengeId as string)
      if (
        !challenge ||
        !verifyWalletProof(challenge.message, challenge.address, {
          signature: input.signature as string,
          publicKey: input.publicKey as string,
          scheme: input.scheme as 'ripple' | 'otsu',
        })
      )
        failure(400, 'AUTH_WALLET_PROOF_INVALID')
      if (!(await repository.linkWallet(session.tokenHash, challenge.id)))
        failure(409, 'AUTH_WALLET_LINK_UNAVAILABLE')
      return sessionResponse(await repository.session(session.tokenHash))
    }),
  )
  router.post(
    '/api/auth/wallet/unlink',
    defineEventHandler(async (event) => {
      const session = await mutation(event),
        input = await body(event)
      only(input, ['walletId'])
      if (typeof input.walletId !== 'string' || !UUID.test(input.walletId))
        failure(400, 'AUTH_INPUT_INVALID')
      if (!(await repository.unlinkWallet(session.tokenHash, input.walletId as string)))
        failure(404, 'AUTH_WALLET_NOT_FOUND')
      return sessionResponse(await repository.session(session.tokenHash))
    }),
  )
  const routeHandler = router.handler
  return defineEventHandler(async (event) => {
    setResponseHeaders(event, {
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
    try {
      await limits.consume(
        event.context.xcsClientAddress ?? event.node.req.socket.remoteAddress ?? 'unknown',
      )
      return await routeHandler(event)
    } catch (error) {
      const status =
        error instanceof RateLimiterRes
          ? 429
          : ((error as { statusCode?: number })?.statusCode ?? 503)
      const safeStatus = [400, 401, 403, 404, 405, 409, 413, 415, 429].includes(status)
        ? status
        : 503
      setResponseStatus(event, safeStatus)
      const code =
        safeStatus === 429
          ? 'AUTH_RATE_LIMITED'
          : safeStatus === 503
            ? 'AUTH_UNAVAILABLE'
            : 'AUTH_REQUEST_REJECTED'
      return { error: code }
    }
  })
}
