import { createHttpsPayloadUri, createIpfsPayloadUri } from '@xcs-protocol/core'
import { describe, expect, it, vi } from 'vitest'

import {
  MAX_PILOT_PAYLOAD_BYTES,
  readCanonicalHttpsPayload,
  verifyHttpsPayloadPublication,
} from '../app/utils/payloadPublication'
import { canonicalJson } from '../app/utils/serialization'

function jsonResponse(content: BodyInit, headers: Record<string, string> = {}): Response {
  return new Response(content, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

describe('browser HTTPS payload publication proof', () => {
  const canonical = canonicalJson({ claims: { programId: 'course-1' } })
  const uri = createHttpsPayloadUri('https://issuer.example/credentials/one.json', canonical)

  it('fetches exact canonical bytes with browser safety options and returns no content', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(canonical))
    const proof = await verifyHttpsPayloadPublication({
      canonicalPayload: canonical,
      credentialUri: uri,
      fetchImpl: fetchMock,
      now: () => new Date('2026-08-19T12:00:00.000Z'),
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.example/credentials/one.json',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    )
    expect(proof).toMatchObject({
      credentialUri: uri,
      byteLength: new TextEncoder().encode(canonical).byteLength,
      checkedAt: '2026-08-19T12:00:00.000Z',
    })
    expect(proof).not.toHaveProperty('content')
  })

  it('rejects non-HTTPS URIs, redirects, changed final URLs and non-JSON media types', async () => {
    await expect(
      readCanonicalHttpsPayload({ credentialUri: createIpfsPayloadUri(canonical) }),
    ).rejects.toThrow('PILOT_HTTPS_PAYLOAD_REQUIRED')

    const redirected = jsonResponse(canonical)
    Object.defineProperty(redirected, 'redirected', { value: true })
    await expect(
      readCanonicalHttpsPayload({ credentialUri: uri, fetchImpl: async () => redirected }),
    ).rejects.toThrow('PAYLOAD_REDIRECT_REJECTED')

    const changedUrl = jsonResponse(canonical)
    Object.defineProperty(changedUrl, 'url', {
      value: 'https://cdn.example/credentials/one.json',
    })
    await expect(
      readCanonicalHttpsPayload({ credentialUri: uri, fetchImpl: async () => changedUrl }),
    ).rejects.toThrow('PAYLOAD_FINAL_URL_MISMATCH')

    await expect(
      readCanonicalHttpsPayload({
        credentialUri: uri,
        fetchImpl: async () =>
          new Response(canonical, { headers: { 'content-type': 'text/plain' } }),
      }),
    ).rejects.toThrow('PAYLOAD_CONTENT_TYPE_INVALID')
  })

  it.each([
    'https://localhost/credential.json',
    'https://service.local/credential.json',
    'https://service.internal/credential.json',
    'https://service.lan/credential.json',
    'https://127.0.0.1/credential.json',
    'https://[::1]/credential.json',
  ])('rejects local names and IP literals before browser fetch: %s', async (baseUrl) => {
    const fetchMock = vi.fn()
    const blockedUri = createHttpsPayloadUri(baseUrl, canonical)
    await expect(
      readCanonicalHttpsPayload({ credentialUri: blockedUri, fetchImpl: fetchMock }),
    ).rejects.toThrow('PILOT_PAYLOAD_HOST_REJECTED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects oversized declared and streamed bodies', async () => {
    await expect(
      readCanonicalHttpsPayload({
        credentialUri: uri,
        fetchImpl: async () =>
          jsonResponse(canonical, { 'content-length': String(MAX_PILOT_PAYLOAD_BYTES + 1) }),
      }),
    ).rejects.toThrow('PAYLOAD_TOO_LARGE')

    await expect(
      readCanonicalHttpsPayload({
        credentialUri: uri,
        fetchImpl: async () => jsonResponse(new Uint8Array(MAX_PILOT_PAYLOAD_BYTES + 1)),
      }),
    ).rejects.toThrow('PAYLOAD_TOO_LARGE')
  })

  it('rejects non-canonical JSON and digest tampering', async () => {
    const nonCanonical = '{ "claims": {"programId":"course-1"}}'
    const nonCanonicalUri = createHttpsPayloadUri(
      'https://issuer.example/noncanonical.json',
      nonCanonical,
    )
    await expect(
      readCanonicalHttpsPayload({
        credentialUri: nonCanonicalUri,
        fetchImpl: async () => jsonResponse(nonCanonical),
      }),
    ).rejects.toThrow('PAYLOAD_NOT_CANONICAL_JCS')

    const tampered = canonicalJson({ claims: { programId: 'course-2' } })
    await expect(
      readCanonicalHttpsPayload({
        credentialUri: uri,
        fetchImpl: async () => jsonResponse(tampered),
      }),
    ).rejects.toThrow('PAYLOAD_DIGEST_MISMATCH')
  })

  it('aborts a stalled request on timeout', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    await expect(
      readCanonicalHttpsPayload({ credentialUri: uri, fetchImpl: fetchMock, timeoutMs: 1 }),
    ).rejects.toThrow('PAYLOAD_FETCH_TIMEOUT')
  })

  it('reports a browser network or CORS rejection before publication can be trusted', async () => {
    const cause = new TypeError('Failed to fetch')

    await expect(
      verifyHttpsPayloadPublication({
        canonicalPayload: canonical,
        credentialUri: uri,
        fetchImpl: async () => {
          throw cause
        },
      }),
    ).rejects.toMatchObject({ message: 'PAYLOAD_FETCH_FAILED', cause })
  })
})
