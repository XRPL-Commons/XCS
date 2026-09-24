// Copied from packages/core/src/claims.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { base64urlnopad } from '@scure/base'
import { isValidClassicAddress } from 'xrpl'

import { fail } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'
import type { FieldDescriptor, SchemaFields } from './schema.js'

// Decimal constructors keep the published bundle parseable by ES2019 bundlers while
// preserving exact 256-bit bounds on runtimes that support BigInt.
const UINT256_MAX = BigInt(
  '115792089237316195423570985008687907853269984665640564039457584007913129639935',
)
const INT256_MIN = BigInt(
  '-57896044618658097711785492504343953926634992332820282019728792003956564819968',
)
const INT256_MAX = BigInt(
  '57896044618658097711785492504343953926634992332820282019728792003956564819967',
)
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/
const SIGNED_INTEGER = /^(?:0|-?[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCanonicalBase64Url(value: string): boolean {
  try {
    return base64urlnopad.encode(base64urlnopad.decode(value)) === value
  } catch {
    return false
  }
}

function parseValue(value: unknown, descriptor: FieldDescriptor, path: string): JsonValue {
  if (value === null) return fail('INVALID_CLAIMS', 'null is not allowed', path)

  switch (descriptor.type) {
    case 'string':
      if (typeof value !== 'string') return fail('INVALID_CLAIMS', 'Expected a string', path)
      return value
    case 'bool':
      if (typeof value !== 'boolean') return fail('INVALID_CLAIMS', 'Expected a boolean', path)
      return value
    case 'uint': {
      if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) {
        return fail('INVALID_CLAIMS', 'Expected a canonical unsigned decimal string', path)
      }
      if (value.length > 78 || BigInt(value) > UINT256_MAX) {
        return fail('INVALID_CLAIMS', 'Unsigned integer exceeds 256 bits', path)
      }
      return value
    }
    case 'int': {
      if (typeof value !== 'string' || !SIGNED_INTEGER.test(value)) {
        return fail('INVALID_CLAIMS', 'Expected a canonical signed decimal string', path)
      }
      const integer = BigInt(value)
      if (value.length > 79 || integer < INT256_MIN || integer > INT256_MAX) {
        return fail('INVALID_CLAIMS', 'Signed integer exceeds 256 bits', path)
      }
      return value
    }
    case 'bytes':
      if (typeof value !== 'string' || !isCanonicalBase64Url(value)) {
        return fail('INVALID_CLAIMS', 'Expected unpadded canonical base64url', path)
      }
      return value
    case 'address':
      if (typeof value !== 'string' || !isValidClassicAddress(value)) {
        return fail('INVALID_CLAIMS', 'Expected an XRPL classic address', path)
      }
      return value
    case 'array':
      if (!Array.isArray(value)) return fail('INVALID_CLAIMS', 'Expected an array', path)
      return value.map((item, index) => parseValue(item, descriptor.items, `${path}[${index}]`))
    case 'object':
      return parseObject(value, descriptor.fields, path)
  }
}

function parseObject(input: unknown, fields: SchemaFields, path: string): JsonObject {
  if (!isRecord(input)) return fail('INVALID_CLAIMS', 'Expected an object', path)
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(fields, name)) {
      return fail('INVALID_CLAIMS', `Unknown claim ${name}`, `${path}.${name}`)
    }
  }

  const claims = Object.create(null) as JsonObject
  for (const [name, descriptor] of Object.entries(fields)) {
    if (!Object.hasOwn(input, name)) {
      if (descriptor.optional === true) continue
      return fail('INVALID_CLAIMS', `Missing required claim ${name}`, `${path}.${name}`)
    }
    claims[name] = parseValue(input[name], descriptor, `${path}.${name}`)
  }
  return claims
}

export function parseClaims(input: unknown, fields: SchemaFields): JsonObject {
  return parseObject(input, fields, '$.claims')
}
