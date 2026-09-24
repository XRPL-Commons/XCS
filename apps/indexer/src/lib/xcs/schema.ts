// Copied from packages/core/src/schema.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { fail } from './errors.js'
import { encodeCanonicalJson, parseCanonicalJson, utf8ByteLength } from './json.js'

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SCHEMA_UID = /^[0-9a-f]{64}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const SCALAR_TYPES = new Set<ScalarFieldType>(['string', 'bool', 'uint', 'int', 'bytes', 'address'])
const SCHEMA_PROPERTIES = new Set([
  'xcsVersion',
  'name',
  'description',
  'extends',
  'supersedes',
  'fields',
])

export const MAX_SCHEMA_DEPTH = 16
export const MAX_SCHEMA_FIELDS = 256

interface FieldBase {
  optional?: true
}

export type ScalarFieldType = 'string' | 'bool' | 'uint' | 'int' | 'bytes' | 'address'

export interface ScalarFieldDescriptor extends FieldBase {
  type: ScalarFieldType
}

export interface ArrayFieldDescriptor extends FieldBase {
  type: 'array'
  items: FieldDescriptor
}

export interface ObjectFieldDescriptor extends FieldBase {
  type: 'object'
  fields: SchemaFields
}

export type FieldDescriptor = ScalarFieldDescriptor | ArrayFieldDescriptor | ObjectFieldDescriptor
export type SchemaFields = Record<string, FieldDescriptor>

export interface SchemaDefinition {
  xcsVersion: '0.1'
  name: string
  description: string
  fields: SchemaFields
  extends?: string
  supersedes?: string
}

export interface RegisteredSchema {
  uid: string
  definition: SchemaDefinition
  publisher: string
  networkId: number
  ledgerIndex: number
  transactionIndex: number
}

export interface ResolvedSchema {
  definition: SchemaDefinition
  fields: SchemaFields
  /** Parent UIDs ordered from the root to the direct parent. */
  lineage: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertOnlyProperties(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('INVALID_SCHEMA', `Unknown property ${key}`, `${path}.${key}`)
  }
}

function parseText(value: unknown, path: string, maxBytes: number): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    return fail('INVALID_SCHEMA', `Expected 1 to ${maxBytes} UTF-8 bytes`, path)
  }
  const length = utf8ByteLength(value)
  if (length < 1 || length > maxBytes) {
    return fail('INVALID_SCHEMA', `Expected 1 to ${maxBytes} UTF-8 bytes`, path)
  }
  return value
}

function parseDescriptor(
  input: unknown,
  path: string,
  depth: number,
  count: { value: number },
): FieldDescriptor {
  if (!isRecord(input) || typeof input.type !== 'string') {
    return fail('INVALID_SCHEMA', 'Field descriptor must contain a type', path)
  }
  if (input.optional !== undefined && typeof input.optional !== 'boolean') {
    return fail('INVALID_SCHEMA', 'optional must be a boolean', `${path}.optional`)
  }
  const optional = input.optional === true ? { optional: true as const } : {}

  if (SCALAR_TYPES.has(input.type as ScalarFieldType)) {
    assertOnlyProperties(input, new Set(['type', 'optional']), path)
    return { type: input.type as ScalarFieldType, ...optional }
  }
  if (input.type === 'array') {
    assertOnlyProperties(input, new Set(['type', 'optional', 'items']), path)
    if (depth >= MAX_SCHEMA_DEPTH || input.items === undefined) {
      return fail('INVALID_SCHEMA', 'Array descriptor is missing items or exceeds depth', path)
    }
    count.value += 1
    assertFieldLimit(count.value, `${path}.items`)
    return {
      type: 'array',
      items: parseDescriptor(input.items, `${path}.items`, depth + 1, count),
      ...optional,
    }
  }
  if (input.type === 'object') {
    assertOnlyProperties(input, new Set(['type', 'optional', 'fields']), path)
    if (depth >= MAX_SCHEMA_DEPTH) {
      return fail('INVALID_SCHEMA', `Schema nesting exceeds ${MAX_SCHEMA_DEPTH}`, path)
    }
    return {
      type: 'object',
      fields: parseFields(input.fields, `${path}.fields`, depth + 1, count),
      ...optional,
    }
  }
  return fail('INVALID_SCHEMA', `Unsupported field type ${input.type}`, `${path}.type`)
}

function assertFieldLimit(count: number, path: string): void {
  if (count > MAX_SCHEMA_FIELDS) {
    fail('INVALID_SCHEMA', `Schema exceeds ${MAX_SCHEMA_FIELDS} field descriptors`, path)
  }
}

function parseFields(
  input: unknown,
  path: string,
  depth: number,
  count: { value: number },
): SchemaFields {
  if (!isRecord(input) || Object.keys(input).length === 0) {
    return fail('INVALID_SCHEMA', 'fields must be a non-empty object', path)
  }
  const fields = Object.create(null) as SchemaFields
  for (const [name, descriptor] of Object.entries(input)) {
    if (!FIELD_NAME.test(name)) fail('INVALID_SCHEMA', 'Invalid field name', `${path}.${name}`)
    count.value += 1
    assertFieldLimit(count.value, `${path}.${name}`)
    fields[name] = parseDescriptor(descriptor, `${path}.${name}`, depth, count)
  }
  return fields
}

function parseRelation(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SCHEMA_UID.test(value)) {
    return fail('INVALID_SCHEMA', 'Expected a lowercase 32-byte schema UID', path)
  }
  return value
}

export function parseSchema(input: unknown): SchemaDefinition {
  if (!isRecord(input)) return fail('INVALID_SCHEMA', 'Schema must be an object', '$')
  assertOnlyProperties(input, SCHEMA_PROPERTIES, '$')
  if (input.xcsVersion !== '0.1') {
    return fail('INVALID_SCHEMA', 'Unsupported XCS schema version', '$.xcsVersion')
  }

  const parent = parseRelation(input.extends, '$.extends')
  const predecessor = parseRelation(input.supersedes, '$.supersedes')
  if (parent !== undefined && parent === predecessor) {
    return fail('INVALID_SCHEMA', 'extends and supersedes must reference different schemas', '$')
  }

  return {
    xcsVersion: '0.1',
    name: parseText(input.name, '$.name', 64),
    description: parseText(input.description, '$.description', 256),
    fields: parseFields(input.fields, '$.fields', 1, { value: 0 }),
    ...(parent === undefined ? {} : { extends: parent }),
    ...(predecessor === undefined ? {} : { supersedes: predecessor }),
  }
}

export function parseSchemaBytes(bytes: Uint8Array): SchemaDefinition {
  return parseSchema(parseCanonicalJson(bytes))
}

export function encodeSchema(schema: unknown): Uint8Array {
  return encodeCanonicalJson(parseSchema(schema))
}

export function countSchemaFields(fields: SchemaFields): number {
  let count = 0
  for (const descriptor of Object.values(fields)) {
    count += 1
    if (descriptor.type === 'array') count += countSchemaFields({ items: descriptor.items })
    if (descriptor.type === 'object') count += countSchemaFields(descriptor.fields)
  }
  return count
}
