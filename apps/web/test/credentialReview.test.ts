import {
  createHttpsPayloadUri,
  type CredentialPayload,
  type ResolvedSchema,
} from '@xcs-protocol/core'
import { describe, expect, it, vi } from 'vitest'

import {
  assertCredentialAcceptanceReviewCurrent,
  assertCredentialGenerationCurrent,
  assertCredentialSubjectMutationReviewCurrent,
  credentialActionBlockReason,
  credentialRevocationBlockReason,
  createIssuerTrustAcknowledgementToken,
  createPayloadFetchConsentToken,
  inspectCredentialOperationEvent,
  loadCredentialMutationReview,
  loadCredentialReview,
  loadCredentialReviewWithConsent,
  parseApiCredentialDetail,
  waitForCredentialOperationEvent,
} from '../app/utils/credentialReview'
import { canonicalJson, encodeHexUtf8 } from '../app/utils/serialization'

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const UID = '12'.repeat(32)
const GENERATION = '34'.repeat(32)
const schema: ResolvedSchema = {
  definition: {
    xcsVersion: '0.1',
    name: 'Completion',
    description: 'Course completion',
    fields: { programId: { type: 'string' } },
  },
  fields: { programId: { type: 'string' } },
  lineage: [],
}
const payload: CredentialPayload = {
  xcsVersion: '0.1',
  issuer: ISSUER,
  subject: SUBJECT,
  schema: UID,
  claims: { programId: 'course-1' },
}
const canonical = canonicalJson(payload)
const uri = createHttpsPayloadUri('https://issuer.example/credentials/one.json', canonical)
const credential = {
  generationId: GENERATION,
  issuer: ISSUER,
  subject: SUBJECT,
  schemaUid: UID,
  uriHex: encodeHexUtf8(uri),
  expiration: null,
  accepted: false,
  state: 'pending',
}
const report = {
  onChain: 'pending',
  schema: 'valid',
  payload: 'valid',
  issuerTrust: 'trusted',
  generationId: GENERATION,
}

describe('exact credential review', () => {
  it('loads the exact HTTPS payload and permits a fully valid trusted acceptance', async () => {
    const review = await loadCredentialReview({
      credential,
      report,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchPayload: true,
      fetchImpl: async () =>
        new Response(canonical, { headers: { 'content-type': 'application/json' } }),
    })

    expect(review).toMatchObject({
      generationId: GENERATION,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      uri,
      claims: { programId: 'course-1' },
    })
    expect(credentialActionBlockReason(review, 'accept')).toBeUndefined()
  })

  it('blocks acceptance unless every gate is valid and trusted', async () => {
    const review = await loadCredentialReview({
      credential,
      report: { ...report, issuerTrust: 'untrusted' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchPayload: true,
      fetchImpl: async () =>
        new Response(canonical, { headers: { 'content-type': 'application/json' } }),
    })

    expect(credentialActionBlockReason(review, 'accept')).toBe('CREDENTIAL_ISSUER_NOT_TRUSTED')
  })

  it('requires a generation-bound subject acknowledgement for an unknown issuer', async () => {
    const review = await loadCredentialReview({
      credential,
      report: { ...report, issuerTrust: 'unknown' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchPayload: true,
      fetchImpl: async () =>
        new Response(canonical, { headers: { 'content-type': 'application/json' } }),
    })

    expect(credentialActionBlockReason(review, 'accept')).toBe(
      'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED',
    )
    const acknowledgement = createIssuerTrustAcknowledgementToken(review, 'profile-a')
    expect(acknowledgement).toEqual({
      profileId: 'profile-a',
      issuer: ISSUER,
      subject: SUBJECT,
      generationId: GENERATION,
      issuerTrust: 'unknown',
    })
    expect(
      credentialActionBlockReason(review, 'accept', acknowledgement, 'profile-a'),
    ).toBeUndefined()
  })

  it('invalidates an unknown-issuer acknowledgement when issuer, generation or trust changes', async () => {
    const review = await loadCredentialReview({
      credential,
      report: { ...report, issuerTrust: 'unknown' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchPayload: true,
      fetchImpl: async () =>
        new Response(canonical, { headers: { 'content-type': 'application/json' } }),
    })
    const acknowledgement = createIssuerTrustAcknowledgementToken(review, 'profile-a')

    expect(
      credentialActionBlockReason(
        { ...review, generationId: '56'.repeat(32) },
        'accept',
        acknowledgement,
        'profile-a',
      ),
    ).toBe('CREDENTIAL_ISSUER_TRUST_ACK_STALE')
    expect(
      credentialActionBlockReason(
        { ...review, issuer: SUBJECT },
        'accept',
        acknowledgement,
        'profile-a',
      ),
    ).toBe('CREDENTIAL_ISSUER_TRUST_ACK_STALE')
    expect(
      credentialActionBlockReason(
        { ...review, subject: ISSUER },
        'accept',
        acknowledgement,
        'profile-a',
      ),
    ).toBe('CREDENTIAL_ISSUER_TRUST_ACK_STALE')
    expect(credentialActionBlockReason(review, 'accept', acknowledgement, 'profile-b')).toBe(
      'CREDENTIAL_ISSUER_TRUST_ACK_STALE',
    )
    expect(
      credentialActionBlockReason(
        { ...review, report: { ...review.report, issuerTrust: 'trusted' } },
        'accept',
        acknowledgement,
        'profile-a',
      ),
    ).toBe('CREDENTIAL_ISSUER_TRUST_ACK_STALE')
    expect(
      credentialActionBlockReason(
        { ...review, report: { ...review.report, issuerTrust: 'untrusted' } },
        'accept',
        acknowledgement,
        'profile-a',
      ),
    ).toBe('CREDENTIAL_ISSUER_NOT_TRUSTED')
    expect(
      credentialActionBlockReason(
        { ...review, report: { ...review.report, issuerTrust: 'trusted' } },
        'accept',
      ),
    ).toBeUndefined()
  })

  it('rejects a trust or profile change observed after the wallet returns', async () => {
    const review = await loadCredentialReview({
      credential,
      report: { ...report, issuerTrust: 'unknown' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchPayload: true,
      fetchImpl: async () =>
        new Response(canonical, { headers: { 'content-type': 'application/json' } }),
    })
    const acknowledgement = createIssuerTrustAcknowledgementToken(review, 'profile-a')

    expect(() =>
      assertCredentialAcceptanceReviewCurrent(
        review,
        { ...review, report: { ...review.report, issuerTrust: 'untrusted' } },
        'profile-a',
        'profile-a',
        acknowledgement,
      ),
    ).toThrow('CREDENTIAL_ISSUER_TRUST_CHANGED_AFTER_SIGNATURE')
    expect(() =>
      assertCredentialAcceptanceReviewCurrent(
        review,
        review,
        'profile-a',
        'profile-b',
        acknowledgement,
      ),
    ).toThrow('NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE')
  })

  it('keeps a pending credential rejectable when its payload cannot be reviewed', async () => {
    const fetchImpl = vi.fn()
    const review = await loadCredentialReview({
      credential,
      report: { ...report, payload: 'tampered' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchImpl,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(credentialActionBlockReason(review, 'reject')).toBeUndefined()
    expect(credentialActionBlockReason(review, 'accept')).toBe('CREDENTIAL_PAYLOAD_REVIEW_FAILED')
  })

  it('loads URI metadata without contacting the issuer before consent', async () => {
    const fetchImpl = vi.fn()
    const review = await loadCredentialReview({
      credential,
      report: { ...report, payload: 'not_checked' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
      fetchImpl,
    })

    expect(review).toMatchObject({ uri, generationId: GENERATION })
    expect(review).not.toHaveProperty('claims')
    expect(review).not.toHaveProperty('payload')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never fetches a replacement URI that was not covered by the displayed consent', async () => {
    const metadataReview = await loadCredentialReview({
      credential,
      report: { ...report, payload: 'not_checked' },
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      schema,
    })
    const consent = createPayloadFetchConsentToken(metadataReview)
    const replacementCanonical = canonicalJson({
      ...payload,
      claims: { programId: 'replacement' },
    })
    const replacementUri = createHttpsPayloadUri(
      'https://replacement.example/credentials/two.json',
      replacementCanonical,
    )
    const fetchReplacement = vi.fn(async () =>
      Promise.resolve(
        new Response(replacementCanonical, { headers: { 'content-type': 'application/json' } }),
      ),
    )

    await expect(
      loadCredentialReviewWithConsent({
        credential: {
          ...credential,
          generationId: '56'.repeat(32),
          uriHex: encodeHexUtf8(replacementUri),
        },
        report: {
          ...report,
          generationId: '56'.repeat(32),
          payload: 'not_checked',
        },
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        schema,
        consent,
        fetchImpl: fetchReplacement,
      }),
    ).rejects.toThrow('CREDENTIAL_PAYLOAD_CONSENT_STALE')
    expect(fetchReplacement).not.toHaveBeenCalled()
  })

  it('rejects tuple and generation mismatches before an action is prepared', async () => {
    await expect(
      loadCredentialReview({
        credential: { ...credential, subject: ISSUER },
        report,
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        schema,
      }),
    ).rejects.toThrow('CREDENTIAL_EXACT_LOOKUP_MISMATCH')
    await expect(
      loadCredentialReview({
        credential,
        report: { ...report, generationId: '56'.repeat(32) },
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        schema,
      }),
    ).rejects.toThrow('CREDENTIAL_REVIEW_GENERATION_MISMATCH')
  })

  it('allows issuer revocation only while the exact generation still exists', () => {
    const exact = parseApiCredentialDetail(credential, {
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
    })
    expect(credentialRevocationBlockReason(exact)).toBeUndefined()
    expect(credentialRevocationBlockReason({ ...exact, state: 'deleted' })).toBe(
      'CREDENTIAL_ALREADY_DELETED',
    )
  })

  it('routes expired subject actions by the normative accepted flag', () => {
    const active = loadCredentialMutationReview(
      { ...credential, accepted: true, state: 'active' },
      { issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    )
    const expired = { ...active, state: 'expired' as const }
    const expiredUnaccepted = { ...expired, accepted: false }

    expect(credentialActionBlockReason(active, 'remove')).toBeUndefined()
    expect(credentialActionBlockReason(expired, 'remove')).toBeUndefined()
    expect(credentialActionBlockReason({ ...active, state: 'pending' }, 'remove')).toBe(
      'CREDENTIAL_MUST_BE_ACTIVE_OR_EXPIRED_ACCEPTED',
    )
    expect(credentialActionBlockReason(expiredUnaccepted, 'reject')).toBeUndefined()
    expect(credentialActionBlockReason(expiredUnaccepted, 'remove')).toBe(
      'CREDENTIAL_MUST_BE_ACTIVE_OR_EXPIRED_ACCEPTED',
    )
    expect(credentialActionBlockReason(expired, 'reject')).toBe(
      'CREDENTIAL_MUST_BE_PENDING_OR_EXPIRED_UNACCEPTED',
    )
  })

  it('rechecks tuple, profile, generation, state and accepted flag after subject signing', () => {
    const expected = loadCredentialMutationReview(
      { ...credential, accepted: true, state: 'active' },
      { issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    )

    expect(() =>
      assertCredentialSubjectMutationReviewCurrent(
        expected,
        { ...expected },
        'profile-a',
        'profile-a',
        'remove',
      ),
    ).not.toThrow()
    expect(() =>
      assertCredentialSubjectMutationReviewCurrent(
        expected,
        { ...expected, state: 'expired' },
        'profile-a',
        'profile-a',
        'remove',
      ),
    ).toThrow('CREDENTIAL_STATE_CHANGED_AFTER_SIGNATURE')
    expect(() =>
      assertCredentialSubjectMutationReviewCurrent(
        expected,
        { ...expected, accepted: false },
        'profile-a',
        'profile-a',
        'remove',
      ),
    ).toThrow('CREDENTIAL_STATE_CHANGED_AFTER_SIGNATURE')
    expect(() =>
      assertCredentialSubjectMutationReviewCurrent(
        expected,
        expected,
        'profile-a',
        'profile-b',
        'remove',
      ),
    ).toThrow('NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE')
  })

  it('rechecks the exact generation and action state after wallet signing', () => {
    const expected = {
      action: 'credential-accept' as const,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      generationId: GENERATION,
    }
    expect(() => assertCredentialGenerationCurrent(credential, expected)).not.toThrow()
    expect(() =>
      assertCredentialGenerationCurrent({ ...credential, generationId: '56'.repeat(32) }, expected),
    ).toThrow('CREDENTIAL_GENERATION_CHANGED_AFTER_SIGNATURE')
    expect(() =>
      assertCredentialGenerationCurrent(
        { ...credential, accepted: true, state: 'expired' },
        { ...expected, action: 'credential-remove' },
      ),
    ).not.toThrow()
    expect(() =>
      assertCredentialGenerationCurrent(
        { ...credential, accepted: false, state: 'expired' },
        { ...expected, action: 'credential-reject' },
      ),
    ).not.toThrow()
  })

  it('confirms only an event matching hash, generation and mutation type', () => {
    const expected = {
      action: 'credential-reject' as const,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      generationId: GENERATION,
      txHash: 'AB'.repeat(32),
    }
    expect(
      inspectCredentialOperationEvent(
        {
          transactionHash: expected.txHash.toLowerCase(),
          event: {
            transactionHash: expected.txHash.toLowerCase(),
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: UID,
            generationId: GENERATION,
            eventType: 'deleted',
            accepted: false,
            deletionCause: 'subject_rejected',
          },
        },
        expected,
      ),
    ).toBe('confirmed')
    expect(
      inspectCredentialOperationEvent(
        {
          transactionHash: expected.txHash,
          event: {
            transactionHash: expected.txHash,
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: UID,
            generationId: GENERATION,
            eventType: 'deleted',
            accepted: true,
            deletionCause: 'subject_rejected',
          },
        },
        expected,
      ),
    ).toBe('mismatch')
    expect(
      inspectCredentialOperationEvent(
        {
          transactionHash: expected.txHash,
          event: {
            transactionHash: expected.txHash,
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: UID,
            generationId: '56'.repeat(32),
            eventType: 'deleted',
            accepted: false,
            deletionCause: 'subject_rejected',
          },
        },
        expected,
      ),
    ).toBe('mismatch')
    expect(
      inspectCredentialOperationEvent(
        {
          transactionHash: expected.txHash,
          event: {
            transactionHash: expected.txHash,
            issuer: SUBJECT,
            subject: SUBJECT,
            schemaUid: UID,
            generationId: GENERATION,
            eventType: 'deleted',
            accepted: false,
            deletionCause: 'subject_rejected',
          },
        },
        expected,
      ),
    ).toBe('mismatch')
    expect(() =>
      inspectCredentialOperationEvent({ transactionHash: 'CD'.repeat(32), event: null }, expected),
    ).toThrow('CREDENTIAL_EVENT_RESPONSE_INVALID')

    expect(
      inspectCredentialOperationEvent(
        {
          transactionHash: expected.txHash,
          event: {
            transactionHash: expected.txHash,
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: UID,
            generationId: GENERATION,
            eventType: 'accepted',
            accepted: false,
            deletionCause: null,
          },
        },
        { ...expected, action: 'credential-accept' },
      ),
    ).toBe('mismatch')
  })

  it('confirms subject removal only with the projected exact deletion cause', () => {
    const expected = {
      action: 'credential-remove' as const,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      generationId: GENERATION,
      txHash: 'AB'.repeat(32),
    }
    const response = {
      transactionHash: expected.txHash,
      event: {
        transactionHash: expected.txHash,
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        generationId: GENERATION,
        eventType: 'deleted',
        accepted: true,
        deletionCause: 'subject_removed',
      },
    }

    expect(inspectCredentialOperationEvent(response, expected)).toBe('confirmed')
    expect(
      inspectCredentialOperationEvent(
        { ...response, event: { ...response.event, deletionCause: 'issuer_revoked' } },
        expected,
      ),
    ).toBe('mismatch')
    expect(
      inspectCredentialOperationEvent(
        {
          ...response,
          event: { ...response.event, issuer: SUBJECT, deletionCause: 'issuer_revoked' },
        },
        { ...expected, issuer: SUBJECT },
      ),
    ).toBe('confirmed')
  })

  it('bounds indexer event reconciliation instead of reporting success indefinitely', async () => {
    vi.useFakeTimers()
    try {
      const confirmation = waitForCredentialOperationEvent({
        action: 'credential-accept',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        generationId: GENERATION,
        txHash: 'AB'.repeat(32),
        loadEvent: async () => ({ transactionHash: 'AB'.repeat(32), event: null }),
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      })
      const expectedTimeout = expect(confirmation).rejects.toThrow(
        'CREDENTIAL_EVENT_CONFIRMATION_TIMEOUT',
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await expectedTimeout
    } finally {
      vi.useRealTimers()
    }
  })
})
