// Copied from packages/sdk/src/encoding.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { parsePayloadUri } from '../core/index.js'
import { encode, type Memo, type Payment } from 'xrpl'

import { XcsSdkError } from './errors.js'

export const XCS_SCHEMA_MEMO_TYPE = 'xcs:schema_register'
export const XCS_SCHEMA_MEMO_FORMAT = 'application/json'
export const MAX_XRPL_MEMO_BYTES = 1_024
export const MAX_CREDENTIAL_URI_BYTES = 256

// rippled measures sfMemos via STArray::add: the serialized Memo objects only.
// xrpl.js encodes two additional one-byte field delimiters around that body:
// the sfMemos field header (F9) and the STArray end marker (F1).
const XRPL_MEMOS_FIELD_ENVELOPE_BYTES = 2

const SCHEMA_UID_PATTERN = /^[0-9a-f]{64}$/u
const CREDENTIAL_TYPE_PATTERN = /^[0-9a-fA-F]{64}$/u
const HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/u

export function encodeMemoField(value: string): string {
  return bytesToHex(new TextEncoder().encode(value)).toUpperCase()
}

export function decodeMemoField(value: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(value))
  } catch (cause) {
    throw new XcsSdkError('XCS_SDK_INVALID_URI', 'Value is not valid UTF-8 hexadecimal.', {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export function schemaUidToCredentialType(schemaUid: string): string {
  if (!SCHEMA_UID_PATTERN.test(schemaUid)) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SCHEMA_UID',
      'Schema UID must be exactly 32 bytes represented by 64 lowercase hexadecimal characters.',
      { schemaUid },
    )
  }

  return schemaUid.toUpperCase()
}

export function credentialTypeToSchemaUid(credentialType: string): string {
  if (!CREDENTIAL_TYPE_PATTERN.test(credentialType)) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SCHEMA_UID',
      'CredentialType must contain exactly 32 bytes of hexadecimal data.',
      { credentialType },
    )
  }

  return credentialType.toLowerCase()
}

export function uriToCredentialHex(uri: string): string {
  const bytes = new TextEncoder().encode(uri)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_URI_BYTES) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_URI',
      `Credential URI must contain between 1 and ${MAX_CREDENTIAL_URI_BYTES} UTF-8 bytes.`,
      { byteLength: bytes.byteLength },
    )
  }

  parsePayloadUri(uri)

  return encodeMemoField(uri)
}

export function credentialHexToUri(uriHex: string): string {
  if (!HEX_PATTERN.test(uriHex)) {
    throw new XcsSdkError('XCS_SDK_INVALID_URI', 'Credential URI is not valid hexadecimal.')
  }

  const uri = decodeMemoField(uriHex)
  uriToCredentialHex(uri)
  return uri
}

export function measureSchemaRegistrationMemoBytes(canonicalSchema: string): number {
  return measureTransactionMemoBytes([
    {
      Memo: {
        MemoType: encodeMemoField(XCS_SCHEMA_MEMO_TYPE),
        MemoFormat: encodeMemoField(XCS_SCHEMA_MEMO_FORMAT),
        MemoData: encodeMemoField(canonicalSchema),
      },
    },
  ])
}

/** Exact serialized Memo-object bytes counted by rippled against its 1 KiB limit. */
export function measureTransactionMemoBytes(memos: readonly Memo[]): number {
  const base: Payment = {
    TransactionType: 'Payment',
    Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    Destination: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
    Amount: '1',
    Fee: '12',
    Sequence: 1,
    SigningPubKey: '',
  }
  const withMemo: Payment = {
    ...base,
    // Materialize plain objects at the XRPL codec boundary.
    Memos: memos.map((entry) => ({ Memo: { ...entry.Memo } })),
  }
  const serializedMemosFieldBytes = (encode(withMemo).length - encode(base).length) / 2

  return serializedMemosFieldBytes - XRPL_MEMOS_FIELD_ENVELOPE_BYTES
}

export function assertTransactionMemosFit(memos: readonly Memo[]): void {
  const byteLength = measureTransactionMemoBytes(memos)
  if (byteLength > MAX_XRPL_MEMO_BYTES) {
    throw new XcsSdkError(
      'XCS_SDK_MEMO_TOO_LARGE',
      `Transaction memos exceed the ${MAX_XRPL_MEMO_BYTES}-byte XRPL limit.`,
      { byteLength, maxByteLength: MAX_XRPL_MEMO_BYTES },
    )
  }
}

export function assertMemoFits(canonicalSchema: string): void {
  const byteLength = measureSchemaRegistrationMemoBytes(canonicalSchema)

  if (byteLength > MAX_XRPL_MEMO_BYTES) {
    throw new XcsSdkError(
      'XCS_SDK_MEMO_TOO_LARGE',
      `XCS schema memo content exceeds the ${MAX_XRPL_MEMO_BYTES}-byte XRPL limit.`,
      { byteLength, maxByteLength: MAX_XRPL_MEMO_BYTES },
    )
  }
}
