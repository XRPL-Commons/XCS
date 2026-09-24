import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, payloadDigest } from '#xcs/core/index.js'
import { readRecipientPayload } from '../app/utils/recipientPayload'
import { authReturnPath } from '../app/utils/authReturnPath'

const content = canonicalJson({ synthetic: 'private' })
const uri = `https://xcs.test/q/${'a'.repeat(18)}#xcs-sha256=${payloadDigest(content)}`

describe('private recipient payload transport', () => {
  it('reads canonical digest-checked bytes with same-origin cookies and no redirects/referrer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(content, {
          headers: { 'content-type': 'application/json', 'x-xcs-claim-scope': 'full' },
        }),
    )
    const result = await readRecipientPayload({ credentialUri: uri, fetchImpl }, 'https://xcs.test')
    expect(result.content).toBe(content)
    expect(fetchImpl).toHaveBeenCalledWith(
      uri.split('#')[0],
      expect.objectContaining({
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      }),
    )
  })
  it.each([
    uri.replace('xcs.test', 'external.test'),
    uri.replace('/q/', '/p/'),
    uri.replace('/q/', '/api/'),
    uri.replace('#', '?download=true#'),
    uri.replace('https:', 'http:'),
  ])('rejects non-managed locations before any request: %s', async (credentialUri) => {
    const fetchImpl = vi.fn()
    await expect(async () =>
      readRecipientPayload({ credentialUri, fetchImpl }, 'https://xcs.test'),
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('refuses filtered claims and altered canonical bytes', async () => {
    await expect(
      readRecipientPayload(
        {
          credentialUri: uri,
          fetchImpl: async () =>
            new Response(content, {
              headers: { 'content-type': 'application/json', 'x-xcs-claim-scope': 'public' },
            }),
        },
        'https://xcs.test',
      ),
    ).rejects.toThrow('PAYLOAD_SCOPE_RESTRICTED')
    await expect(
      readRecipientPayload(
        {
          credentialUri: uri,
          fetchImpl: async () =>
            new Response('{}', {
              headers: { 'content-type': 'application/json' },
            }),
        },
        'https://xcs.test',
      ),
    ).rejects.toThrow('PAYLOAD_DIGEST_MISMATCH')
  })
})

describe('authentication return destinations', () => {
  it.each(['/account', '/recipient/invitations', '/fr/presentations', '/verifier/apply'])(
    'accepts the fixed destination %s',
    (path) => expect(authReturnPath(path)).toBe(path),
  )
  it.each([
    'https://evil.test',
    '//evil.test',
    '/presentations#secret',
    '/account?next=//evil.test',
    '/fr//evil.test',
    ['//evil.test'],
    undefined,
  ])('rejects arbitrary or token-bearing return values', (path) =>
    expect(authReturnPath(path)).toBe('/account'),
  )
})
