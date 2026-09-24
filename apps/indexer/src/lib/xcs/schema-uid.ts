// Copied from packages/core/src/schema-uid.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { isValidClassicAddress } from 'xrpl'

import { fail } from './errors.js'
import { encodeCanonicalJson } from './json.js'
import { parseSchema, type SchemaDefinition } from './schema.js'

export interface SchemaUidInput {
  networkId: number
  ledgerHash: string
  ledgerIndex: number
  transactionIndex: number
  publisher: string
  schema: SchemaDefinition
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff
}

export function computeSchemaUid(input: SchemaUidInput): string {
  if (
    !isUint32(input.networkId) ||
    !isUint32(input.ledgerIndex) ||
    !isUint32(input.transactionIndex)
  ) {
    return fail('INVALID_UID_INPUT', 'Network and ledger coordinates must be uint32 values', '$')
  }
  if (!/^[0-9a-fA-F]{64}$/.test(input.ledgerHash)) {
    return fail(
      'INVALID_UID_INPUT',
      'ledgerHash must be a 32-byte hexadecimal hash',
      '$.ledgerHash',
    )
  }
  if (!isValidClassicAddress(input.publisher)) {
    return fail('INVALID_UID_INPUT', 'publisher must be an XRPL classic address', '$.publisher')
  }

  const preimage = {
    purpose: 'xcs.schema.uid',
    version: '0.1',
    networkId: input.networkId,
    ledgerHash: input.ledgerHash.toLowerCase(),
    ledgerIndex: input.ledgerIndex,
    transactionIndex: input.transactionIndex,
    publisher: input.publisher,
    schema: parseSchema(input.schema),
  }
  return bytesToHex(sha256(encodeCanonicalJson(preimage)))
}
