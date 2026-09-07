import {
  computeSchemaUid,
  parseSchema,
  resolveSchema,
  XcsError,
  type JsonValue,
} from '@xcs-protocol/core'

import { canonicalJson, parseJson } from './serialization.js'

import type {
  LedgerTransaction,
  NetworkProfile,
  SchemaCatalogEntry,
  SchemaRegistrationResult,
} from './types.js'

const PARTIAL_PAYMENT_FLAG = 0x0002_0000

function hasExactRegistrationAmount(
  transaction: Record<string, unknown>,
  expectedAmount: string,
): boolean {
  // rippled serializes the same Payment field as Amount in API v1 and
  // DeliverMax in API v2. Accept either representation, but fail closed if a
  // source ever returns both aliases with conflicting values.
  const aliases = [transaction.Amount, transaction.DeliverMax].filter(
    (value) => value !== undefined,
  )
  return aliases.length > 0 && aliases.every((value) => value === expectedAmount)
}

interface RegistrationEnvelope {
  publisher: string
  jsonText: string
}

type EnvelopeResult =
  | { kind: 'not_registration' }
  | { kind: 'candidate'; envelope: RegistrationEnvelope }
  | { kind: 'rejected'; publisher: string; reasonCode: string }

function decodeHexUtf8(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value)
  ) {
    return undefined
  }

  try {
    // Keep a leading BOM visible so exact memo tokens and JCS bytes cannot be
    // accepted after TextDecoder silently removes an on-ledger byte prefix.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(Buffer.from(value, 'hex')),
    )
  } catch {
    return undefined
  }
}

function memoFields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const memoWrapper = value as Record<string, unknown>
  const memo = memoWrapper.Memo
  return typeof memo === 'object' && memo !== null ? (memo as Record<string, unknown>) : undefined
}

export function extractRegistrationEnvelope(
  transaction: LedgerTransaction,
  profile: NetworkProfile,
): EnvelopeResult {
  const tx = transaction.transaction
  const meta = transaction.metadata
  const publisher = typeof tx.Account === 'string' ? tx.Account : ''
  const memos = Array.isArray(tx.Memos) ? tx.Memos : []
  const xcsMemos = memos.filter((entry) => {
    const memo = memoFields(entry)
    return decodeHexUtf8(memo?.MemoType) === 'xcs:schema_register'
  })

  if (xcsMemos.length === 0) return { kind: 'not_registration' }

  const exactPayment =
    tx.TransactionType === 'Payment' &&
    meta.TransactionResult === 'tesSUCCESS' &&
    tx.Destination === profile.registryAddress &&
    hasExactRegistrationAmount(tx, profile.registrationAmountDrops) &&
    tx.Paths === undefined &&
    tx.SendMax === undefined &&
    tx.DeliverMin === undefined &&
    ((typeof tx.Flags === 'number' ? tx.Flags : 0) & PARTIAL_PAYMENT_FLAG) === 0

  // Transactions that only look like registrations but do not satisfy the
  // on-ledger envelope are deliberately not indexed as XCS events.
  if (!exactPayment) return { kind: 'not_registration' }

  if (publisher.length === 0) {
    return { kind: 'rejected', publisher, reasonCode: 'REGISTRATION_ACCOUNT_INVALID' }
  }
  if (xcsMemos.length !== 1) {
    return { kind: 'rejected', publisher, reasonCode: 'REGISTRATION_MEMO_COUNT' }
  }

  const memo = memoFields(xcsMemos[0])
  if (decodeHexUtf8(memo?.MemoFormat) !== 'application/json') {
    return { kind: 'rejected', publisher, reasonCode: 'REGISTRATION_MEMO_FORMAT' }
  }
  const jsonText = decodeHexUtf8(memo?.MemoData)
  if (jsonText === undefined) {
    return { kind: 'rejected', publisher, reasonCode: 'REGISTRATION_MEMO_DATA' }
  }

  return { kind: 'candidate', envelope: { publisher, jsonText } }
}

export function interpretSchemaRegistration(
  transaction: LedgerTransaction,
  ledger: { ledgerHash: string; ledgerIndex: number },
  profile: NetworkProfile,
  catalog: ReadonlyMap<string, SchemaCatalogEntry>,
): SchemaRegistrationResult | undefined {
  const extracted = extractRegistrationEnvelope(transaction, profile)
  if (extracted.kind === 'not_registration') return undefined
  if (extracted.kind === 'rejected') {
    return {
      status: 'rejected',
      transactionHash: transaction.hash,
      transactionIndex: transaction.transactionIndex,
      publisher: extracted.publisher,
      reasonCode: extracted.reasonCode,
    }
  }

  let parsed: JsonValue | undefined
  try {
    parsed = parseJson(extracted.envelope.jsonText) as JsonValue
    if (canonicalJson(parsed) !== extracted.envelope.jsonText) {
      return {
        status: 'rejected',
        transactionHash: transaction.hash,
        transactionIndex: transaction.transactionIndex,
        publisher: extracted.envelope.publisher,
        reasonCode: 'REGISTRATION_NOT_CANONICAL',
        memoJson: parsed,
      }
    }

    const definition = parseSchema(parsed)
    const resolved = resolveSchema(definition, {
      networkId: profile.networkId,
      publisher: extracted.envelope.publisher,
      ledgerIndex: ledger.ledgerIndex,
      transactionIndex: transaction.transactionIndex,
      getSchema: (uid) => catalog.get(uid),
    })
    const schemaUid = computeSchemaUid({
      networkId: profile.networkId,
      ledgerHash: ledger.ledgerHash,
      ledgerIndex: ledger.ledgerIndex,
      transactionIndex: transaction.transactionIndex,
      publisher: extracted.envelope.publisher,
      schema: definition,
    })
    return {
      status: 'accepted',
      transactionHash: transaction.hash,
      transactionIndex: transaction.transactionIndex,
      publisher: extracted.envelope.publisher,
      schemaUid,
      memoJson: parsed,
      definition,
      resolved,
    }
  } catch (error) {
    return {
      status: 'rejected',
      transactionHash: transaction.hash,
      transactionIndex: transaction.transactionIndex,
      publisher: extracted.envelope.publisher,
      reasonCode:
        error instanceof XcsError
          ? error.code
          : error instanceof SyntaxError
            ? 'JSON_INVALID'
            : 'REGISTRATION_INVALID',
      ...(parsed === undefined ? {} : { memoJson: parsed }),
    }
  }
}
