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
import { readJsonBody } from '../private-body'
import { AdminError, decisionInput, role, uuid } from './domain'
import type { PrivateDocuments } from './documents'
import type { AdminRepository } from './repository'

export interface AdminOptions {
  repository: AdminRepository
  documents: PrivateDocuments
  authorize: (event: H3Event, mutation: boolean) => Promise<Session>
}
export function createAdminHandler({ repository, documents, authorize }: AdminOptions) {
  const router = createRouter(),
    sessions = new WeakMap<H3Event, Session>()
  const limits = new RateLimiterMemory({ points: 120, duration: 60 })
  const mutations = new RateLimiterMemory({ points: 30, duration: 60 })
  const page = (event: H3Event, allowed: string[] = ['page']) => {
    const query = getQuery(event)
    if (
      Object.keys(query).some((k) => !allowed.includes(k)) ||
      (query.page !== undefined &&
        (typeof query.page !== 'string' || !/^[1-9]\d{0,5}$/.test(query.page)))
    )
      throw new AdminError(400, 'ADMIN_INPUT_INVALID')
    return Number(query.page ?? 1)
  }
  router.get(
    '/api/admin/applications',
    defineEventHandler((event) => {
      const p = page(event, ['page', 'role']),
        filter = getQuery(event).role
      return repository.list(p, filter === undefined ? undefined : role(filter))
    }),
  )
  router.get(
    '/api/admin/verifiers',
    defineEventHandler((event) => repository.list(page(event), undefined, true)),
  )
  router.get(
    '/api/admin/audit',
    defineEventHandler((event) => repository.history(page(event))),
  )
  router.get(
    '/api/admin/applications/:id/:role',
    defineEventHandler((event) =>
      repository.detail(uuid(getRouterParam(event, 'id')), role(getRouterParam(event, 'role'))),
    ),
  )
  router.post(
    '/api/admin/applications/:id/:role/decisions',
    defineEventHandler(async (event) =>
      repository.decide(
        sessions.get(event)!,
        uuid(getRouterParam(event, 'id')),
        role(getRouterParam(event, 'role')),
        decisionInput(await readJsonBody(event, 8192)),
      ),
    ),
  )
  router.post(
    '/api/admin/documents/:id/link',
    defineEventHandler(async (event) => {
      const id = uuid(getRouterParam(event, 'id'))
      await documents.read(await repository.document(id))
      return documents.link(id, sessions.get(event)!.id)
    }),
  )
  router.get(
    '/api/admin/documents/:id',
    defineEventHandler(async (event) => {
      const id = uuid(getRouterParam(event, 'id')),
        query = getQuery(event)
      documents.verify(id, sessions.get(event)!.id, query.expires, query.signature)
      const document = await repository.document(id),
        content = await documents.read(document)
      const extension = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }[
        document.mime_type
      ]
      setResponseHeaders(event, {
        'content-type': document.mime_type,
        'content-length': String(content.length),
        'content-disposition': `inline; filename="review-${id}.${extension}"`,
        'content-security-policy': "default-src 'none'; sandbox",
      })
      return content
    }),
  )
  router.post(
    '/api/admin/notifications/:id/retry',
    defineEventHandler(async (event) => {
      const input = await readJsonBody(event, 64)
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        throw new AdminError(400, 'ADMIN_INPUT_INVALID')
      return repository.retryNotification(uuid(getRouterParam(event, 'id')))
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
      const session = await authorize(event, event.method !== 'GET')
      sessions.set(event, session)
      await limits.consume(session.userId)
      if (event.method !== 'GET') await mutations.consume(session.userId)
      return await router.handler(event)
    } catch (error) {
      const status =
        error instanceof RateLimiterRes
          ? 429
          : ((error as { statusCode?: number })?.statusCode ?? 503)
      const safeStatus = [400, 401, 403, 404, 405, 409, 413, 415, 422, 429].includes(status)
        ? status
        : 503
      setResponseStatus(event, safeStatus)
      return {
        error:
          error instanceof AdminError
            ? error.code
            : safeStatus === 401
              ? 'AUTH_REQUIRED'
              : safeStatus === 403
                ? 'AUTH_NOT_AUTHORIZED'
                : safeStatus === 429
                  ? 'ADMIN_RATE_LIMITED'
                  : safeStatus === 503
                    ? 'ADMIN_UNAVAILABLE'
                    : 'ADMIN_REQUEST_REJECTED',
        ...(error instanceof AdminError && error.current ? { current: error.current } : {}),
      }
    } finally {
      sessions.delete(event)
    }
  })
}
