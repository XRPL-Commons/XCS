import {
  createRouter,
  defineEventHandler,
  getQuery,
  getRequestIP,
  getRouterParam,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import type { Session } from '../auth/types'
import { readJsonBody } from '../private-body'
import type { IssuerRepository } from './repository'
import { IssuerError, applicationInput, disclosure, email, hash, object, text, uuid } from './types'

export interface IssuerHandlerOptions {
  repository: IssuerRepository
  authorize: (event: H3Event, mutation: boolean) => Promise<Session>
  readSession: (event: H3Event) => Promise<Session | null>
}
export function createIssuerHandler({ repository, authorize, readSession }: IssuerHandlerOptions) {
  const router = createRouter(),
    sessions = new WeakMap<H3Event, Session>()
  const limits = new RateLimiterMemory({ points: 120, duration: 60 }),
    mutations = new RateLimiterMemory({ points: 20, duration: 60 })
  const publicLimits = new RateLimiterMemory({ points: 60, duration: 60 })
  const input = async (event: H3Event, keys: string[], limit = 8192) =>
    object(await readJsonBody(event, limit), keys)
  const param = (event: H3Event, key: string) => getRouterParam(event, key)
  router.get(
    '/api/issuer/workspace',
    defineEventHandler((event) => {
      const query = getQuery(event)
      if (Object.keys(query).some((key) => key !== 'organizationId'))
        throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
      return repository.workspace(
        sessions.get(event)!,
        query.organizationId === undefined ? undefined : uuid(query.organizationId),
      )
    }),
  )
  router.post(
    '/api/issuer/applications',
    defineEventHandler(async (event) =>
      repository.apply(
        sessions.get(event)!,
        applicationInput(await readJsonBody(event, 22 * 1024 * 1024)),
      ),
    ),
  )
  router.post(
    '/api/issuer/schemas',
    defineEventHandler(async (event) => {
      const body = await input(event, [
        'organizationId',
        'profileId',
        'transactionHash',
        'displayName',
        'category',
      ])
      return repository.registerSchema(sessions.get(event)!, {
        organizationId: uuid(body.organizationId),
        profileId: text(body.profileId, 200),
        transactionHash: hash(body.transactionHash),
        displayName: text(body.displayName, 200, false),
        category: text(body.category, 200, false),
      })
    }),
  )
  router.post(
    '/api/issuer/invites',
    defineEventHandler(async (event) => {
      const body = await input(event, [
        'organizationId',
        'profileId',
        'schemaUid',
        'email',
        'message',
      ])
      return repository.invite(sessions.get(event)!, {
        organizationId: uuid(body.organizationId),
        profileId: text(body.profileId, 200),
        schemaUid: hash(body.schemaUid),
        email: email(body.email),
        message: text(body.message, 2000, false),
      })
    }),
  )
  for (const action of ['resend', 'revoke'] as const)
    router.post(
      `/api/issuer/invites/:id/${action}`,
      defineEventHandler(async (event) => {
        await input(event, [])
        return repository.changeInvite(sessions.get(event)!, uuid(param(event, 'id')), action)
      }),
    )
  router.get(
    '/api/issuer/invites/:id/issuance',
    defineEventHandler((event) =>
      repository.issuance(sessions.get(event)!, uuid(param(event, 'id'))),
    ),
  )
  router.post(
    '/api/issuer/payloads',
    defineEventHandler(async (event) => {
      const body = await input(
        event,
        ['inviteId', 'canonicalPayload', 'subjectAddress', 'visibility', 'publicFields'],
        2 * 1024 * 1024,
      )
      // Preserve canonical bytes exactly; trimming would hide a caller's noncanonical input.
      if (
        typeof body.canonicalPayload !== 'string' ||
        Buffer.byteLength(body.canonicalPayload) > 1024 * 1024
      )
        throw new IssuerError(400, 'ISSUER_PAYLOAD_INVALID')
      return repository.preparePayload(sessions.get(event)!, {
        inviteId: uuid(body.inviteId),
        canonicalPayload: body.canonicalPayload,
        subjectAddress: text(body.subjectAddress, 50),
        ...disclosure(body),
      })
    }),
  )
  router.post(
    '/api/issuer/credentials',
    defineEventHandler(async (event) => {
      const body = await input(event, [
        'inviteId',
        'transactionHash',
        'payloadId',
        'visibility',
        'publicFields',
      ])
      return repository.recordCredential(sessions.get(event)!, {
        inviteId: uuid(body.inviteId),
        transactionHash: hash(body.transactionHash),
        payloadId: uuid(body.payloadId),
        ...disclosure(body),
      })
    }),
  )
  router.get(
    '/api/issuer/credentials/:profileId/:generationId',
    defineEventHandler((event) =>
      repository.credential(
        sessions.get(event)!,
        text(param(event, 'profileId'), 200),
        hash(param(event, 'generationId')),
      ),
    ),
  )
  router.post(
    '/api/issuer/credentials/:profileId/:generationId/reconcile',
    defineEventHandler(async (event) => {
      const body = await input(event, ['transactionHash'])
      return repository.refreshCredential(
        sessions.get(event)!,
        text(param(event, 'profileId'), 200),
        hash(param(event, 'generationId')),
        hash(body.transactionHash),
      )
    }),
  )
  const servePayload = async (event: H3Event, byLocator: boolean) => {
    const id = byLocator ? text(param(event, 'locator'), 18) : uuid(param(event, 'id'))
    if (byLocator && !/^[0-9a-f]{18}$/.test(id))
      throw new IssuerError(404, 'ISSUER_PAYLOAD_NOT_FOUND')
    const result = await repository.payload(await readSession(event), id, byLocator)
    setResponseHeaders(event, {
      'content-type': 'application/json; charset=utf-8',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-xcs-claim-scope': result.scope,
    })
    return result.content
  }
  router.get(
    '/api/issuer/payloads/:id',
    defineEventHandler((event) => servePayload(event, false)),
  )
  router.get(
    '/q/:locator',
    defineEventHandler((event) => servePayload(event, true)),
  )
  for (const action of ['preview', 'claim'] as const)
    router.post(
      `/api/issuer/invitations/${action}`,
      defineEventHandler(async (event) => {
        const body = await input(event, ['token'])
        return repository.invitation(sessions.get(event)!, text(body.token, 43), action === 'claim')
      }),
    )
  return defineEventHandler(async (event) => {
    setResponseHeaders(event, {
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    try {
      const publicPayload =
        event.method === 'GET' &&
        (/^\/api\/issuer\/payloads\/[^/]+$/.test(event.path.split('?')[0]!) ||
          /^\/q\/[^/]+$/.test(event.path.split('?')[0]!))
      if (!publicPayload) {
        const session = await authorize(event, event.method !== 'GET')
        sessions.set(event, session)
        await limits.consume(session.userId)
        if (event.method !== 'GET') await mutations.consume(session.userId)
      } else await publicLimits.consume(getRequestIP(event) ?? 'unknown')
      return await router.handler(event)
    } catch (error) {
      const code =
        error instanceof RateLimiterRes
          ? 429
          : ((error as { statusCode?: number })?.statusCode ?? 503)
      const status = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(code) ? code : 503
      setResponseStatus(event, status)
      return {
        error:
          error instanceof IssuerError
            ? error.code
            : status === 401
              ? 'AUTH_REQUIRED'
              : status === 403
                ? 'AUTH_NOT_AUTHORIZED'
                : status === 429
                  ? 'ISSUER_RATE_LIMITED'
                  : 'ISSUER_UNAVAILABLE',
      }
    } finally {
      sessions.delete(event)
    }
  })
}
