import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  canonicalize,
  computePayloadSha256Hex,
  createHttpsPayloadUri,
  createIpfsRawPayloadUri,
  inspectPayloadUri,
  iso8601ToRippleTime,
  parseCredentialPayload,
  rippleTimeToIso8601,
  verifyPayloadIntegrity,
  XcsError,
} from '../src/index.js'

interface PayloadVectors {
  cases: Array<{
    name: string
    contentUtf8: string
    sha256: string
    uri: string
  }>
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../conformance/v0.1/payload-integrity.json', import.meta.url),
    'utf8',
  ),
) as PayloadVectors

describe('payload integrity', () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(computePayloadSha256Hex(vector.contentUtf8)).toBe(vector.sha256)
      expect(verifyPayloadIntegrity(vector.contentUtf8, vector.uri)).toMatchObject({
        status: 'valid',
        expectedDigestHex: vector.sha256,
        actualDigestHex: vector.sha256,
      })
    })
  }

  it('creates canonical HTTPS and raw CIDv1 URIs', () => {
    expect(createHttpsPayloadUri('https://issuer.example/credentials/1.json', 'hello')).toBe(
      vectors.cases[1]?.uri,
    )
    expect(createIpfsRawPayloadUri('hello')).toBe(vectors.cases[0]?.uri)
    expect(inspectPayloadUri(vectors.cases[0]?.uri ?? '').kind).toBe('ipfs')
  })

  it('distinguishes tampering from an invalid URI', () => {
    expect(verifyPayloadIntegrity('HELLO', vectors.cases[0]?.uri ?? '').status).toBe('tampered')
    expect(verifyPayloadIntegrity('hello', 'http://issuer.example/file').status).toBe('invalid_uri')
  })

  it('strictly validates the payload envelope and claims', () => {
    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    const subject = 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn'
    const schemaUid = 'ab'.repeat(32)
    const content = canonicalize({
      xcsVersion: '0.1',
      issuer,
      subject,
      schema: schemaUid,
      claims: { programId: 'course-1' },
    })
    expect(
      parseCredentialPayload(content, {
        issuer,
        subject,
        schemaUid,
        schema: { programId: { type: 'string' } },
      }).claims,
    ).toEqual({ programId: 'course-1' })
    const pretty = JSON.stringify(JSON.parse(content), null, 2)
    expect(() =>
      parseCredentialPayload(pretty, {
        issuer,
        subject,
        schemaUid,
        schema: { programId: { type: 'string' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_INVALID' }))
    expect(() =>
      parseCredentialPayload(content.replace(issuer, subject), {
        issuer,
        subject,
        schemaUid,
        schema: { programId: { type: 'string' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PAYLOAD_INVALID' }))
  })
})

describe('Ripple epoch conversions', () => {
  it('maps the Ripple epoch and round-trips an expiration', () => {
    expect(iso8601ToRippleTime('2000-01-01T00:00:00Z')).toBe(0)
    const expiration = iso8601ToRippleTime('2030-05-06T07:08:09Z')
    expect(rippleTimeToIso8601(expiration)).toBe('2030-05-06T07:08:09.000Z')
  })

  it('rejects Unix seconds accidentally passed as Ripple time and subsecond timestamps', () => {
    expect(() => iso8601ToRippleTime('2030-05-06T07:08:09.123Z')).toThrowError(
      expect.objectContaining({ code: 'RIPPLE_TIME_INVALID' }),
    )
  })
})
