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
import { hash, object, text, uuid } from '../issuer/types'
import {
  RecipientError,
  type CreatePresentationInput,
  type PresentationChallengeInput,
} from './types'
import type { RecipientRepository } from './repository'

export const PORTAL_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}
export function portalFailure(event: H3Event, error: unknown, fallback: string) {
  const code =
    error instanceof RateLimiterRes ? 429 : ((error as { statusCode?: number })?.statusCode ?? 503)
  const status = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 503].includes(code) ? code : 503
  setResponseStatus(event, status)
  return {
    error:
      error instanceof RecipientError
        ? error.code
        : status === 401
          ? 'AUTH_REQUIRED'
          : status === 403
            ? 'AUTH_NOT_AUTHORIZED'
            : status === 429
              ? 'RECIPIENT_RATE_LIMITED'
              : status === 400
                ? 'RECIPIENT_INPUT_INVALID'
                : fallback,
  }
}
export function createRecipientHandler(options: {
  repository: RecipientRepository
  authorize: (event: H3Event, mutation: boolean) => Promise<Session>
}) {
  const router = createRouter(),
    sessions = new WeakMap<H3Event, Session>()
  const limits = new RateLimiterMemory({ points: 120, duration: 60 })
  const mutations = new RateLimiterMemory({ points: 20, duration: 60 })
  const anonymous = new RateLimiterMemory({ points: 120, duration: 60 })
  const body = async (event: H3Event, keys: string[]) =>
    object(await readJsonBody(event, 4096), keys)
  const ref = (event: H3Event) =>
    [
      text(getRouterParam(event, 'profileId'), 200),
      hash(getRouterParam(event, 'generationId')),
    ] as const
  const { repository } = options
  router.get(
    '/api/recipient/workspace',
    defineEventHandler((event) => repository.workspace(sessions.get(event)!)),
  )
  router.get(
    '/api/recipient/verifiers',
    defineEventHandler((event) => repository.verifiers(sessions.get(event)!)),
  )
  router.get(
    '/api/recipient/credentials/:profileId/:generationId',
    defineEventHandler((event) => repository.credential(sessions.get(event)!, ...ref(event))),
  )
  router.get(
    '/api/recipient/credentials/:profileId/:generationId/payload',
    defineEventHandler((event) => repository.payload(sessions.get(event)!, ...ref(event))),
  )
  router.post(
    '/api/recipient/credentials/:profileId/:generationId/reconcile',
    defineEventHandler(async (event) => {
      const input = await body(event, ['transactionHash', 'action'])
      if (input.action !== 'accept' && input.action !== 'reject' && input.action !== 'remove')
        throw new RecipientError(400, 'RECIPIENT_INPUT_INVALID')
      return repository.reconcile(
        sessions.get(event)!,
        ...ref(event),
        hash(input.transactionHash),
        input.action,
      )
    }),
  )
  router.get(
    '/api/recipient/presentations',
    defineEventHandler((event) => {
      const query = object(getQuery(event), ['profileId', 'generationId'])
      const filter =
        query.profileId === undefined && query.generationId === undefined
          ? undefined
          : { profileId: text(query.profileId, 200), generationId: hash(query.generationId) }
      return repository.presentations(sessions.get(event)!, filter)
    }),
  )
  const presentationInput = (input: Record<string, unknown>): PresentationChallengeInput => {
    if (input.scope !== 'public' && input.scope !== 'full')
      throw new RecipientError(400, 'RECIPIENT_INPUT_INVALID')
    return {
      profileId: text(input.profileId, 200),
      generationId: hash(input.generationId),
      scope: input.scope,
      verifierOrganizationId:
        input.verifierOrganizationId == null ? null : uuid(input.verifierOrganizationId),
    }
  }
  const presentationKeys = ['profileId', 'generationId', 'scope', 'verifierOrganizationId']
  router.post(
    '/api/recipient/presentation-challenges',
    defineEventHandler(async (event) => {
      const input = presentationInput(await body(event, presentationKeys))
      return repository.presentationChallenge(sessions.get(event)!, input)
    }),
  )
  router.post(
    '/api/recipient/presentations',
    defineEventHandler(async (event) => {
      const input = await body(event, [...presentationKeys, 'proof'])
      if (!input.proof) throw new RecipientError(400, 'RECIPIENT_PROOF_REQUIRED')
      const proof = object(input.proof, ['challengeId', 'signature', 'publicKey', 'scheme'])
      if (proof.scheme !== 'ripple' && proof.scheme !== 'otsu')
        throw new RecipientError(400, 'RECIPIENT_INPUT_INVALID')
      const data: CreatePresentationInput = {
        ...presentationInput(input),
        proof: {
          challengeId: uuid(proof.challengeId),
          signature: text(proof.signature, 144),
          publicKey: text(proof.publicKey, 66),
          scheme: proof.scheme,
        },
      }
      return repository.createPresentation(sessions.get(event)!, data)
    }),
  )
  router.post(
    '/api/recipient/presentations/:id/revoke',
    defineEventHandler(async (event) => {
      await body(event, [])
      return repository.revokePresentation(sessions.get(event)!, uuid(getRouterParam(event, 'id')))
    }),
  )
  return defineEventHandler(async (event) => {
    setResponseHeaders(event, PORTAL_HEADERS)
    try {
      await anonymous.consume(getRequestIP(event) ?? 'unknown')
      const session = await options.authorize(event, event.method !== 'GET')
      sessions.set(event, session)
      await limits.consume(session.userId)
      if (event.method !== 'GET') await mutations.consume(session.userId)
      return await router.handler(event)
    } catch (error) {
      return portalFailure(event, error, 'RECIPIENT_UNAVAILABLE')
    } finally {
      sessions.delete(event)
    }
  })
}
