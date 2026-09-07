import {
  createHttpsPayloadUri,
  type CredentialPayload,
  type ResolvedSchema,
} from '@xcs-protocol/core'
import { buildCredentialAccept } from '@xcs-protocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  createIssuerTrustAcknowledgementToken,
  credentialActionBlockReason,
  loadCredentialReview,
} from '../app/utils/credentialReview'
import { toSanitizedOperationReceipt, type StoredOperation } from '../app/utils/operationJournal'
import { verifyHttpsPayloadPublication } from '../app/utils/payloadPublication'
import { canonicalJson, encodeHexUtf8 } from '../app/utils/serialization'

describe('pilot flow without a wallet extension', () => {
  it('proves publication, reviews a pending credential and builds an accept receipt', async () => {
    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    const subject = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
    const schemaUid = '12'.repeat(32)
    const generationId = '34'.repeat(32)
    const payload: CredentialPayload = {
      xcsVersion: '0.1',
      issuer,
      subject,
      schema: schemaUid,
      claims: { programId: 'course-1' },
    }
    const canonical = canonicalJson(payload)
    const uri = createHttpsPayloadUri('https://issuer.example/credential.json', canonical)
    const fetchImpl = async () =>
      new Response(canonical, { headers: { 'content-type': 'application/json' } })
    const proof = await verifyHttpsPayloadPublication({
      canonicalPayload: canonical,
      credentialUri: uri,
      fetchImpl,
    })
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
    const review = await loadCredentialReview({
      credential: {
        generationId,
        issuer,
        subject,
        schemaUid,
        uriHex: encodeHexUtf8(uri),
        expiration: null,
        accepted: false,
        state: 'pending',
      },
      report: {
        onChain: 'pending',
        schema: 'valid',
        payload: 'valid',
        issuerTrust: 'unknown',
        generationId,
      },
      issuer,
      subject,
      schemaUid,
      schema,
      fetchPayload: true,
      fetchImpl,
    })

    expect(credentialActionBlockReason(review, 'accept')).toBe(
      'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED',
    )
    expect(
      credentialActionBlockReason(
        review,
        'accept',
        createIssuerTrustAcknowledgementToken(review, 'xrpl-testnet-xcs-v0.1'),
        'xrpl-testnet-xcs-v0.1',
      ),
    ).toBeUndefined()
    expect(buildCredentialAccept({ issuer, subject, schemaUid })).toMatchObject({
      TransactionType: 'CredentialAccept',
      Account: subject,
      Issuer: issuer,
    })

    const operation: StoredOperation = {
      operationId: 'operation-1',
      account: subject,
      profileId: 'xrpl-testnet-xcs-v0.1',
      networkId: 1,
      transactionType: 'CredentialAccept',
      createdAt: '2026-08-19T12:00:00.000Z',
      updatedAt: '2026-08-19T12:01:00.000Z',
      stage: 'validated',
      txHash: 'AB'.repeat(32),
      ledgerIndex: 100,
      engineResult: 'tesSUCCESS',
      businessConfirmation: 'confirmed',
      businessEvidence: {
        transactionHash: 'AB'.repeat(32),
        ledgerIndex: 100,
        ledgerHash: 'CD'.repeat(32),
        transactionIndex: 1,
        schemaUid,
        generationId,
        eventType: 'accepted',
        accepted: true,
        deletionCause: null,
      },
      business: {
        action: 'credential-accept',
        issuer,
        subject,
        schemaUid,
        generationId,
        payloadDigestHex: proof.digestHex,
      },
    }
    expect(toSanitizedOperationReceipt(operation)).toMatchObject({
      stage: 'validated',
      businessConfirmation: 'confirmed',
      business: { action: 'credential-accept', issuer, subject, schemaUid, generationId },
      ledgerIndex: 100,
    })
  })
})
