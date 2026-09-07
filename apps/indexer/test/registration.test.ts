import type { JsonValue } from '@xcs-protocol/core'
import { describe, expect, it } from 'vitest'

import { interpretSchemaRegistration } from '../src/registration.js'
import { canonicalJson } from '../src/serialization.js'
import { normalizeLedgerResponse } from '../src/xrpl-source.js'
import type { LedgerTransaction, NetworkProfile, SchemaDefinition } from '../src/types.js'

const REGISTRY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const PUBLISHER = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const HASH = 'a'.repeat(64)
const AMENDMENT = 'b'.repeat(64)

const profile: NetworkProfile = {
  profileId: 'test',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: AMENDMENT,
  registryAddress: REGISTRY,
  registrationAmountDrops: '1',
  activationLedgerIndex: 100,
  activationLedgerHash: HASH,
}

const schema: SchemaDefinition = {
  xcsVersion: '0.1',
  name: 'Course completion',
  description: 'A compact completion attestation.',
  fields: {
    programId: { type: 'string' },
    completedAt: { type: 'string' },
  },
}

function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex').toUpperCase()
}

function payment(
  overrides: Record<string, unknown> = {},
  memoJson: JsonValue = schema as unknown as JsonValue,
): LedgerTransaction {
  return {
    hash: 'c'.repeat(64),
    transactionIndex: 0,
    transaction: {
      TransactionType: 'Payment',
      Account: PUBLISHER,
      Destination: REGISTRY,
      Amount: '1',
      Memos: [
        {
          Memo: {
            MemoType: hex('xcs:schema_register'),
            MemoFormat: hex('application/json'),
            MemoData: hex(canonicalJson(memoJson)),
          },
        },
      ],
      ...overrides,
    },
    metadata: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
  }
}

function apiV2Payment(): LedgerTransaction {
  const candidate = payment()
  delete candidate.transaction.Amount
  candidate.transaction.DeliverMax = '1'
  const normalized = normalizeLedgerResponse({
    validated: true,
    ledger_hash: HASH,
    ledger_index: 100,
    ledger: {
      account_hash: 'd'.repeat(64),
      close_flags: 0,
      close_time: 500,
      close_time_resolution: 10,
      closed: true,
      ledger_hash: HASH,
      ledger_index: 100,
      parent_close_time: 490,
      parent_hash: 'e'.repeat(64),
      total_coins: '99999999999999999',
      transaction_hash: 'f'.repeat(64),
      transactions: [
        {
          hash: candidate.hash,
          tx_json: candidate.transaction,
          meta: {
            ...candidate.metadata,
            TransactionIndex: candidate.transactionIndex,
          },
        },
      ],
    },
  }).transactions[0]
  if (normalized === undefined) throw new Error('API v2 fixture transaction was not normalized')
  return normalized
}

describe('interpretSchemaRegistration', () => {
  it('accepts the exact successful registration envelope', () => {
    const result = interpretSchemaRegistration(
      payment(),
      { ledgerHash: HASH, ledgerIndex: 100 },
      profile,
      new Map(),
    )

    expect(result).toMatchObject({
      status: 'accepted',
      publisher: PUBLISHER,
      schemaUid: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('accepts the API v2 DeliverMax alias for the registration amount', () => {
    const result = interpretSchemaRegistration(
      apiV2Payment(),
      { ledgerHash: HASH, ledgerIndex: 100 },
      profile,
      new Map(),
    )

    expect(result).toMatchObject({
      status: 'accepted',
      publisher: PUBLISHER,
      schemaUid: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('accepts equivalent Amount and DeliverMax aliases', () => {
    expect(
      interpretSchemaRegistration(
        payment({ DeliverMax: '1' }),
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toMatchObject({ status: 'accepted' })
  })

  it('keeps the exact canonical memo while normalizing optional false for the schema UID', () => {
    const memoJson = {
      ...schema,
      fields: {
        programId: { type: 'string', optional: false },
        completedAt: { type: 'string' },
      },
    } as unknown as JsonValue
    const result = interpretSchemaRegistration(
      payment({}, memoJson),
      { ledgerHash: HASH, ledgerIndex: 100 },
      profile,
      new Map(),
    )

    expect(result).toMatchObject({
      status: 'accepted',
      memoJson,
      definition: {
        fields: {
          programId: { type: 'string' },
          completedAt: { type: 'string' },
        },
      },
    })
  })

  it.each([
    ['wrong amount', { Amount: '2' }],
    ['wrong API v2 amount', { Amount: undefined, DeliverMax: '2' }],
    ['conflicting amount aliases', { DeliverMax: '2' }],
    ['path payment', { Paths: [] }],
    ['partial payment', { Flags: 0x0002_0000 }],
    ['API v2 partial payment', { Amount: undefined, DeliverMax: '1', Flags: 0x0002_0000 }],
  ])('ignores a non-exact envelope: %s', (_name, override) => {
    expect(
      interpretSchemaRegistration(
        payment(override),
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toBeUndefined()
  })

  it('ignores an unsuccessful payment even if the memo matches', () => {
    const candidate = payment()
    candidate.metadata.TransactionResult = 'tecUNFUNDED_PAYMENT'
    expect(
      interpretSchemaRegistration(
        candidate,
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toBeUndefined()
  })

  it('rejects non-canonical JSON after the envelope matched', () => {
    const candidate = payment()
    const memo = (candidate.transaction.Memos as Array<{ Memo: Record<string, unknown> }>)[0]?.Memo
    if (memo === undefined) throw new Error('fixture memo missing')
    memo.MemoData = hex(JSON.stringify(schema, null, 2))

    expect(
      interpretSchemaRegistration(
        candidate,
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'REGISTRATION_NOT_CANONICAL' })
  })

  it('keeps a UTF-8 BOM visible in every schema memo field', () => {
    const memoType = payment()
    const memoTypeFields = (
      memoType.transaction.Memos as Array<{ Memo: Record<string, unknown> }>
    )[0]!.Memo
    memoTypeFields.MemoType = hex(`\uFEFFxcs:schema_register`)
    expect(
      interpretSchemaRegistration(
        memoType,
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toBeUndefined()

    const memoFormat = payment()
    const memoFormatFields = (
      memoFormat.transaction.Memos as Array<{ Memo: Record<string, unknown> }>
    )[0]!.Memo
    memoFormatFields.MemoFormat = hex(`\uFEFFapplication/json`)
    expect(
      interpretSchemaRegistration(
        memoFormat,
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'REGISTRATION_MEMO_FORMAT' })

    const memoData = payment()
    const memoDataFields = (
      memoData.transaction.Memos as Array<{ Memo: Record<string, unknown> }>
    )[0]!.Memo
    memoDataFields.MemoData = hex(`\uFEFF${canonicalJson(schema)}`)
    expect(
      interpretSchemaRegistration(
        memoData,
        { ledgerHash: HASH, ledgerIndex: 100 },
        profile,
        new Map(),
      ),
    ).toMatchObject({ status: 'rejected', reasonCode: 'INVALID_JSON' })
  })
})
