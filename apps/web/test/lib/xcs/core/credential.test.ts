// Copied from packages/core/test/credential.test.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { describe, expect, it } from 'vitest'

import {
  createHttpsPayloadUri,
  createIpfsPayloadUri,
  encodeCredentialPayload,
  parseCredentialPayload,
  parsePayloadUri,
  verifyCredentialPayload,
  verifyPayloadIntegrity,
  type CredentialContext,
} from '#xcs/core/index.js'

const context: CredentialContext = {
  issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  subject: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn',
  schemaUid: 'ab'.repeat(32),
  fields: {
    courseId: { type: 'string' },
    passed: { type: 'bool' },
    score: { type: 'uint', optional: true },
  },
}

describe('credential payload', () => {
  it('encodes and parses a linked canonical payload', () => {
    const encoded = encodeCredentialPayload({ courseId: 'xcs-101', passed: true }, context)

    expect(parseCredentialPayload(encoded.bytes, context)).toEqual(encoded.payload)
    expect(encoded.json).toBe(new TextDecoder().decode(encoded.bytes))
    expect(() => parseCredentialPayload(`${encoded.json}\n`, context)).toThrow(
      expect.objectContaining({ code: 'NON_CANONICAL_JSON' }),
    )
  })

  it('uses maintained CID and SHA implementations for payload URIs', () => {
    const ipfs = createIpfsPayloadUri('hello')
    const https = createHttpsPayloadUri('https://issuer.example/credential.json', 'hello')

    expect(ipfs).toBe('ipfs://bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq')
    expect(parsePayloadUri(ipfs).kind).toBe('ipfs')
    expect(parsePayloadUri(https)).toMatchObject({
      kind: 'https',
      fetchUrl: 'https://issuer.example/credential.json',
    })
    expect(verifyPayloadIntegrity('hello', ipfs).valid).toBe(true)
    expect(verifyPayloadIntegrity('HELLO', ipfs).valid).toBe(false)
  })

  it('keeps unavailable, tampered, invalid, and valid distinct', () => {
    const encoded = encodeCredentialPayload({ courseId: 'xcs-101', passed: true }, context)
    const uri = createIpfsPayloadUri(encoded.bytes)

    expect(verifyCredentialPayload({ status: 'unavailable' }, uri, context)).toBe('unavailable')
    expect(
      verifyCredentialPayload({ status: 'retrieved', content: 'tampered' }, uri, context),
    ).toBe('tampered')
    expect(
      verifyCredentialPayload({ status: 'retrieved', content: encoded.bytes }, uri, context),
    ).toBe('valid')
  })

  it.each([{ courseId: '\ud800', passed: true }, { '\ud800': 'xcs-101' }])(
    'reports malformed Unicode in payload values or keys as invalid',
    (claims) => {
      const content = JSON.stringify({
        claims,
        issuer: context.issuer,
        schema: context.schemaUid,
        subject: context.subject,
        xcsVersion: '0.1',
      })
      const uri = createIpfsPayloadUri(content)

      expect(verifyCredentialPayload({ status: 'retrieved', content }, uri, context)).toBe(
        'invalid',
      )
    },
  )

  it('preserves valid Unicode including surrogate pairs', () => {
    const encoded = encodeCredentialPayload({ courseId: 'Cours réussi 🎓', passed: true }, context)

    expect(parseCredentialPayload(encoded.bytes, context).claims.courseId).toBe('Cours réussi 🎓')
  })
})
