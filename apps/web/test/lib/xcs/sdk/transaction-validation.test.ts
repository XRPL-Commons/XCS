// Copied from packages/sdk/test/transaction-validation.test.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { createHttpsPayloadUri, encodeSchema } from '#xcs/core/index.js'
import type { CredentialAccept, CredentialCreate, CredentialDelete, Payment } from 'xrpl'
import { describe, expect, it } from 'vitest'

import {
  assertXcsTransactionSemantics,
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
  buildSchemaRegistrationPayment,
  encodeMemoField,
} from '#xcs/sdk/index.js'

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const REGISTRY = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const X_ADDRESS = 'XVLhHMPHU98es4dbozjVtdWzVrDjtV8pX8a'
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

const payloadUri = createHttpsPayloadUri('https://issuer.example/credential.json', '{}')

function registration(): Payment {
  return buildSchemaRegistrationPayment({ publisher: ISSUER, profile, schema }).transaction
}

describe('assertXcsTransactionSemantics', () => {
  it('accepts all SDK builder transaction forms and returns their kind and schema UID', () => {
    expect(assertXcsTransactionSemantics(registration(), profile)).toMatchObject({
      kind: 'schema-registration',
      transactionType: 'Payment',
    })

    const create = buildCredentialCreate({
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      uri: payloadUri,
      expiration: '2030-01-01T00:00:00Z',
    })
    expect(assertXcsTransactionSemantics(create, profile)).toMatchObject({
      kind: 'credential-create',
      transactionType: 'CredentialCreate',
      schemaUid: UID,
    })

    const accept = buildCredentialAccept({ subject: SUBJECT, issuer: ISSUER, schemaUid: UID })
    expect(assertXcsTransactionSemantics(accept, profile)).toMatchObject({
      kind: 'credential-accept',
      transactionType: 'CredentialAccept',
      schemaUid: UID,
    })

    const deletionForms = [
      buildCredentialDelete({ account: ISSUER, issuer: ISSUER, subject: SUBJECT, schemaUid: UID }),
      buildCredentialDelete({ account: SUBJECT, issuer: ISSUER, subject: SUBJECT, schemaUid: UID }),
      buildCredentialDelete({
        account: REGISTRY,
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
      }),
    ]
    for (const deletion of deletionForms) {
      expect(assertXcsTransactionSemantics(deletion, profile)).toMatchObject({
        kind: 'credential-delete',
        transactionType: 'CredentialDelete',
        schemaUid: UID,
      })
    }
  })

  it('rejects an arbitrary payment and a registration bound to another registry', () => {
    const arbitrary: Payment = {
      TransactionType: 'Payment',
      Account: ISSUER,
      Destination: SUBJECT,
      Amount: '1',
    }
    expect(() => assertXcsTransactionSemantics(arbitrary, profile)).toThrow()

    expect(() =>
      assertXcsTransactionSemantics({ ...registration(), Destination: SUBJECT }, profile),
    ).toThrow()
  })

  it('rejects non-canonical schema JSON, a leading BOM, and partial-payment semantics', () => {
    const nonCanonical = JSON.stringify(schema)
    expect(nonCanonical).not.toBe(new TextDecoder().decode(encodeSchema(schema)))
    const withMemoData = (memoData: string): Payment => ({
      ...registration(),
      Memos: [
        {
          Memo: {
            ...registration().Memos?.[0]?.Memo,
            MemoData: memoData,
          },
        },
      ],
    })

    expect(() =>
      assertXcsTransactionSemantics(withMemoData(encodeMemoField(nonCanonical)), profile),
    ).toThrow()
    expect(() =>
      assertXcsTransactionSemantics(
        withMemoData(`EFBBBF${registration().Memos?.[0]?.Memo.MemoData ?? ''}`),
        profile,
      ),
    ).toThrow()
    expect(() =>
      assertXcsTransactionSemantics({ ...registration(), Flags: 0x0002_0000 }, profile),
    ).toThrow()
    expect(() =>
      assertXcsTransactionSemantics(
        { ...registration(), Flags: { tfPartialPayment: true } },
        profile,
      ),
    ).toThrow()
  })

  it('rejects malformed credential types, payload URIs, expirations, and addresses', () => {
    const create = buildCredentialCreate({
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      uri: payloadUri,
    })
    expect(() =>
      assertXcsTransactionSemantics({ ...create, CredentialType: 'AA' }, profile),
    ).toThrow()
    expect(() =>
      assertXcsTransactionSemantics(
        { ...create, URI: encodeMemoField('https://issuer.example/credential.json') },
        profile,
      ),
    ).toThrow()
    expect(() => assertXcsTransactionSemantics({ ...create, Expiration: 1.5 }, profile)).toThrow()
    expect(() =>
      assertXcsTransactionSemantics({ ...create, Subject: X_ADDRESS }, profile),
    ).toThrow()

    const accept: CredentialAccept = {
      ...buildCredentialAccept({ subject: SUBJECT, issuer: ISSUER, schemaUid: UID }),
      Issuer: X_ADDRESS,
    }
    expect(() => assertXcsTransactionSemantics(accept, profile)).toThrow()

    const deletion: CredentialDelete = {
      ...buildCredentialDelete({
        account: ISSUER,
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
      }),
      Subject: X_ADDRESS,
    }
    expect(() => assertXcsTransactionSemantics(deletion, profile)).toThrow()
  })

  it('requires CredentialCreate URI and at least one CredentialDelete counterpart', () => {
    const withoutUri: CredentialCreate = {
      TransactionType: 'CredentialCreate',
      Account: ISSUER,
      Subject: SUBJECT,
      CredentialType: UID.toUpperCase(),
    }
    expect(() => assertXcsTransactionSemantics(withoutUri, profile)).toThrow()

    const incompleteDelete = {
      TransactionType: 'CredentialDelete',
      Account: ISSUER,
      CredentialType: UID.toUpperCase(),
    }
    expect(() => assertXcsTransactionSemantics(incompleteDelete, profile)).toThrow()
  })
})
