import type { SchemaCursor, SchemaRegistrationCursor } from './types.js'

const UID_PATTERN = /^[0-9a-f]{64}$/
const MAX_UINT32 = 4_294_967_295
const MAX_POSTGRES_INTEGER = 2_147_483_647

export function encodeSchemaCursor(cursor: SchemaCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeSchemaCursor(value: string): SchemaCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid cursor')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid cursor')
  }
  const cursor = parsed as Record<string, unknown>
  if (
    Object.keys(cursor).length !== 3 ||
    typeof cursor.ledgerIndex !== 'number' ||
    !Number.isSafeInteger(cursor.ledgerIndex) ||
    cursor.ledgerIndex < 0 ||
    cursor.ledgerIndex > MAX_UINT32 ||
    typeof cursor.transactionIndex !== 'number' ||
    !Number.isSafeInteger(cursor.transactionIndex) ||
    cursor.transactionIndex < 0 ||
    cursor.transactionIndex > MAX_POSTGRES_INTEGER ||
    typeof cursor.schemaUid !== 'string' ||
    !UID_PATTERN.test(cursor.schemaUid)
  ) {
    throw new Error('Invalid cursor')
  }
  return {
    ledgerIndex: cursor.ledgerIndex,
    transactionIndex: cursor.transactionIndex,
    schemaUid: cursor.schemaUid,
  }
}

export function encodeSchemaRegistrationCursor(cursor: SchemaRegistrationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeSchemaRegistrationCursor(value: string): SchemaRegistrationCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid cursor')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid cursor')
  }
  const cursor = parsed as Record<string, unknown>
  if (
    Object.keys(cursor).length !== 3 ||
    typeof cursor.ledgerIndex !== 'number' ||
    !Number.isSafeInteger(cursor.ledgerIndex) ||
    cursor.ledgerIndex < 0 ||
    cursor.ledgerIndex > MAX_UINT32 ||
    typeof cursor.transactionIndex !== 'number' ||
    !Number.isSafeInteger(cursor.transactionIndex) ||
    cursor.transactionIndex < 0 ||
    cursor.transactionIndex > MAX_POSTGRES_INTEGER ||
    typeof cursor.transactionHash !== 'string' ||
    !UID_PATTERN.test(cursor.transactionHash)
  ) {
    throw new Error('Invalid cursor')
  }
  return {
    ledgerIndex: cursor.ledgerIndex,
    transactionIndex: cursor.transactionIndex,
    transactionHash: cursor.transactionHash,
  }
}
