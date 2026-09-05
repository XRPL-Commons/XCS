import { createIpfsPayloadUri, type JsonValue } from '@xcs-protocol/core'
import { describe, expect, it } from 'vitest'

import { extractCredentialMutations } from '../src/credential-mutations.js'
import { interpretSchemaRegistration } from '../src/registration.js'
import { canonicalJson } from '../src/serialization.js'
import type { LedgerTransaction, NetworkProfile, SchemaDefinition } from '../src/types.js'

const REGISTRY = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const PUBLISHER = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const LEDGER_HASH = 'a'.repeat(64)
const TRANSACTION_HASH = 'b'.repeat(64)
const SCHEMA_UID = 'c'.repeat(64)
const GENERATIVE_SEED = 0x5843_5301

const profile: NetworkProfile = {
  profileId: 'test',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'd'.repeat(64),
  registryAddress: REGISTRY,
  registrationAmountDrops: '1',
  activationLedgerIndex: 100,
  activationLedgerHash: LEDGER_HASH,
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

function xorshift32(seed = GENERATIVE_SEED): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function utf8Hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex')
}

function mixedHexCase(value: string, next: () => number): string {
  return Array.from(value, (character) => {
    if (!/[a-f]/u.test(character)) return character
    return (next() & 1) === 0 ? character : character.toUpperCase()
  }).join('')
}

function registrationPayment(): LedgerTransaction {
  return {
    hash: TRANSACTION_HASH,
    transactionIndex: 0,
    transaction: {
      TransactionType: 'Payment',
      Account: PUBLISHER,
      Destination: REGISTRY,
      Amount: '1',
      Memos: [
        {
          Memo: {
            MemoType: utf8Hex('xcs:schema_register'),
            MemoFormat: utf8Hex('application/json'),
            MemoData: utf8Hex(canonicalJson(schema)),
          },
        },
      ],
    },
    metadata: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
  }
}

function registrationMemo(transaction: LedgerTransaction): Record<string, unknown> {
  const memos = transaction.transaction.Memos
  if (!Array.isArray(memos)) throw new Error('registration fixture has no Memos array')
  const wrapper = memos[0]
  if (typeof wrapper !== 'object' || wrapper === null) {
    throw new Error('registration fixture has no memo wrapper')
  }
  const memo = (wrapper as Record<string, unknown>).Memo
  if (typeof memo !== 'object' || memo === null) {
    throw new Error('registration fixture has no Memo object')
  }
  return memo as Record<string, unknown>
}

function interpret(transaction: LedgerTransaction) {
  return interpretSchemaRegistration(
    transaction,
    { ledgerHash: LEDGER_HASH, ledgerIndex: 100 },
    profile,
    new Map(),
  )
}

function objectId(index: number): string {
  return index.toString(16).padStart(64, '0')
}

function credentialFields(next?: () => number): Record<string, unknown> {
  const credentialType = next === undefined ? SCHEMA_UID : mixedHexCase(SCHEMA_UID, next)
  const uriHex = utf8Hex(createIpfsPayloadUri('generative extraction fixture'))
  return {
    Issuer: PUBLISHER,
    Subject: SUBJECT,
    CredentialType: credentialType,
    URI: next === undefined ? uriHex : mixedHexCase(uriHex, next),
    Flags: 0,
  }
}

type NodeKind = 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'

function credentialNode(
  kind: NodeKind,
  index: number,
  fields: Record<string, unknown> = credentialFields(),
): Record<string, unknown> {
  return {
    [kind]: {
      LedgerEntryType: 'Credential',
      LedgerIndex: objectId(index),
      [kind === 'CreatedNode' ? 'NewFields' : 'FinalFields']: fields,
      ...(kind === 'ModifiedNode' ? { PreviousFields: { Flags: 0 } } : {}),
    },
  }
}

function transactionWithNodes(nodes: unknown[]): LedgerTransaction {
  return {
    hash: TRANSACTION_HASH,
    transactionIndex: 0,
    transaction: { TransactionType: 'CredentialCreate', Account: PUBLISHER },
    metadata: { TransactionResult: 'tesSUCCESS', AffectedNodes: nodes },
  }
}

function malformedCredentialNode(index: number): Record<string, unknown> {
  const kinds: NodeKind[] = ['CreatedNode', 'ModifiedNode', 'DeletedNode']
  const kind = kinds[index % kinds.length] ?? 'CreatedNode'
  const fields = credentialFields()
  const wrapper = credentialNode(kind, index + 10_000, fields)
  const node = wrapper[kind] as Record<string, unknown>
  const fieldsKey = kind === 'CreatedNode' ? 'NewFields' : 'FinalFields'

  switch (index % 11) {
    case 0:
      node.LedgerIndex = 'not-a-ledger-object-id'
      break
    case 1:
      node[fieldsKey] = null
      break
    case 2:
      fields.Issuer = 42
      break
    case 3:
      fields.Issuer = 'not-an-address'
      break
    case 4:
      delete fields.Subject
      break
    case 5:
      fields.Subject = 'not-an-address'
      break
    case 6:
      fields.CredentialType = 'ab'
      break
    case 7:
      delete fields.URI
      break
    case 8:
      fields.URI = 'not-hex'
      break
    case 9:
      fields.URI = utf8Hex('https://issuer.example/no-integrity-fragment')
      break
    case 10:
      fields.URI = 42
      break
  }

  return wrapper
}

function arbitraryJson(next: () => number, depth = 0): unknown {
  const choice = depth >= 3 ? next() % 4 : next() % 6
  switch (choice) {
    case 0:
      return null
    case 1:
      return (next() & 1) === 0
    case 2:
      return next() % 1_000_000
    case 3:
      return `value_${next().toString(16)}`
    case 4:
      return Array.from({ length: next() % 5 }, () => arbitraryJson(next, depth + 1))
    default:
      return Object.fromEntries(
        Array.from({ length: next() % 5 }, (_, index) => [
          `field_${index}_${next() % 17}`,
          arbitraryJson(next, depth + 1),
        ]),
      )
  }
}

describe('generative indexer extraction', () => {
  it('accepts arbitrary hexadecimal casing in every schema memo field', () => {
    const next = xorshift32()
    const baseline = interpret(registrationPayment())
    expect(baseline).toMatchObject({ status: 'accepted' })
    if (baseline?.status !== 'accepted') throw new Error('baseline registration was not accepted')

    for (let index = 0; index < 128; index += 1) {
      const candidate = registrationPayment()
      const memo = registrationMemo(candidate)
      for (const field of ['MemoType', 'MemoFormat', 'MemoData']) {
        const value = memo[field]
        if (typeof value !== 'string') throw new Error(`fixture ${field} is not hexadecimal`)
        memo[field] = mixedHexCase(value, next)
      }

      expect(interpret(candidate)).toMatchObject({
        status: 'accepted',
        schemaUid: baseline.schemaUid,
      })
    }
  })

  it('keeps stable reason codes when one registration property is malformed', () => {
    const mutations: Array<{
      name: string
      reasonCode: string
      mutate: (candidate: LedgerTransaction) => void
    }> = [
      {
        name: 'missing account',
        reasonCode: 'REGISTRATION_ACCOUNT_INVALID',
        mutate: (candidate) => {
          delete candidate.transaction.Account
        },
      },
      {
        name: 'duplicate XCS memo',
        reasonCode: 'REGISTRATION_MEMO_COUNT',
        mutate: (candidate) => {
          const memos = candidate.transaction.Memos
          if (!Array.isArray(memos) || memos[0] === undefined)
            throw new Error('fixture memo missing')
          candidate.transaction.Memos = [...memos, structuredClone(memos[0])]
        },
      },
      {
        name: 'wrong memo format',
        reasonCode: 'REGISTRATION_MEMO_FORMAT',
        mutate: (candidate) => {
          registrationMemo(candidate).MemoFormat = utf8Hex('text/plain')
        },
      },
      {
        name: 'invalid memo hex',
        reasonCode: 'REGISTRATION_MEMO_DATA',
        mutate: (candidate) => {
          registrationMemo(candidate).MemoData = 'f'
        },
      },
      {
        name: 'invalid memo UTF-8',
        reasonCode: 'REGISTRATION_MEMO_DATA',
        mutate: (candidate) => {
          registrationMemo(candidate).MemoData = 'ff'
        },
      },
      {
        name: 'non-canonical JSON',
        reasonCode: 'REGISTRATION_NOT_CANONICAL',
        mutate: (candidate) => {
          registrationMemo(candidate).MemoData = utf8Hex(JSON.stringify(schema, null, 2))
        },
      },
      {
        name: 'malformed JSON',
        reasonCode: 'INVALID_JSON',
        mutate: (candidate) => {
          registrationMemo(candidate).MemoData = utf8Hex('{"xcsVersion":')
        },
      },
      {
        name: 'invalid schema',
        reasonCode: 'INVALID_SCHEMA',
        mutate: (candidate) => {
          const invalidSchema = { ...schema, future: true } as unknown as JsonValue
          registrationMemo(candidate).MemoData = utf8Hex(canonicalJson(invalidSchema))
        },
      },
    ]

    for (const { name, reasonCode, mutate } of mutations) {
      const candidate = registrationPayment()
      mutate(candidate)
      expect(interpret(candidate), name).toMatchObject({ status: 'rejected', reasonCode })
    }
  })

  it('ignores every non-exact registration payment envelope', () => {
    const mutations: Array<{
      name: string
      mutate: (candidate: LedgerTransaction) => void
    }> = [
      {
        name: 'wrong transaction type',
        mutate: (candidate) => {
          candidate.transaction.TransactionType = 'AccountSet'
        },
      },
      {
        name: 'unsuccessful result',
        mutate: (candidate) => {
          candidate.metadata.TransactionResult = 'tecUNFUNDED_PAYMENT'
        },
      },
      {
        name: 'wrong destination',
        mutate: (candidate) => {
          candidate.transaction.Destination = SUBJECT
        },
      },
      {
        name: 'wrong amount',
        mutate: (candidate) => {
          candidate.transaction.Amount = '2'
        },
      },
      {
        name: 'paths present',
        mutate: (candidate) => {
          candidate.transaction.Paths = []
        },
      },
      {
        name: 'send max present',
        mutate: (candidate) => {
          candidate.transaction.SendMax = '1'
        },
      },
      {
        name: 'deliver min present',
        mutate: (candidate) => {
          candidate.transaction.DeliverMin = '1'
        },
      },
      {
        name: 'partial payment flag',
        mutate: (candidate) => {
          candidate.transaction.Flags = 0x0002_0000
        },
      },
    ]

    for (const { name, mutate } of mutations) {
      const candidate = registrationPayment()
      mutate(candidate)
      expect(interpret(candidate), name).toBeUndefined()
    }
  })

  it('never throws or projects from arbitrary JSON-shaped AffectedNodes', () => {
    const next = xorshift32()

    for (let index = 0; index < 256; index += 1) {
      const transaction: LedgerTransaction = {
        hash: TRANSACTION_HASH,
        transactionIndex: 0,
        transaction: { TransactionType: 'Payment', Account: PUBLISHER },
        metadata: { AffectedNodes: arbitraryJson(next) },
      }
      expect(() =>
        extractCredentialMutations(transaction, 1_000, new Set([SCHEMA_UID])),
      ).not.toThrow()
      expect(extractCredentialMutations(transaction, 1_000, new Set([SCHEMA_UID]))).toEqual({
        mutations: [],
        malformedCredentialNodes: 0,
      })
    }
  })

  it('rejects each malformed Credential node atomically and counts every one', () => {
    const malformedNodes = Array.from({ length: 121 }, (_, index) => malformedCredentialNode(index))

    for (const node of malformedNodes) {
      expect(
        extractCredentialMutations(transactionWithNodes([node]), 1_000, new Set([SCHEMA_UID])),
      ).toEqual({ mutations: [], malformedCredentialNodes: 1 })
    }

    expect(
      extractCredentialMutations(
        transactionWithNodes(malformedNodes),
        1_000,
        new Set([SCHEMA_UID]),
      ),
    ).toEqual({ mutations: [], malformedCredentialNodes: malformedNodes.length })
  })

  it('projects valid nodes while preserving exact malformed count and node indexes', () => {
    const next = xorshift32()
    const validNodes = Array.from({ length: 32 }, (_, index) =>
      credentialNode('CreatedNode', index + 1, credentialFields(next)),
    )
    const malformedNodes = Array.from({ length: 64 }, (_, index) => malformedCredentialNode(index))
    const noise = Array.from({ length: 64 }, () => arbitraryJson(next))

    const result = extractCredentialMutations(
      transactionWithNodes([...validNodes, ...malformedNodes, ...noise]),
      1_000,
      new Set([SCHEMA_UID]),
    )

    expect(result.malformedCredentialNodes).toBe(malformedNodes.length)
    expect(result.mutations).toHaveLength(validNodes.length)
    expect(result.mutations.map((mutation) => mutation.nodeIndex)).toEqual(
      Array.from({ length: validNodes.length }, (_, index) => index),
    )
    expect(result.mutations).toEqual(
      expect.arrayContaining(
        Array.from({ length: validNodes.length }, (_, index) =>
          expect.objectContaining({
            eventType: 'created',
            ledgerObjectId: objectId(index + 1),
            schemaUid: SCHEMA_UID,
          }),
        ),
      ),
    )
  })
})
