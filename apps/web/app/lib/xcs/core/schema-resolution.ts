// Copied from packages/core/src/schema-resolution.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { isValidClassicAddress } from 'xrpl'

import { fail } from './errors.js'
import {
  countSchemaFields,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_FIELDS,
  parseSchema,
  type RegisteredSchema,
  type ResolvedSchema,
  type SchemaDefinition,
  type SchemaFields,
} from './schema.js'

export interface SchemaResolutionContext {
  networkId: number
  publisher: string
  ledgerIndex: number
  transactionIndex: number
  getSchema(uid: string): RegisteredSchema | undefined
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff
}

function isEarlier(
  schema: Pick<RegisteredSchema, 'ledgerIndex' | 'transactionIndex'>,
  context: Pick<SchemaResolutionContext, 'ledgerIndex' | 'transactionIndex'>,
): boolean {
  return (
    schema.ledgerIndex < context.ledgerIndex ||
    (schema.ledgerIndex === context.ledgerIndex &&
      schema.transactionIndex < context.transactionIndex)
  )
}

function requireReference(
  uid: string,
  relation: 'extends' | 'supersedes',
  context: SchemaResolutionContext,
): RegisteredSchema {
  const referenced = context.getSchema(uid)
  if (referenced === undefined || referenced.uid !== uid) {
    return fail('INVALID_SCHEMA_REFERENCE', `${relation} schema was not found`, `$.${relation}`, {
      uid,
    })
  }
  if (referenced.networkId !== context.networkId) {
    return fail(
      'INVALID_SCHEMA_REFERENCE',
      `${relation} schema belongs to another network`,
      `$.${relation}`,
    )
  }
  if (!isEarlier(referenced, context)) {
    return fail(
      'INVALID_SCHEMA_REFERENCE',
      `${relation} schema must be registered earlier`,
      `$.${relation}`,
    )
  }
  return referenced
}

function resolve(
  schema: SchemaDefinition,
  context: SchemaResolutionContext,
  visiting: Set<string>,
): ResolvedSchema {
  let fields = Object.create(null) as SchemaFields
  let lineage: string[] = []

  if (schema.extends !== undefined) {
    if (visiting.size >= MAX_SCHEMA_DEPTH - 1 || visiting.has(schema.extends)) {
      return fail(
        'INVALID_SCHEMA_REFERENCE',
        'Schema inheritance is cyclic or too deep',
        '$.extends',
      )
    }
    const parent = requireReference(schema.extends, 'extends', context)
    visiting.add(schema.extends)
    const resolvedParent = resolve(
      parseSchema(parent.definition),
      {
        networkId: parent.networkId,
        publisher: parent.publisher,
        ledgerIndex: parent.ledgerIndex,
        transactionIndex: parent.transactionIndex,
        getSchema: context.getSchema,
      },
      visiting,
    )
    visiting.delete(schema.extends)
    fields = Object.assign(Object.create(null) as SchemaFields, resolvedParent.fields)
    lineage = [...resolvedParent.lineage, schema.extends]
  }

  for (const [name, descriptor] of Object.entries(schema.fields)) {
    if (Object.hasOwn(fields, name)) {
      return fail(
        'INVALID_SCHEMA_REFERENCE',
        `Inherited field ${name} cannot be redefined`,
        `$.fields.${name}`,
      )
    }
    fields[name] = descriptor
  }

  if (countSchemaFields(fields) > MAX_SCHEMA_FIELDS) {
    return fail('INVALID_SCHEMA', `Resolved schema exceeds ${MAX_SCHEMA_FIELDS} fields`, '$.fields')
  }

  if (schema.supersedes !== undefined) {
    const previous = requireReference(schema.supersedes, 'supersedes', context)
    if (previous.publisher !== context.publisher) {
      return fail(
        'INVALID_SCHEMA_REFERENCE',
        'Only the original publisher may supersede a schema',
        '$.supersedes',
      )
    }
  }

  return { definition: schema, fields, lineage }
}

export function resolveSchema(
  input: SchemaDefinition,
  context: SchemaResolutionContext,
): ResolvedSchema {
  if (
    !isUint32(context.networkId) ||
    !isUint32(context.ledgerIndex) ||
    !isUint32(context.transactionIndex) ||
    !isValidClassicAddress(context.publisher) ||
    typeof context.getSchema !== 'function'
  ) {
    return fail('INVALID_SCHEMA_REFERENCE', 'Invalid schema resolution context', '$context')
  }
  return resolve(parseSchema(input), context, new Set())
}
