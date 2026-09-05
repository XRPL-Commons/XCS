import {
  computeSchemaUid,
  type FieldDescriptor,
  type ResolvedSchema,
  type SchemaDefinition,
  parseSchema,
} from '@xcs-protocol/core'
import type { SchemaRow } from '@xcs-protocol/db'
import { isValidClassicAddress } from 'xrpl'

import { canonicalJson } from './serialization.js'
import type { SchemaProjectionEvidence } from './types.js'

const HASH = /^[0-9a-f]{64}$/u
const RESOLVED_SCHEMA_KEYS = new Set(['definition', 'fields', 'lineage'])
const MAX_INHERITANCE_LINEAGE = 15
const MAX_UINT32 = 4_294_967_295

export class SchemaProjectionInvalidError extends Error {
  readonly code = 'SCHEMA_PROJECTION_INVALID'
  readonly statusCode = 503

  constructor(options: { cause?: unknown } = {}) {
    super('The indexed schema projection is incomplete or inconsistent.', options)
    this.name = 'SchemaProjectionInvalidError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonical(value: unknown): string {
  return canonicalJson(value)
}

function validateProjectedFields(value: unknown): Record<string, FieldDescriptor> {
  const projection = parseSchema({
    xcsVersion: '0.1',
    name: 'Resolved projection',
    description: 'Resolved projection fields.',
    fields: value,
  })
  if (canonical(projection.fields) !== canonical(value)) {
    throw new Error('Resolved fields are not normalized')
  }
  return projection.fields
}

function assertDefinitionMetadata(row: SchemaRow, definition: SchemaDefinition): void {
  if (
    row.name !== definition.name ||
    row.description !== definition.description ||
    row.parentUid !== (definition.extends ?? null) ||
    row.supersedesUid !== (definition.supersedes ?? null)
  ) {
    throw new Error('Schema projection metadata does not match its definition')
  }
}

function storedResolvedSchema(row: SchemaRow): ResolvedSchema {
  const definition = parseSchema(row.definition)
  if (canonical(definition) !== canonical(row.definition)) {
    throw new Error('Schema definition projection is not normalized')
  }
  assertDefinitionMetadata(row, definition)

  if (!isRecord(row.resolvedDefinition)) {
    throw new Error('Resolved schema projection is not an object')
  }
  if (
    Object.keys(row.resolvedDefinition).some((key) => !RESOLVED_SCHEMA_KEYS.has(key)) ||
    Object.keys(row.resolvedDefinition).length !== RESOLVED_SCHEMA_KEYS.size
  ) {
    throw new Error('Resolved schema projection has an invalid shape')
  }

  const resolvedDefinition = parseSchema(row.resolvedDefinition.definition)
  if (
    canonical(resolvedDefinition) !== canonical(row.resolvedDefinition.definition) ||
    canonical(resolvedDefinition) !== canonical(definition)
  ) {
    throw new Error('Resolved schema definition is inconsistent')
  }
  const fields = validateProjectedFields(row.resolvedDefinition.fields)
  const lineage = row.resolvedDefinition.lineage
  if (
    !Array.isArray(lineage) ||
    lineage.length > MAX_INHERITANCE_LINEAGE ||
    lineage.some((uid) => typeof uid !== 'string' || !HASH.test(uid)) ||
    new Set(lineage).size !== lineage.length ||
    lineage.includes(row.schemaUid)
  ) {
    throw new Error('Resolved schema lineage is invalid')
  }
  if (
    (definition.extends === undefined && lineage.length !== 0) ||
    (definition.extends !== undefined &&
      (lineage.length === 0 || lineage.at(-1) !== definition.extends))
  ) {
    throw new Error('Resolved schema lineage is inconsistent with its direct parent')
  }
  return { definition, fields, lineage: [...lineage] }
}

function failClosed<T>(callback: () => T): T {
  try {
    return callback()
  } catch (error) {
    if (error instanceof SchemaProjectionInvalidError) throw error
    throw new SchemaProjectionInvalidError({ cause: error })
  }
}

export function schemaProjectionEvidenceUids(
  rows: readonly SchemaRow[],
  expectedProfileId: string,
): string[] {
  return failClosed(() => {
    const uids = new Set<string>()
    for (const row of rows) {
      if (row.profileId !== expectedProfileId || !HASH.test(row.schemaUid)) {
        throw new Error('Schema projection identity is inconsistent')
      }
      const projection = storedResolvedSchema(row)
      uids.add(row.schemaUid)
      for (const uid of projection.lineage) uids.add(uid)
    }
    return [...uids]
  })
}

function projectionFingerprint(row: SchemaRow): string {
  return canonical({
    profileId: row.profileId,
    schemaUid: row.schemaUid,
    publisher: row.publisher,
    name: row.name,
    description: row.description,
    parentUid: row.parentUid,
    supersedesUid: row.supersedesUid,
    definition: row.definition,
    resolvedDefinition: row.resolvedDefinition,
    registrationTransactionHash: row.registrationTransactionHash,
    ledgerIndex: row.ledgerIndex,
    transactionIndex: row.transactionIndex,
  })
}

function validateEvidenceRow(
  evidence: SchemaProjectionEvidence,
  expected: {
    readonly profileId: string
    readonly networkId: number
    readonly activationLedgerIndex: number
  },
): { row: SchemaRow; projection: ResolvedSchema } {
  const { schema: row, registration } = evidence
  if (
    row.profileId !== expected.profileId ||
    !HASH.test(row.schemaUid) ||
    !isValidClassicAddress(row.publisher) ||
    !Number.isSafeInteger(row.ledgerIndex) ||
    row.ledgerIndex < expected.activationLedgerIndex ||
    row.ledgerIndex > MAX_UINT32 ||
    !Number.isSafeInteger(row.transactionIndex) ||
    row.transactionIndex < 0 ||
    row.transactionIndex > MAX_UINT32
  ) {
    throw new Error('Schema projection coordinates are invalid')
  }
  const projection = storedResolvedSchema(row)
  if (
    registration.profileId !== row.profileId ||
    registration.transactionHash !== row.registrationTransactionHash ||
    !HASH.test(registration.transactionHash) ||
    registration.ledgerIndex !== row.ledgerIndex ||
    registration.transactionIndex !== row.transactionIndex ||
    registration.publisher !== row.publisher ||
    registration.status !== 'accepted' ||
    registration.reasonCode !== null ||
    registration.schemaUid !== row.schemaUid ||
    registration.memoJson === null ||
    !HASH.test(registration.ledgerHash)
  ) {
    throw new Error('Schema registration evidence is inconsistent')
  }
  const registrationDefinition = parseSchema(registration.memoJson)
  if (canonical(registrationDefinition) !== canonical(projection.definition)) {
    throw new Error('Schema definition does not match its registration memo')
  }
  if (
    computeSchemaUid({
      schema: registrationDefinition,
      networkId: expected.networkId,
      ledgerHash: registration.ledgerHash,
      ledgerIndex: registration.ledgerIndex,
      transactionIndex: registration.transactionIndex,
      publisher: registration.publisher,
    }) !== row.schemaUid
  ) {
    throw new Error('Schema UID does not match its registration evidence')
  }
  return { row, projection }
}

function isPrior(parent: SchemaRow, child: SchemaRow): boolean {
  return (
    parent.ledgerIndex < child.ledgerIndex ||
    (parent.ledgerIndex === child.ledgerIndex && parent.transactionIndex < child.transactionIndex)
  )
}

function mergeFields(target: Record<string, FieldDescriptor>, definition: SchemaDefinition): void {
  for (const [name, descriptor] of Object.entries(definition.fields)) {
    if (Object.hasOwn(target, name)) {
      throw new Error('An inherited field is overridden')
    }
    target[name] = descriptor
  }
}

export function authoritativeResolvedSchema(
  row: SchemaRow,
  evidenceRows: readonly SchemaProjectionEvidence[],
  expected: {
    readonly profileId: string
    readonly schemaUid: string
    readonly networkId: number
    readonly activationLedgerIndex: number
  },
): ResolvedSchema {
  return failClosed(() => {
    if (row.profileId !== expected.profileId || row.schemaUid !== expected.schemaUid) {
      throw new Error('Schema projection identity is inconsistent')
    }
    const targetProjection = storedResolvedSchema(row)
    const evidenceByUid = new Map<string, SchemaProjectionEvidence>()
    for (const evidence of evidenceRows) {
      if (evidenceByUid.has(evidence.schema.schemaUid)) {
        throw new Error('Schema projection evidence contains duplicate UIDs')
      }
      evidenceByUid.set(evidence.schema.schemaUid, evidence)
    }

    const chainUids = [...targetProjection.lineage, row.schemaUid]
    const chain = chainUids.map((uid) => {
      const evidence = evidenceByUid.get(uid)
      if (evidence === undefined) throw new Error('Schema ancestor evidence is missing')
      return validateEvidenceRow(evidence, expected)
    })
    if (projectionFingerprint(chain.at(-1)!.row) !== projectionFingerprint(row)) {
      throw new Error('Schema projection changed between authoritative reads')
    }

    const mergedFields = Object.create(null) as Record<string, FieldDescriptor>
    for (const [index, current] of chain.entries()) {
      const expectedLineage = chainUids.slice(0, index)
      const expectedParentUid = expectedLineage.at(-1)
      if (current.projection.definition.extends !== expectedParentUid) {
        throw new Error('Schema ancestor chain is not exact')
      }
      if (index > 0 && !isPrior(chain[index - 1]!.row, current.row)) {
        throw new Error('Schema parent does not precede its child')
      }
      mergeFields(mergedFields, current.projection.definition)
      const reconstructed: ResolvedSchema = {
        definition: current.projection.definition,
        fields: validateProjectedFields(mergedFields),
        lineage: expectedLineage,
      }
      if (canonical(reconstructed) !== canonical(current.projection)) {
        throw new Error('Stored resolved schema does not match its ancestor definitions')
      }
    }

    return {
      definition: targetProjection.definition,
      fields: { ...mergedFields },
      lineage: [...targetProjection.lineage],
    }
  })
}
