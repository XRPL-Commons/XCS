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
    return fail(
      relation === 'extends' ? 'SCHEMA_PARENT_NOT_FOUND' : 'SCHEMA_SUPERSEDES_NOT_FOUND',
      `${relation} schema was not found`,
      `$.${relation}`,
      { uid },
    )
  }
  if (referenced.networkId !== context.networkId) {
    return fail(
      relation === 'extends' ? 'SCHEMA_PARENT_NETWORK_MISMATCH' : 'SCHEMA_SUPERSEDES_NOT_FOUND',
      `${relation} schema belongs to another network`,
      `$.${relation}`,
    )
  }
  if (!isEarlier(referenced, context)) {
    return fail(
      relation === 'extends' ? 'SCHEMA_PARENT_NOT_PRIOR' : 'SCHEMA_SUPERSEDES_NOT_PRIOR',
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
    if (visiting.has(schema.extends)) {
      return fail('SCHEMA_INHERITANCE_CYCLE', 'Schema inheritance is cyclic', '$.extends')
    }
    if (visiting.size >= MAX_SCHEMA_DEPTH - 1) {
      return fail('SCHEMA_DEPTH_EXCEEDED', 'Schema inheritance is too deep', '$.extends')
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
        'SCHEMA_OVERRIDE_FORBIDDEN',
        `Inherited field ${name} cannot be redefined`,
        `$.fields.${name}`,
      )
    }
    fields[name] = descriptor
  }

  if (countSchemaFields(fields) > MAX_SCHEMA_FIELDS) {
    return fail(
      'SCHEMA_FIELD_LIMIT_EXCEEDED',
      `Resolved schema exceeds ${MAX_SCHEMA_FIELDS} fields`,
      '$.fields',
    )
  }

  if (schema.supersedes !== undefined) {
    const previous = requireReference(schema.supersedes, 'supersedes', context)
    if (previous.publisher !== context.publisher) {
      return fail(
        'SCHEMA_SUPERSEDES_PUBLISHER_MISMATCH',
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
    return fail('SCHEMA_INVALID', 'Invalid schema resolution context', '$context')
  }
  return resolve(parseSchema(input), context, new Set())
}
