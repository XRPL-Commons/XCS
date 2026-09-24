// Copied from packages/core/src/json.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import canonicalizeRfc8785 from 'canonicalize'
import { parseTree, type Node, type ParseError } from 'jsonc-parser'

import { fail } from './errors.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

const encoder = new TextEncoder()
// Keep a leading BOM visible so JSON.parse rejects bytes that are not canonical JSON.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function assertWellFormed(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('UNSUPPORTED_JSON_VALUE', 'JSON strings must contain valid Unicode', path)
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      fail('UNSUPPORTED_JSON_VALUE', 'JSON strings must contain valid Unicode', path)
    }
  }
}

function assertJsonValueInternal(value: unknown, path: string, stack: Set<object>): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    assertWellFormed(value, path)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('UNSUPPORTED_JSON_VALUE', 'JSON numbers must be finite', path)
    }
    return
  }
  if (typeof value !== 'object') {
    fail('UNSUPPORTED_JSON_VALUE', `Unsupported ${typeof value} value`, path)
  }
  if (stack.has(value)) fail('UNSUPPORTED_JSON_VALUE', 'Cyclic JSON value', path)

  stack.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail('UNSUPPORTED_JSON_VALUE', 'Sparse arrays are not JSON values', `${path}[${index}]`)
        }
        assertJsonValueInternal(value[index], `${path}[${index}]`, stack)
      }
      return
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('UNSUPPORTED_JSON_VALUE', 'Only plain objects are JSON values', path)
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertWellFormed(key, path)
      assertJsonValueInternal(child, `${path}.${key}`, stack)
    }
  } finally {
    stack.delete(value)
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueInternal(value, '$', new Set())
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value)
  const serialized = canonicalizeRfc8785(value)
  if (serialized === undefined) {
    return fail('UNSUPPORTED_JSON_VALUE', 'Value cannot be represented as canonical JSON', '$')
  }
  return serialized
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value))
}

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch (cause) {
    return fail('INVALID_JSON', 'Input is not valid UTF-8', '$', { cause: String(cause) })
  }
}

export function encodeHexUtf8(value: string): string {
  return bytesToHex(encodeUtf8(value))
}

export function decodeHexUtf8(value: string): string {
  return decodeUtf8(hexToBytes(value))
}

export function sha256Hex(value: Uint8Array): string {
  return bytesToHex(sha256(value))
}

export function parseJson(input: string | Uint8Array): JsonValue {
  const text = typeof input === 'string' ? input : decodeUtf8(input)
  const errors: ParseError[] = []
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  })
  if (!root || errors.length > 0) {
    return fail('INVALID_JSON', 'Input is not valid JSON', '$')
  }
  rejectDuplicateObjectKeys(root)

  const parsed = JSON.parse(text) as unknown
  assertJsonValue(parsed)
  return parsed
}

export function parseCanonicalJson(input: string | Uint8Array): JsonValue {
  const text = typeof input === 'string' ? input : decodeUtf8(input)
  const parsed = parseJson(text)
  if (canonicalJson(parsed) !== text) {
    return fail('NON_CANONICAL_JSON', 'Input must use RFC 8785 canonical JSON', '$')
  }
  assertJsonValue(parsed)
  return parsed
}

function rejectDuplicateObjectKeys(node: Node): void {
  if (node.type === 'object') {
    const keys = new Set<string>()
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? []
      const key = keyNode?.value
      if (typeof key !== 'string' || !valueNode) {
        return fail('INVALID_JSON', 'Input contains an invalid JSON object', '$')
      }
      if (keys.has(key)) {
        return fail('INVALID_JSON', `Input contains duplicate key ${key}`, '$')
      }
      keys.add(key)
      rejectDuplicateObjectKeys(valueNode)
    }
    return
  }
  for (const child of node.children ?? []) rejectDuplicateObjectKeys(child)
}

export function utf8ByteLength(value: string): number {
  assertWellFormed(value, '$')
  return encoder.encode(value).length
}
