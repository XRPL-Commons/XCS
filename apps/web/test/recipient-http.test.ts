import { createApp, createError, getHeader, toNodeListener } from 'h3'
import { inject } from 'light-my-request'
import { describe, expect, it, vi } from 'vitest'
import { createRecipientHandler } from '../server/xcs/recipient/http'
import { createPresentationHandler } from '../server/xcs/presentations/http'
import type { RecipientRepository } from '../server/xcs/recipient/repository'
import type { PresentationRepository } from '../server/xcs/presentations/repository'
import type { Session } from '../server/xcs/auth/types'
import { requireCsrf } from '../server/xcs/auth/http'

const origin = 'https://xcs.test'
const session = { userId: 'recipient', csrfToken: 'csrf-test-only' } as Session
const generation = 'a'.repeat(64),
  transactionHash = 'b'.repeat(64)
const path = `/api/recipient/credentials/testnet/${generation}`

function recipientFixture() {
  const repository = {
    workspace: vi.fn(async () => ({ credentials: [] })),
    payload: vi.fn(async () => ({ claims: { private: 'secret' } })),
    reconcile: vi.fn(async () => ({ status: { state: 'deleted' } })),
    createPresentation: vi.fn(async () => ({ id: 'presentation' })),
    presentationChallenge: vi.fn(async () => ({ id: 'challenge' })),
    presentations: vi.fn(async () => ({ presentations: [] })),
  }
  const handler = toNodeListener(
    createApp().use(
      createRecipientHandler({
        repository: repository as unknown as RecipientRepository,
        authorize: async (event, mutation) => {
          if (getHeader(event, 'authorization') !== 'test-session')
            throw createError({ statusCode: 401 })
          if (mutation) requireCsrf(event, session, origin)
          return session
        },
      }),
    ),
  )
  return { repository, handler }
}
describe('recipient HTTP boundary', () => {
  it('requires authentication and current CSRF before a rejection; rejection never requests payload', async () => {
    const { repository, handler } = recipientFixture()
    expect(
      (await inject(handler, { method: 'GET', url: '/api/recipient/workspace' })).statusCode,
    ).toBe(401)
    const request = {
      method: 'POST' as const,
      url: `${path}/reconcile`,
      payload: { transactionHash, action: 'reject' },
    }
    expect(
      (await inject(handler, { ...request, headers: { authorization: 'test-session', origin } }))
        .statusCode,
    ).toBe(403)
    const response = await inject(handler, {
      ...request,
      headers: { authorization: 'test-session', origin, 'x-xcs-csrf': session.csrfToken },
    })
    expect(response.statusCode).toBe(200)
    expect(repository.reconcile).toHaveBeenCalledWith(
      session,
      'testnet',
      generation,
      transactionHash,
      'reject',
    )
    expect(repository.payload).not.toHaveBeenCalled()
    expect(response.body).not.toContain('secret')
  })
  it('rejects extra fields and malformed presentation filters instead of trusting supplied owners', async () => {
    const { repository, handler } = recipientFixture()
    const response = await inject(handler, {
      method: 'POST',
      url: '/api/recipient/presentations',
      headers: { authorization: 'test-session', origin, 'x-xcs-csrf': session.csrfToken },
      payload: {
        profileId: 'testnet',
        generationId: generation,
        scope: 'public',
        recipientUserId: 'other',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(repository.createPresentation).not.toHaveBeenCalled()
    expect(
      (
        await inject(handler, {
          method: 'GET',
          url: '/api/recipient/presentations?profileId=testnet',
          headers: { authorization: 'test-session' },
        })
      ).statusCode,
    ).toBe(400)
    expect(repository.presentations).not.toHaveBeenCalled()
  })
  it('requires CSRF for challenges and a strict purpose-specific proof before creating links', async () => {
    const { repository, handler } = recipientFixture()
    const payload = { profileId: 'testnet', generationId: generation, scope: 'public' }
    const headers = { authorization: 'test-session', origin, 'x-xcs-csrf': session.csrfToken }
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/recipient/presentation-challenges',
          payload,
          headers: { authorization: 'test-session', origin },
        })
      ).statusCode,
    ).toBe(403)
    expect(repository.presentationChallenge).not.toHaveBeenCalled()
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/recipient/presentation-challenges',
          payload,
          headers,
        })
      ).statusCode,
    ).toBe(200)
    expect(repository.presentationChallenge).toHaveBeenCalledWith(session, {
      ...payload,
      verifierOrganizationId: null,
    })
    const missing = await inject(handler, {
      method: 'POST',
      url: '/api/recipient/presentations',
      payload,
      headers,
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toEqual({ error: 'RECIPIENT_PROOF_REQUIRED' })
    expect(repository.createPresentation).not.toHaveBeenCalled()
    const proof = {
      challengeId: '00000000-0000-4000-8000-000000000001',
      scheme: 'ripple',
      publicKey: 'ED' + 'a'.repeat(64),
      signature: 'a'.repeat(128),
    }
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/recipient/presentations',
          payload: { ...payload, proof: { ...proof, message: 'client-selected' } },
          headers,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/recipient/presentations',
          payload: { ...payload, proof },
          headers,
        })
      ).statusCode,
    ).toBe(200)
    expect(repository.createPresentation).toHaveBeenCalledWith(session, {
      ...payload,
      verifierOrganizationId: null,
      proof,
    })
  })
  it('reads full claims only through the explicit payload endpoint', async () => {
    const { repository, handler } = recipientFixture()
    await inject(handler, {
      method: 'GET',
      url: '/api/recipient/workspace',
      headers: { authorization: 'test-session' },
    })
    expect(repository.payload).not.toHaveBeenCalled()
    const response = await inject(handler, {
      method: 'GET',
      url: `${path}/payload`,
      headers: { authorization: 'test-session' },
    })
    expect(response.statusCode).toBe(200)
    expect(repository.payload).toHaveBeenCalledOnce()
    expect(response.headers['cache-control']).toBe('private, no-store')
  })
})

describe('presentation POST disclosure boundary', () => {
  function fixture(authenticated = false) {
    const resolve = vi.fn(async () => ({ scope: 'public', claims: { course: 'Public' } }))
    const handler = toNodeListener(
      createApp().use(
        createPresentationHandler({
          origin,
          repository: { resolve } as unknown as PresentationRepository,
          readSession: async () => (authenticated ? session : null),
        }),
      ),
    )
    return { resolve, handler }
  }
  it('requires explicit same-origin JSON even anonymously, excluding scanners and cross-site requests', async () => {
    const { resolve, handler } = fixture()
    const token = 'a'.repeat(43)
    for (const headers of [
      {},
      { origin: 'https://other.test' },
      { origin, 'sec-fetch-site': 'cross-site' },
    ]) {
      expect(
        (
          await inject(handler, {
            method: 'POST',
            url: '/api/presentations/resolve',
            headers,
            payload: { token },
          })
        ).statusCode,
      ).toBe(403)
    }
    expect(
      (
        await inject(handler, {
          method: 'GET',
          url: '/api/presentations/resolve',
          headers: { origin },
        })
      ).statusCode,
    ).toBe(405)
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/presentations/resolve',
          headers: { origin, 'content-type': 'text/plain' },
          payload: token,
        })
      ).statusCode,
    ).toBe(415)
    expect(resolve).not.toHaveBeenCalled()
    const response = await inject(handler, {
      method: 'POST',
      url: '/api/presentations/resolve',
      headers: { origin },
      payload: { token },
    })
    expect(response.statusCode).toBe(200)
    expect(resolve).toHaveBeenCalledWith(null, token)
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['cache-control']).toBe('private, no-store')
  })
  it('requires CSRF for a signed-in consultation and rejects owner/scope spoofing', async () => {
    const { resolve, handler } = fixture(true)
    const payload = { token: 'a'.repeat(43) }
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/presentations/resolve',
          headers: { origin },
          payload,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/presentations/resolve',
          headers: { origin, 'x-xcs-csrf': session.csrfToken },
          payload: { ...payload, scope: 'full' },
        })
      ).statusCode,
    ).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
    expect(
      (
        await inject(handler, {
          method: 'POST',
          url: '/api/presentations/resolve',
          headers: { origin, 'x-xcs-csrf': session.csrfToken },
          payload,
        })
      ).statusCode,
    ).toBe(200)
    expect(resolve).toHaveBeenCalledWith(session, payload.token)
  })
})
