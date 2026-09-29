import { defineEventHandler, getHeader, getRequestIP, setResponseHeaders, type H3Event } from 'h3'
import { RateLimiterMemory } from 'rate-limiter-flexible'
import type { Session } from '../auth/types'
import { requireCsrf } from '../auth/http'
import { readJsonBody } from '../private-body'
import { object, text } from '../issuer/types'
import { PORTAL_HEADERS, portalFailure } from '../recipient/http'
import { RecipientError } from '../recipient/types'
import type { PresentationRepository } from './repository'

export function createPresentationHandler(options: {
  repository: PresentationRepository
  origin: string
  readSession: (event: H3Event) => Promise<Session | null>
}) {
  const limit = new RateLimiterMemory({ points: 60, duration: 60 })
  return defineEventHandler(async (event) => {
    setResponseHeaders(event, PORTAL_HEADERS)
    try {
      await limit.consume(getRequestIP(event) ?? 'unknown')
      if (event.method !== 'POST') throw new RecipientError(405, 'PRESENTATION_METHOD_NOT_ALLOWED')
      if (
        getHeader(event, 'origin') !== options.origin ||
        ![undefined, 'same-origin', 'none'].includes(getHeader(event, 'sec-fetch-site'))
      )
        throw new RecipientError(403, 'AUTH_NOT_AUTHORIZED')
      const session = await options.readSession(event)
      if (session) requireCsrf(event, session, options.origin)
      const input = object(await readJsonBody(event, 4096), ['token'])
      return await options.repository.resolve(session, text(input.token, 43))
    } catch (error) {
      return portalFailure(event, error, 'PRESENTATION_UNAVAILABLE')
    }
  })
}
