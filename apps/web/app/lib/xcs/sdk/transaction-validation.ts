// Copied from packages/sdk/src/transaction-validation.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { hexToBytes } from '@noble/hashes/utils.js'
import { parseSchemaBytes } from '../core/index.js'
import {
  validate,
  type CredentialAccept,
  type CredentialCreate,
  type CredentialDelete,
  type Payment,
} from 'xrpl'

import {
  assertMemoFits,
  credentialHexToUri,
  credentialTypeToSchemaUid,
  XCS_SCHEMA_MEMO_FORMAT,
  XCS_SCHEMA_MEMO_TYPE,
} from './encoding.js'
import { XcsSdkError } from './errors.js'
import { assertClassicAddress, parseNetworkProfile } from './network.js'

const PARTIAL_PAYMENT_FLAG = 0x0002_0000

export type ValidatedXcsTransactionSemantics =
  | {
      readonly kind: 'schema-registration'
      readonly transactionType: 'Payment'
      readonly transaction: Payment
    }
  | {
      readonly kind: 'credential-create'
      readonly transactionType: 'CredentialCreate'
      readonly transaction: CredentialCreate
      readonly schemaUid: string
    }
  | {
      readonly kind: 'credential-accept'
      readonly transactionType: 'CredentialAccept'
      readonly transaction: CredentialAccept
      readonly schemaUid: string
    }
  | {
      readonly kind: 'credential-delete'
      readonly transactionType: 'CredentialDelete'
      readonly transaction: CredentialDelete
      readonly schemaUid: string
    }

/**
 * Prove that a transaction is one of the profile-bound XCS v0.1 operations.
 * Generic XRPL validation deliberately runs before any XCS interpretation.
 */
export function assertXcsTransactionSemantics(
  transactionInput: unknown,
  profileInput: unknown,
): ValidatedXcsTransactionSemantics {
  try {
    validate(transactionInput as Record<string, unknown>)
  } catch (cause) {
    throw invalidTransaction('Transaction is not valid XRPL transaction JSON.', cause)
  }

  const transaction = transactionInput as Record<string, unknown>
  const profile = parseNetworkProfile(profileInput)

  switch (transaction.TransactionType) {
    case 'Payment':
      return validateSchemaRegistration(transaction as unknown as Payment, profile)
    case 'CredentialCreate':
      return validateCredentialCreate(transaction as unknown as CredentialCreate)
    case 'CredentialAccept':
      return validateCredentialAccept(transaction as unknown as CredentialAccept)
    case 'CredentialDelete':
      return validateCredentialDelete(transaction as unknown as CredentialDelete)
    default:
      throw invalidTransaction('Transaction type is not an XCS v0.1 operation.')
  }
}

function validateSchemaRegistration(
  transaction: Payment,
  profile: ReturnType<typeof parseNetworkProfile>,
): ValidatedXcsTransactionSemantics {
  assertClassicAddress(transaction.Account, 'transaction.Account')
  if (
    transaction.Destination !== profile.registryAddress ||
    transaction.Amount !== profile.registrationAmountDrops
  ) {
    throw invalidTransaction(
      'Schema registration payment does not match the network profile registry and amount.',
    )
  }
  if (
    transaction.Paths !== undefined ||
    transaction.SendMax !== undefined ||
    transaction.DeliverMin !== undefined
  ) {
    throw invalidTransaction('Schema registration payment cannot use payment paths or slippage.')
  }
  if (hasPartialPaymentFlag(transaction.Flags)) {
    throw invalidTransaction('Schema registration payment cannot enable tfPartialPayment.')
  }

  const xcsMemos = (transaction.Memos ?? []).filter(
    (entry) => decodeOptionalMemoField(entry.Memo.MemoType) === XCS_SCHEMA_MEMO_TYPE,
  )
  if (xcsMemos.length !== 1) {
    throw invalidTransaction('Schema registration payment must contain exactly one XCS memo.')
  }

  const memo = xcsMemos[0]!.Memo
  if (decodeOptionalMemoField(memo.MemoFormat) !== XCS_SCHEMA_MEMO_FORMAT) {
    throw invalidTransaction('Schema registration memo format must be application/json.')
  }
  if (typeof memo.MemoData !== 'string') {
    throw invalidTransaction('Schema registration memo must contain JSON data.')
  }

  let canonicalSchema: string
  try {
    canonicalSchema = decodeMemoField(memo.MemoData)
    parseSchemaBytes(hexToBytes(memo.MemoData))
    assertMemoFits(canonicalSchema)
  } catch (cause) {
    if (cause instanceof XcsSdkError) throw cause
    throw invalidTransaction('Schema registration memo contains an invalid XCS schema.', cause)
  }

  return {
    kind: 'schema-registration',
    transactionType: 'Payment',
    transaction,
  }
}

function validateCredentialCreate(transaction: CredentialCreate): ValidatedXcsTransactionSemantics {
  assertClassicAddress(transaction.Account, 'transaction.Account')
  assertClassicAddress(transaction.Subject, 'transaction.Subject')
  const schemaUid = credentialTypeToSchemaUid(transaction.CredentialType)
  if (typeof transaction.URI !== 'string') {
    throw invalidTransaction('XCS CredentialCreate must contain an integrity-bound payload URI.')
  }
  credentialHexToUri(transaction.URI)
  if (transaction.Expiration !== undefined && !isUint32(transaction.Expiration)) {
    throw invalidTransaction('CredentialCreate Expiration must be a uint32 Ripple timestamp.')
  }

  return {
    kind: 'credential-create',
    transactionType: 'CredentialCreate',
    transaction,
    schemaUid,
  }
}

function validateCredentialAccept(transaction: CredentialAccept): ValidatedXcsTransactionSemantics {
  assertClassicAddress(transaction.Account, 'transaction.Account')
  assertClassicAddress(transaction.Issuer, 'transaction.Issuer')
  const schemaUid = credentialTypeToSchemaUid(transaction.CredentialType)

  return {
    kind: 'credential-accept',
    transactionType: 'CredentialAccept',
    transaction,
    schemaUid,
  }
}

function validateCredentialDelete(transaction: CredentialDelete): ValidatedXcsTransactionSemantics {
  assertClassicAddress(transaction.Account, 'transaction.Account')
  if (transaction.Issuer === undefined && transaction.Subject === undefined) {
    throw invalidTransaction('CredentialDelete must contain Issuer or Subject.')
  }
  if (transaction.Issuer !== undefined) {
    assertClassicAddress(transaction.Issuer, 'transaction.Issuer')
  }
  if (transaction.Subject !== undefined) {
    assertClassicAddress(transaction.Subject, 'transaction.Subject')
  }
  const schemaUid = credentialTypeToSchemaUid(transaction.CredentialType)

  return {
    kind: 'credential-delete',
    transactionType: 'CredentialDelete',
    transaction,
    schemaUid,
  }
}

function hasPartialPaymentFlag(flags: Payment['Flags']): boolean {
  if (typeof flags === 'number') return (flags & PARTIAL_PAYMENT_FLAG) !== 0
  return flags?.tfPartialPayment === true
}

function decodeOptionalMemoField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return decodeMemoField(value)
  } catch {
    return undefined
  }
}

/** Keep a leading BOM visible so strict JSON parsing rejects it. */
function decodeMemoField(value: string): string {
  const bytes = hexToBytes(value)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (cause) {
    throw invalidTransaction('XCS memo fields must contain strict UTF-8.', cause)
  }
}

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function invalidTransaction(message: string, cause?: unknown): XcsSdkError {
  return new XcsSdkError('XCS_SDK_INVALID_TRANSACTION', message, {
    ...(cause === undefined
      ? {}
      : { cause: cause instanceof Error ? cause.message : String(cause) }),
  })
}
