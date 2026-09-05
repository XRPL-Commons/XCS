import { createIpfsPayloadUri } from '@xcs-protocol/core'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_ACCEPTED_FLAG,
  extractCredentialMutations,
} from '../src/credential-mutations.js'
import type { LedgerTransaction } from '../src/types.js'

const SCHEMA_UID = 'a'.repeat(64)
const OBJECT_ID = 'b'.repeat(64)
const TX_HASH = 'c'.repeat(64)
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'

function transaction(
  affectedNode: Record<string, unknown>,
  tx: Record<string, unknown> = {
    TransactionType: 'CredentialCreate',
    Account: ISSUER,
  },
  result = 'tesSUCCESS',
): LedgerTransaction {
  return {
    hash: TX_HASH,
    transaction: tx,
    metadata: { TransactionResult: result, AffectedNodes: [affectedNode] },
    transactionIndex: 0,
  }
}

function credentialFields(overrides: Record<string, unknown> = {}) {
  return {
    Issuer: ISSUER,
    Subject: SUBJECT,
    CredentialType: SCHEMA_UID.toUpperCase(),
    URI: Buffer.from(createIpfsPayloadUri('example'), 'utf8').toString('hex').toUpperCase(),
    Flags: 0,
    ...overrides,
  }
}

describe('extractCredentialMutations', () => {
  it('extracts a native Credential creation for a known XCS schema', () => {
    const result = extractCredentialMutations(
      transaction({
        CreatedNode: {
          LedgerEntryType: 'Credential',
          LedgerIndex: OBJECT_ID.toUpperCase(),
          NewFields: credentialFields(),
        },
      }),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result).toEqual({
      malformedCredentialNodes: 0,
      mutations: [
        expect.objectContaining({
          eventType: 'created',
          schemaUid: SCHEMA_UID,
          ledgerObjectId: OBJECT_ID,
          accepted: false,
        }),
      ],
    })
  })

  it('extracts acceptance from a ModifiedNode', () => {
    const result = extractCredentialMutations(
      transaction(
        {
          ModifiedNode: {
            LedgerEntryType: 'Credential',
            LedgerIndex: OBJECT_ID,
            PreviousFields: { Flags: 0 },
            FinalFields: credentialFields({ Flags: CREDENTIAL_ACCEPTED_FLAG }),
          },
        },
        { TransactionType: 'CredentialAccept', Account: SUBJECT },
      ),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result.mutations[0]).toMatchObject({
      eventType: 'accepted',
      accepted: true,
    })
  })

  it.each([
    [
      'gives AccountDelete precedence over actor, acceptance and expiration evidence',
      'AccountDelete',
      SUBJECT,
      { Flags: CREDENTIAL_ACCEPTED_FLAG, Expiration: 999 },
      'tecFAILED',
      'account_deleted',
    ],
    [
      'gives issuer revocation precedence for a self-issued expired Credential',
      'CredentialDelete',
      ISSUER,
      { Subject: ISSUER, Flags: CREDENTIAL_ACCEPTED_FLAG, Expiration: 999 },
      'tesSUCCESS',
      'issuer_revoked',
    ],
    [
      'classifies an unaccepted subject deletion before expired cleanup',
      'CredentialDelete',
      SUBJECT,
      { Expiration: 999 },
      'tesSUCCESS',
      'subject_rejected',
    ],
    [
      'classifies an accepted subject deletion before expired cleanup',
      'CredentialDelete',
      SUBJECT,
      { Flags: CREDENTIAL_ACCEPTED_FLAG, Expiration: 999 },
      'tesSUCCESS',
      'subject_removed',
    ],
    [
      'classifies expiration cleanup independently from transaction success',
      'CredentialAccept',
      SUBJECT,
      { Expiration: 999 },
      'tecEXPIRED',
      'expired_cleanup',
    ],
    [
      'falls back to self deletion without actor or reached-expiration evidence',
      'Payment',
      ISSUER,
      { Expiration: 1_001 },
      'tesSUCCESS',
      'self_deleted',
    ],
  ] as const)('%s', (_name, transactionType, actor, fieldOverrides, resultCode, expectedCause) => {
    const result = extractCredentialMutations(
      transaction(
        {
          DeletedNode: {
            LedgerEntryType: 'Credential',
            LedgerIndex: OBJECT_ID,
            FinalFields: credentialFields({ ...fieldOverrides }),
          },
        },
        { TransactionType: transactionType, Account: actor },
        resultCode,
      ),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result).toEqual({
      malformedCredentialNodes: 0,
      mutations: [
        expect.objectContaining({
          eventType: 'deleted',
          deletionCause: expectedCause,
        }),
      ],
    })
  })

  it('ignores native credentials whose type is not an indexed schema', () => {
    const result = extractCredentialMutations(
      transaction({
        CreatedNode: {
          LedgerEntryType: 'Credential',
          LedgerIndex: OBJECT_ID,
          NewFields: credentialFields(),
        },
      }),
      1_000,
      new Set(),
    )
    expect(result.mutations).toEqual([])
  })

  it('does not project a known schema as XCS without a supported integrity URI', () => {
    const result = extractCredentialMutations(
      transaction({
        CreatedNode: {
          LedgerEntryType: 'Credential',
          LedgerIndex: OBJECT_ID,
          NewFields: credentialFields({
            URI: Buffer.from('https://issuer.example/no-integrity-fragment', 'utf8').toString(
              'hex',
            ),
          }),
        },
      }),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result).toEqual({ mutations: [], malformedCredentialNodes: 1 })
  })

  it.each(['Flags', 'Expiration'] as const)(
    'rejects a Credential snapshot whose %s exceeds uint32',
    (field) => {
      const result = extractCredentialMutations(
        transaction({
          CreatedNode: {
            LedgerEntryType: 'Credential',
            LedgerIndex: OBJECT_ID,
            NewFields: credentialFields({ [field]: 0x1_0000_0000 }),
          },
        }),
        1_000,
        new Set([SCHEMA_UID]),
      )

      expect(result).toEqual({ mutations: [], malformedCredentialNodes: 1 })
    },
  )

  it('rejects an invalid previous Flags snapshot instead of inventing acceptance', () => {
    const result = extractCredentialMutations(
      transaction({
        ModifiedNode: {
          LedgerEntryType: 'Credential',
          LedgerIndex: OBJECT_ID,
          PreviousFields: { Flags: 0x1_0000_0000 },
          FinalFields: credentialFields({ Flags: CREDENTIAL_ACCEPTED_FLAG }),
        },
      }),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result).toEqual({ mutations: [], malformedCredentialNodes: 1 })
  })
})
