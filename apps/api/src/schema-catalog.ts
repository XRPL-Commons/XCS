import {
  parseNetworkProfile,
  parseSchema,
  type NetworkProfile,
  type SchemaDefinition,
} from '@xcs-protocol/core'
import type { LedgerCheckpointRow, NetworkProfileRow, SchemaRow } from '@xcs-protocol/db'

import { authoritativeResolvedSchema, SchemaProjectionInvalidError } from './schema-projection.js'
import type { SchemaProjectionEvidence } from './types.js'

export const MAX_SCHEMA_CATALOG_ENTRIES = 256

class SchemaCatalogLimitExceededError extends Error {
  readonly code = 'SCHEMA_CATALOG_LIMIT_EXCEEDED'

  constructor() {
    super('Schema catalog exceeds the supported closure size')
    this.name = 'SchemaCatalogLimitExceededError'
  }
}

export interface SchemaCatalogEntry {
  uid: string
  definition: SchemaDefinition
  publisher: string
  ledgerIndex: number
  ledgerHash: string
  transactionIndex: number
  transactionHash: string
}

export interface SchemaCatalogBundle {
  format: 'xcs-schema-catalog/1'
  profile: NetworkProfile
  targetUid: string
  checkpoint: { ledgerIndex: number; ledgerHash: string }
  schemas: SchemaCatalogEntry[]
}

function networkProfile(row: NetworkProfileRow): NetworkProfile {
  return parseNetworkProfile({
    profileId: row.profileId,
    xcsVersion: row.xcsVersion,
    networkId: row.networkId,
    requiredAmendment: row.requiredAmendment,
    registryAddress: row.registryAddress,
    registrationAmountDrops: String(row.registrationAmountDrops),
    activationLedgerIndex: row.activationLedgerIndex,
    activationLedgerHash: row.activationLedgerHash,
  })
}

function compareEvidence(left: SchemaProjectionEvidence, right: SchemaProjectionEvidence): number {
  return (
    left.schema.ledgerIndex - right.schema.ledgerIndex ||
    left.schema.transactionIndex - right.schema.transactionIndex
  )
}

export function authoritativeSchemaCatalogBundle(input: {
  network: NetworkProfileRow
  checkpoint: LedgerCheckpointRow
  target: SchemaRow
  evidence: readonly SchemaProjectionEvidence[]
}): SchemaCatalogBundle {
  try {
    if (input.evidence.length > MAX_SCHEMA_CATALOG_ENTRIES) {
      throw new SchemaCatalogLimitExceededError()
    }
    const expected = {
      profileId: input.network.profileId,
      networkId: input.network.networkId,
      activationLedgerIndex: input.network.activationLedgerIndex,
    }
    const evidence = [...input.evidence].sort(compareEvidence)
    for (const item of evidence) {
      authoritativeResolvedSchema(item.schema, evidence, {
        ...expected,
        schemaUid: item.schema.schemaUid,
      })
    }
    authoritativeResolvedSchema(input.target, evidence, {
      ...expected,
      schemaUid: input.target.schemaUid,
    })

    return {
      format: 'xcs-schema-catalog/1',
      profile: networkProfile(input.network),
      targetUid: input.target.schemaUid,
      checkpoint: {
        ledgerIndex: input.checkpoint.ledgerIndex,
        ledgerHash: input.checkpoint.ledgerHash,
      },
      schemas: evidence.map(({ schema, registration }) => ({
        uid: schema.schemaUid,
        definition: parseSchema(schema.definition),
        publisher: schema.publisher,
        ledgerIndex: schema.ledgerIndex,
        ledgerHash: registration.ledgerHash,
        transactionIndex: schema.transactionIndex,
        transactionHash: schema.registrationTransactionHash,
      })),
    }
  } catch (error) {
    if (error instanceof SchemaProjectionInvalidError) throw error
    throw new SchemaProjectionInvalidError({ cause: error })
  }
}
