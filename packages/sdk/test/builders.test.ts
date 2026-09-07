import { computeSchemaUid, createHttpsPayloadUri, encodeSchema } from '@xcs-protocol/core'
import { decode, encode, type Payment } from 'xrpl'
import { describe, expect, it } from 'vitest'

import {
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
  buildSchemaRegistrationPayment,
  credentialHexToUri,
  decodeMemoField,
  deriveSchemaUid,
  MAX_XRPL_MEMO_BYTES,
  measureSchemaRegistrationMemoBytes,
  schemaUidToCredentialType,
  XCS_SCHEMA_MEMO_FORMAT,
  XCS_SCHEMA_MEMO_TYPE,
  XcsSdkError,
} from '../src/index.js'

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const REGISTRY = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const UID = '12'.repeat(32)

const profile = {
  profileId: 'xrpl-testnet-xcs-v0.1',
  xcsVersion: '0.1' as const,
  networkId: 1,
  requiredAmendment: 'AB'.repeat(32),
  registryAddress: REGISTRY,
  registrationAmountDrops: '1' as const,
  activationLedgerIndex: 1,
  activationLedgerHash: 'CD'.repeat(32),
}

const schema = {
  xcsVersion: '0.1' as const,
  name: 'Course completion',
  description: 'Successful completion of an XRPL course.',
  fields: {
    programId: { type: 'string' as const },
    completedAt: { type: 'string' as const },
  },
}

function schemaAtMemoBoundary(descriptionBytes: number) {
  return {
    xcsVersion: '0.1' as const,
    name: 'S',
    description: 'd'.repeat(descriptionBytes),
    fields: Object.fromEntries(
      Array.from({ length: 28 }, (_, index) => [
        `f${String(index).padStart(2, '0')}`,
        { type: 'string' as const },
      ]),
    ),
  }
}

describe('schema transaction builders', () => {
  it('builds the exact one-drop registration payment with a canonical memo', () => {
    const built = buildSchemaRegistrationPayment({ publisher: ISSUER, profile, schema })
    const memo = built.transaction.Memos?.[0]?.Memo

    expect(built.transaction).toMatchObject({
      TransactionType: 'Payment',
      Account: ISSUER,
      Destination: REGISTRY,
      Amount: '1',
    })
    expect(decodeMemoField(memo?.MemoType ?? '')).toBe(XCS_SCHEMA_MEMO_TYPE)
    expect(decodeMemoField(memo?.MemoFormat ?? '')).toBe(XCS_SCHEMA_MEMO_FORMAT)
    expect(decodeMemoField(memo?.MemoData ?? '')).toBe(
      new TextDecoder().decode(encodeSchema(schema)),
    )
    expect(built.memoByteLength).toBe(measureSchemaRegistrationMemoBytes(built.canonicalSchema))
    expect(built.memoByteLength).toBeGreaterThan(
      new TextEncoder().encode(built.canonicalSchema).byteLength,
    )
    expect(built.transaction).not.toHaveProperty('Sequence')
    expect(built.transaction).not.toHaveProperty('SigningPubKey')
  })

  it('requires an explicitly validated registration context for UID derivation', () => {
    const context = {
      validated: true as const,
      transactionResult: 'tesSUCCESS' as const,
      networkId: 1,
      ledgerHash: '34'.repeat(32),
      ledgerIndex: 10,
      transactionIndex: 2,
      publisher: ISSUER,
    }

    expect(deriveSchemaUid(schema, context)).toBe(computeSchemaUid({ ...context, schema }))
    expect(() =>
      deriveSchemaUid(schema, {
        ...context,
        validated: false as true,
      }),
    ).toThrowError(XcsSdkError)
  })

  it('rejects a valid schema whose encoded memo content exceeds one KiB', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${index}`, { type: 'string' as const }]),
    )
    try {
      buildSchemaRegistrationPayment({
        publisher: ISSUER,
        profile,
        schema: { ...schema, fields },
      })
      throw new Error('Expected oversized memo to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(XcsSdkError)
      expect((error as XcsSdkError).code).toBe('XCS_SDK_MEMO_TOO_LARGE')
      expect((error as XcsSdkError).details?.byteLength).toBe(
        measureSchemaRegistrationMemoBytes(
          new TextDecoder().decode(encodeSchema({ ...schema, fields })),
        ),
      )
    }
  })

  it('matches rippled memo accounting at the exact 1,024-byte boundary', () => {
    const exactLimitSchema = schemaAtMemoBoundary(249)
    const exactLimitCanonical = new TextDecoder().decode(encodeSchema(exactLimitSchema))

    expect(measureSchemaRegistrationMemoBytes(exactLimitCanonical)).toBe(MAX_XRPL_MEMO_BYTES)

    const built = buildSchemaRegistrationPayment({
      publisher: ISSUER,
      profile,
      schema: exactLimitSchema,
    })
    const serializableTransaction: Payment = {
      ...built.transaction,
      Fee: '12',
      Sequence: 1,
      SigningPubKey: '',
    }
    const { Memos, ...transactionWithoutMemos } = serializableTransaction
    const encoded = encode(serializableTransaction)

    expect(decode(encoded)).toMatchObject({ Memos })
    expect((encoded.length - encode(transactionWithoutMemos).length) / 2).toBe(
      MAX_XRPL_MEMO_BYTES + 2,
    )

    const overLimitSchema = schemaAtMemoBoundary(250)
    const overLimitCanonical = new TextDecoder().decode(encodeSchema(overLimitSchema))
    expect(measureSchemaRegistrationMemoBytes(overLimitCanonical)).toBe(MAX_XRPL_MEMO_BYTES + 1)

    try {
      buildSchemaRegistrationPayment({ publisher: ISSUER, profile, schema: overLimitSchema })
      throw new Error('Expected a 1,025-byte memo to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(XcsSdkError)
      expect((error as XcsSdkError).code).toBe('XCS_SDK_MEMO_TOO_LARGE')
      expect((error as XcsSdkError).details).toMatchObject({
        byteLength: MAX_XRPL_MEMO_BYTES + 1,
        maxByteLength: MAX_XRPL_MEMO_BYTES,
      })
    }
  })
})

describe('credential transaction builders', () => {
  const uri = createHttpsPayloadUri('https://issuer.example/credential.json', '{}')

  it('builds CredentialCreate with hex fields and Ripple epoch expiration', () => {
    const transaction = buildCredentialCreate({
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      uri,
      expiration: '2030-01-01T00:00:00Z',
    })

    expect(transaction).toEqual({
      TransactionType: 'CredentialCreate',
      Account: ISSUER,
      Subject: SUBJECT,
      CredentialType: UID.toUpperCase(),
      URI: expect.any(String),
      Expiration: 946771200,
    })
    expect(credentialHexToUri(transaction.URI ?? '')).toBe(uri)
  })

  it('rejects expiration values that XRPL cannot serialize safely', () => {
    for (const expiration of [
      '2030-01-01T00:00:00.123Z',
      '2030-02-30T00:00:00Z',
      '1999-12-31T23:59:59Z',
      'not-a-date',
    ]) {
      expect(() =>
        buildCredentialCreate({
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: UID,
          uri,
          expiration,
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'XCS_SDK_INVALID_EXPIRATION',
        }),
      )
    }
  })

  it('builds subject acceptance and the three native deletion forms', () => {
    expect(buildCredentialAccept({ subject: SUBJECT, issuer: ISSUER, schemaUid: UID })).toEqual({
      TransactionType: 'CredentialAccept',
      Account: SUBJECT,
      Issuer: ISSUER,
      CredentialType: UID.toUpperCase(),
    })

    expect(
      buildCredentialDelete({ account: ISSUER, issuer: ISSUER, subject: SUBJECT, schemaUid: UID }),
    ).toMatchObject({ Account: ISSUER, Subject: SUBJECT })
    expect(
      buildCredentialDelete({ account: SUBJECT, issuer: ISSUER, subject: SUBJECT, schemaUid: UID }),
    ).toMatchObject({ Account: SUBJECT, Issuer: ISSUER })
    expect(
      buildCredentialDelete({
        account: REGISTRY,
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
      }),
    ).toMatchObject({ Account: REGISTRY, Issuer: ISSUER, Subject: SUBJECT })
    expect(
      buildCredentialDelete({ account: ISSUER, issuer: ISSUER, subject: ISSUER, schemaUid: UID }),
    ).toMatchObject({ Account: ISSUER, Subject: ISSUER })
  })

  it('rejects malformed UIDs, X-addresses, and URIs without integrity metadata', () => {
    expect(() => schemaUidToCredentialType('not-a-uid')).toThrowError(XcsSdkError)
    expect(() =>
      buildCredentialAccept({
        subject: 'XVLhHMPHU98es4dbozjVtdWzVrDjtV8pX8a',
        issuer: ISSUER,
        schemaUid: UID,
      }),
    ).toThrowError(XcsSdkError)
    expect(() =>
      buildCredentialCreate({
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        uri: 'https://issuer.example/credential.json',
      }),
    ).toThrow()
  })
})
