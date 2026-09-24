import {
  createRouter,
  defineEventHandler,
  getQuery,
  getRouterParam,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import type { Session } from '../auth/types'
import { IssuerError, applicationInput, object, uuid } from '../issuer/types'
import { RecipientError } from '../recipient/types'
import { readJsonBody } from '../private-body'
import { historyCsv } from './csv'
import type { PresentationResolver, VerifierRepository } from './repository'
import { VerifierError } from './types'

export interface VerifierHandlerOptions {
  repository: Pick<VerifierRepository, 'workspace' | 'apply' | 'history' | 'reopen'>
  authorize: (event: H3Event, mutation: boolean) => Promise<Session>
  resolvePresentation: PresentationResolver
}

export function createVerifierHandler({
  repository,
  authorize,
  resolvePresentation,
}: VerifierHandlerOptions) {
  const router = createRouter()
  const sessions = new WeakMap<H3Event, Session>()
  const limits = new RateLimiterMemory({ points: 120, duration: 60 })
  const mutations = new RateLimiterMemory({ points: 20, duration: 60 })
  function selection(event: H3Event) {
    const query = getQuery(event)
    if (Object.keys(query).some((key) => key !== 'organizationId'))
      throw new VerifierError(400, 'VERIFIER_INPUT_INVALID')
    return query.organizationId === undefined ? undefined : uuid(query.organizationId)
  }
  router.get(
    '/api/verifier/workspace',
    defineEventHandler((event) => repository.workspace(sessions.get(event)!, selection(event))),
  )
  router.post(
    '/api/verifier/applications',
    defineEventHandler(async (event) =>
      repository.apply(
        sessions.get(event)!,
        applicationInput(await readJsonBody(event, 22 * 1024 * 1024)),
      ),
    ),
  )
  router.get(
    '/api/verifier/history.csv',
    defineEventHandler(async (event) => {
      const history = await repository.history(sessions.get(event)!, selection(event))
      setResponseHeaders(event, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="verifier-history.csv"',
        'content-security-policy': "default-src 'none'; sandbox",
      })
      return historyCsv(history)
    }),
  )
  router.post(
    '/api/verifier/history/:id/presentation',
    defineEventHandler(async (event) => {
      if (Object.keys(getQuery(event)).length)
        throw new VerifierError(400, 'VERIFIER_INPUT_INVALID')
      object(await readJsonBody(event, 4096), [])
      return repository.reopen(
        sessions.get(event)!,
        uuid(getRouterParam(event, 'id')),
        resolvePresentation,
      )
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
      const mutation = event.method !== 'GET'
      const session = await authorize(event, mutation)
      sessions.set(event, session)
      await limits.consume(session.userId)
      if (mutation) await mutations.consume(session.userId)
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
          error instanceof VerifierError ||
          error instanceof IssuerError ||
          error instanceof RecipientError
            ? error.code
            : status === 401
              ? 'AUTH_REQUIRED'
              : status === 403
                ? 'AUTH_NOT_AUTHORIZED'
                : status === 429
                  ? 'VERIFIER_RATE_LIMITED'
                  : 'VERIFIER_UNAVAILABLE',
      }
    } finally {
      sessions.delete(event)
    }
  })
}
