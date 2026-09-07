import type { CredentialPayload, ResolvedSchema } from '@xcs-protocol/core'
import { describe, expect, it } from 'vitest'

import {
  assertExactCredentialConsentCurrent,
  bindCurrentReportToExactCredential,
  credentialClaimsToRows,
} from '../app/utils/credentialEvidence'
import {
  createPayloadFetchConsentToken,
  type CredentialReview,
} from '../app/utils/credentialReview'
import { encodeHexUtf8 } from '../app/utils/serialization'

const schema: ResolvedSchema = {
  definition: {
    xcsVersion: '0.1',
    name: 'Diploma Award',
    description: 'Attests that the subject was awarded a diploma.',
    fields: {
      programName: { type: 'string' },
      awardedAt: { type: 'string' },
      diplomaId: { type: 'string' },
      honors: { type: 'string', optional: true },
      evidence: {
        type: 'object',
        optional: true,
        fields: {
          verified: { type: 'bool' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  fields: {
    programName: { type: 'string' },
    awardedAt: { type: 'string' },
    diplomaId: { type: 'string' },
    honors: { type: 'string', optional: true },
    evidence: {
      type: 'object',
      optional: true,
      fields: { verified: { type: 'bool' }, sources: { type: 'array', items: { type: 'string' } } },
    },
  },
  lineage: [],
}

const review: CredentialReview = {
  generationId: '34'.repeat(32),
  issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
  schemaUid: '12'.repeat(32),
  uri: `https://issuer.example/diploma.json#xcs-sha256=${'ab'.repeat(32)}`,
  expiration: null,
  accepted: true,
  state: 'active',
  report: {
    onChain: 'active',
    schema: 'valid',
    payload: 'not_checked',
    issuerTrust: 'unknown',
    generationId: '34'.repeat(32),
  },
}

describe('exact Credential evidence', () => {
  it('renders generic claims in resolved schema order with typed structured values', () => {
    const claims: CredentialPayload['claims'] = {
      evidence: { sources: ['registry', 'school'], verified: true },
      diplomaId: 'DIP-2026-0042',
      awardedAt: '2026-08-25T10:00:00Z',
      programName: 'Protocol Engineering',
    }

    const rows = credentialClaimsToRows(schema, claims)

    expect(rows.map((row) => row.name)).toEqual([
      'programName',
      'awardedAt',
      'diplomaId',
      'honors',
      'evidence',
    ])
    expect(rows[0]).toMatchObject({ type: 'string', present: true, structured: false })
    expect(rows[3]).toMatchObject({ present: false, displayValue: '—' })
    expect(rows[4]).toMatchObject({ type: 'object', present: true, structured: true })
    expect(rows[4]?.displayValue).toContain('"verified": true')
  })

  it('fails closed if claims contain a field outside the resolved schema', () => {
    expect(() =>
      credentialClaimsToRows(schema, { programName: 'XCS', injected: '<script>' }),
    ).toThrow('CREDENTIAL_CLAIM_SCHEMA_MISMATCH:injected')
  })

  it('invalidates consent when profile, tuple, generation or URI changes before fetch', () => {
    const consent = createPayloadFetchConsentToken(review)
    expect(() =>
      assertExactCredentialConsentCurrent({
        displayed: review,
        displayedProfileId: 'profile-a',
        latest: { ...review },
        latestProfileId: 'profile-a',
        consent,
      }),
    ).not.toThrow()

    for (const latest of [
      { ...review, generationId: '56'.repeat(32) },
      { ...review, issuer: review.subject },
      { ...review, subject: review.issuer },
      { ...review, schemaUid: '78'.repeat(32) },
      {
        ...review,
        uri: `https://replacement.example/diploma.json#xcs-sha256=${'cd'.repeat(32)}`,
      },
    ]) {
      expect(() =>
        assertExactCredentialConsentCurrent({
          displayed: review,
          displayedProfileId: 'profile-a',
          latest,
          latestProfileId: 'profile-a',
          consent,
        }),
      ).toThrow('CREDENTIAL_PAYLOAD_CONSENT_STALE')
    }

    expect(() =>
      assertExactCredentialConsentCurrent({
        displayed: review,
        displayedProfileId: 'profile-a',
        latest: review,
        latestProfileId: 'profile-b',
        consent,
      }),
    ).toThrow('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  })

  it('keeps deleted exact evidence readable but refuses a replacement generation report', async () => {
    const credential = {
      generationId: review.generationId,
      issuer: review.issuer,
      subject: review.subject,
      schemaUid: review.schemaUid,
      uriHex: encodeHexUtf8(review.uri!),
      expiration: null,
      accepted: true,
      state: 'deleted',
    }
    const input = {
      credential,
      issuer: review.issuer,
      subject: review.subject,
      schemaUid: review.schemaUid,
      schema,
    }

    await expect(
      bindCurrentReportToExactCredential({
        ...input,
        report: {
          onChain: 'deleted',
          schema: 'valid',
          payload: 'not_checked',
          issuerTrust: 'unknown',
          generationId: review.generationId,
        },
      }),
    ).resolves.toMatchObject({ generationId: review.generationId, state: 'deleted' })

    await expect(
      bindCurrentReportToExactCredential({
        ...input,
        report: {
          onChain: 'active',
          schema: 'valid',
          payload: 'not_checked',
          issuerTrust: 'unknown',
          generationId: '56'.repeat(32),
        },
      }),
    ).resolves.toBeNull()
    await expect(
      bindCurrentReportToExactCredential({
        ...input,
        report: {
          onChain: 'deleted',
          schema: 'valid',
          payload: 'not_checked',
          issuerTrust: 'unknown',
          generationId: '56'.repeat(32),
        },
      }),
    ).resolves.toBeNull()
    await expect(
      bindCurrentReportToExactCredential({
        ...input,
        report: {
          onChain: 'not_found',
          schema: 'valid',
          payload: 'not_checked',
          issuerTrust: 'unknown',
        },
      }),
    ).resolves.toBeNull()
  })
})
