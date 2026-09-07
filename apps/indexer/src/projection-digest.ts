import type { JsonValue } from '@xcs-protocol/core'
import {
  credentialEvents,
  credentialGenerations,
  ledgerCheckpoints,
  networkProfiles,
  schemaEvents,
  schemas,
  type XcsDatabase,
} from '@xcs-protocol/db'
import { asc, eq } from 'drizzle-orm'

import { canonicalJson, encodeUtf8, sha256Hex } from './serialization.js'

const PROJECTION_DIGEST_VERSION = 'xcs-projection-v1' as const

export interface ProjectionRowCounts {
  ledgerCheckpoints: number
  schemaEvents: number
  schemas: number
  credentialEvents: number
  credentialGenerations: number
}

export interface ProjectionDigest {
  version: typeof PROJECTION_DIGEST_VERSION
  profileId: string
  algorithm: 'sha256'
  digestHex: string
  rowCounts: ProjectionRowCounts
}

export interface ProjectionSnapshot {
  version: typeof PROJECTION_DIGEST_VERSION
  profile: Record<string, JsonValue>
  ledgerCheckpoints: Array<Record<string, JsonValue>>
  schemaEvents: Array<Record<string, JsonValue>>
  schemas: Array<Record<string, JsonValue>>
  credentialEvents: Array<Record<string, JsonValue>>
  credentialGenerations: Array<Record<string, JsonValue>>
}

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue
}

/**
 * Hashes only ledger-derived and immutable profile data. Database timestamps,
 * writer leases, readiness and pinning records are deliberately excluded so
 * independent replays can be compared across hosts and wall clocks.
 */
export function digestProjectionSnapshot(snapshot: ProjectionSnapshot): string {
  return sha256Hex(encodeUtf8(canonicalJson(snapshot)))
}

async function computeProjectionDigestSnapshot(
  database: XcsDatabase,
  profileId: string,
): Promise<ProjectionDigest> {
  const [profile] = await database
    .select({
      profileId: networkProfiles.profileId,
      xcsVersion: networkProfiles.xcsVersion,
      networkId: networkProfiles.networkId,
      requiredAmendment: networkProfiles.requiredAmendment,
      registryAddress: networkProfiles.registryAddress,
      registrationAmountDrops: networkProfiles.registrationAmountDrops,
      activationLedgerIndex: networkProfiles.activationLedgerIndex,
      activationLedgerHash: networkProfiles.activationLedgerHash,
    })
    .from(networkProfiles)
    .where(eq(networkProfiles.profileId, profileId))
    .limit(1)

  if (profile === undefined) {
    throw new Error(`Unknown network profile: ${profileId}`)
  }

  const [checkpointRows, schemaEventRows, schemaRows, credentialEventRows, generationRows] =
    await Promise.all([
      database
        .select({
          ledgerIndex: ledgerCheckpoints.ledgerIndex,
          ledgerHash: ledgerCheckpoints.ledgerHash,
          parentHash: ledgerCheckpoints.parentHash,
          closeTime: ledgerCheckpoints.closeTime,
          transactionCount: ledgerCheckpoints.transactionCount,
          transactionRoot: ledgerCheckpoints.transactionRoot,
        })
        .from(ledgerCheckpoints)
        .where(eq(ledgerCheckpoints.profileId, profileId))
        .orderBy(asc(ledgerCheckpoints.ledgerIndex)),
      database
        .select({
          transactionHash: schemaEvents.transactionHash,
          ledgerIndex: schemaEvents.ledgerIndex,
          ledgerHash: schemaEvents.ledgerHash,
          transactionIndex: schemaEvents.transactionIndex,
          publisher: schemaEvents.publisher,
          status: schemaEvents.status,
          reasonCode: schemaEvents.reasonCode,
          schemaUid: schemaEvents.schemaUid,
          memoJson: schemaEvents.memoJson,
        })
        .from(schemaEvents)
        .where(eq(schemaEvents.profileId, profileId))
        .orderBy(
          asc(schemaEvents.ledgerIndex),
          asc(schemaEvents.transactionIndex),
          asc(schemaEvents.transactionHash),
        ),
      database
        .select({
          schemaUid: schemas.schemaUid,
          publisher: schemas.publisher,
          name: schemas.name,
          description: schemas.description,
          parentUid: schemas.parentUid,
          supersedesUid: schemas.supersedesUid,
          definition: schemas.definition,
          resolvedDefinition: schemas.resolvedDefinition,
          registrationTransactionHash: schemas.registrationTransactionHash,
          ledgerIndex: schemas.ledgerIndex,
          transactionIndex: schemas.transactionIndex,
        })
        .from(schemas)
        .where(eq(schemas.profileId, profileId))
        .orderBy(asc(schemas.ledgerIndex), asc(schemas.transactionIndex), asc(schemas.schemaUid)),
      database
        .select({
          transactionHash: credentialEvents.transactionHash,
          nodeIndex: credentialEvents.nodeIndex,
          generationId: credentialEvents.generationId,
          ledgerObjectId: credentialEvents.ledgerObjectId,
          ledgerIndex: credentialEvents.ledgerIndex,
          ledgerHash: credentialEvents.ledgerHash,
          transactionIndex: credentialEvents.transactionIndex,
          eventType: credentialEvents.eventType,
          issuer: credentialEvents.issuer,
          subject: credentialEvents.subject,
          schemaUid: credentialEvents.schemaUid,
          uriHex: credentialEvents.uriHex,
          expiration: credentialEvents.expiration,
          accepted: credentialEvents.accepted,
          deletionCause: credentialEvents.deletionCause,
          snapshot: credentialEvents.snapshot,
        })
        .from(credentialEvents)
        .where(eq(credentialEvents.profileId, profileId))
        .orderBy(
          asc(credentialEvents.ledgerIndex),
          asc(credentialEvents.transactionIndex),
          asc(credentialEvents.nodeIndex),
          asc(credentialEvents.transactionHash),
        ),
      database
        .select({
          generationId: credentialGenerations.generationId,
          ledgerObjectId: credentialGenerations.ledgerObjectId,
          issuer: credentialGenerations.issuer,
          subject: credentialGenerations.subject,
          schemaUid: credentialGenerations.schemaUid,
          uriHex: credentialGenerations.uriHex,
          expiration: credentialGenerations.expiration,
          accepted: credentialGenerations.accepted,
          createdLedgerIndex: credentialGenerations.createdLedgerIndex,
          createdTransactionIndex: credentialGenerations.createdTransactionIndex,
          lastLedgerIndex: credentialGenerations.lastLedgerIndex,
          deletedLedgerIndex: credentialGenerations.deletedLedgerIndex,
          deletionCause: credentialGenerations.deletionCause,
        })
        .from(credentialGenerations)
        .where(eq(credentialGenerations.profileId, profileId))
        .orderBy(
          asc(credentialGenerations.createdLedgerIndex),
          asc(credentialGenerations.createdTransactionIndex),
          asc(credentialGenerations.generationId),
        ),
    ])

  const snapshot: ProjectionSnapshot = {
    version: PROJECTION_DIGEST_VERSION,
    profile: {
      profileId: profile.profileId,
      xcsVersion: profile.xcsVersion,
      networkId: profile.networkId,
      requiredAmendment: profile.requiredAmendment,
      registryAddress: profile.registryAddress,
      registrationAmountDrops: profile.registrationAmountDrops,
      activationLedgerIndex: profile.activationLedgerIndex,
      activationLedgerHash: profile.activationLedgerHash,
    },
    ledgerCheckpoints: checkpointRows.map((row) => ({
      ...row,
      transactionRoot: row.transactionRoot,
    })),
    schemaEvents: schemaEventRows.map((row) => ({
      ...row,
      reasonCode: row.reasonCode,
      schemaUid: row.schemaUid,
      memoJson: jsonValue(row.memoJson),
    })),
    schemas: schemaRows.map((row) => ({
      ...row,
      parentUid: row.parentUid,
      supersedesUid: row.supersedesUid,
      definition: jsonValue(row.definition),
      resolvedDefinition: jsonValue(row.resolvedDefinition),
    })),
    credentialEvents: credentialEventRows.map((row) => ({
      ...row,
      generationId: row.generationId,
      uriHex: row.uriHex,
      expiration: row.expiration,
      deletionCause: row.deletionCause,
      snapshot: jsonValue(row.snapshot),
    })),
    credentialGenerations: generationRows.map((row) => ({
      ...row,
      uriHex: row.uriHex,
      expiration: row.expiration,
      deletedLedgerIndex: row.deletedLedgerIndex,
      deletionCause: row.deletionCause,
    })),
  }

  return {
    version: PROJECTION_DIGEST_VERSION,
    profileId,
    algorithm: 'sha256',
    digestHex: digestProjectionSnapshot(snapshot),
    rowCounts: {
      ledgerCheckpoints: checkpointRows.length,
      schemaEvents: schemaEventRows.length,
      schemas: schemaRows.length,
      credentialEvents: credentialEventRows.length,
      credentialGenerations: generationRows.length,
    },
  }
}

export async function computeProjectionDigest(
  database: XcsDatabase,
  profileId: string,
): Promise<ProjectionDigest> {
  return database.transaction(
    (transaction) =>
      computeProjectionDigestSnapshot(transaction as unknown as XcsDatabase, profileId),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}
