import { describe, expect, it } from 'vitest'
import type { VerificationDimensions } from '../app/utils/credentialReview'
import {
  presentationHeadline,
  presentationTokenFromLink,
  presentationLink,
} from '../app/utils/presentationView'

const valid: VerificationDimensions = {
  onChain: 'active',
  schema: 'valid',
  payload: 'valid',
  issuerTrust: 'trusted',
}
const current = { usable: true, fresh: true }

describe('presentation verdict', () => {
  it('never reuses a successful report for revoked grants or stale evidence', () => {
    expect(presentationHeadline(valid, { ...current, usable: false })).toBe('unusable')
    expect(presentationHeadline(valid, { ...current, fresh: false })).toBe('unavailable')
    expect(presentationHeadline(null, current)).toBe('unavailable')
  })
  it.each([
    [{ onChain: 'pending' }, 'pending'],
    [{ onChain: 'not_found' }, 'notFound'],
    [{ onChain: 'expired' }, 'expired'],
    [{ onChain: 'deleted' }, 'deleted'],
    [{ schema: 'invalid' }, 'schemaInvalid'],
    [{ schema: 'unknown' }, 'schemaUnknown'],
    [{ payload: 'tampered' }, 'tampered'],
    [{ payload: 'invalid' }, 'contentInvalid'],
    [{ payload: 'unavailable' }, 'contentUnavailable'],
    [{ payload: 'not_checked' }, 'partial'],
    [{ issuerTrust: 'unknown' }, 'unknownIssuer'],
    [{ issuerTrust: 'untrusted' }, 'untrusted'],
    [{}, 'passed'],
  ] as [Partial<VerificationDimensions>, string][])(
    'displays %j distinctly',
    (changes, expected) => {
      expect(presentationHeadline({ ...valid, ...changes }, current)).toBe(expected)
    },
  )
  it('prioritizes known failures over unknown dimensions without hiding lifecycle failures', () => {
    expect(
      presentationHeadline({ ...valid, schema: 'unknown', payload: 'tampered' }, current),
    ).toBe('tampered')
    expect(
      presentationHeadline({ ...valid, schema: 'invalid', payload: 'tampered' }, current),
    ).toBe('schemaInvalid')
    expect(presentationHeadline({ ...valid, onChain: 'expired', schema: 'invalid' }, current)).toBe(
      'expired',
    )
    expect(
      presentationHeadline({ ...valid, payload: 'not_checked', issuerTrust: 'untrusted' }, current),
    ).toBe('untrusted')
  })
})

describe('share link', () => {
  const token = 'a'.repeat(43)
  it('keeps bearer in a fragment and respects the French route', () => {
    const link = new URL(presentationLink('https://portal.example', '/fr/presentations', token))
    expect(link.pathname).toBe('/fr/presentations')
    expect(link.search).toBe('')
    expect(link.hash).toBe(`#${token}`)
  })
  it('rejects foreign origins, arbitrary routes and malformed tokens', () => {
    expect(() =>
      presentationLink('https://portal.example', 'https://foreign.example/presentations', token),
    ).toThrow()
    expect(() => presentationLink('https://portal.example', '/p/locator', token)).toThrow()
    expect(() => presentationLink('https://portal.example', '/presentations', 'invalid')).toThrow()
  })
})

describe('received presentation link', () => {
  const token = 'x'.repeat(43)
  it('accepts complete English and French sharing links from this portal', () => {
    for (const path of ['/presentations', '/fr/presentations']) {
      expect(
        presentationTokenFromLink(
          'https://portal.example',
          ` https://portal.example${path}#${token} `,
        ),
      ).toBe(token)
    }
  })
  it.each([
    'https://foreign.example/presentations',
    'https://portal.example.evil.test/presentations',
    'http://portal.example/presentations',
    'https://user:password@portal.example/presentations',
    'https://portal.example/presentations?token=secret',
    'https://portal.example/p/locator',
    'javascript:alert(1)',
  ])('rejects foreign or unrelated links without fetching them: %s', (input) => {
    expect(() => presentationTokenFromLink('https://portal.example', `${input}#${token}`)).toThrow()
  })
  it('rejects bare references, missing and malformed fragments', () => {
    for (const input of [
      token,
      '/presentations',
      'https://portal.example/presentations',
      'https://portal.example/presentations#invalid',
    ]) {
      expect(() => presentationTokenFromLink('https://portal.example', input)).toThrow()
    }
  })
})
