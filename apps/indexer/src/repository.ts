import {
  acquireIndexerLease,
  credentialEvents,
  credentialGenerations,
  haltIndexer as haltDatabaseIndexer,
  ledgerCheckpoints,
  lockActiveIndexerLease,
  networkProfiles,
  releaseIndexerLease,
  renewIndexerLease,
  runSerializableTransaction,
  schemaEvents,
  schemas,
  updateIndexerStatus as updateDatabaseIndexerStatus,
  type AcquiredIndexerLease,
  type IndexerLeaseToken,
  type XcsDatabase,
} from '@xcs-protocol/db'
import type { JsonValue } from '@xcs-protocol/core'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'

import { assertLedgerContinuity } from './continuity.js'
import type {
  Checkpoint,
  CredentialMutation,
  DatabaseScope,
  IndexerHaltStatus,
  IndexerRepository,
  IndexerStatusUpdate,
  LedgerProjection,
  NetworkProfile,
  SchemaCatalogEntry,
} from './types.js'
import { canonicalJson } from './serialization.js'

export type IndexerRepositoryErrorCode = 'CHECKPOINT_EVIDENCE_MISSING' | 'CHECKPOINT_CONFLICT'

export class IndexerRepositoryError extends Error {
  constructor(
    readonly code: IndexerRepositoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IndexerRepositoryError'
  }
}

export class IndexerDatabaseScopeError extends Error {
  readonly code = 'DATABASE_SCOPE_CONFLICT'

  constructor(profileId: string) {
    super(`Exclusive database scope for ${profileId} rejects a database containing another profile`)
    this.name = 'IndexerDatabaseScopeError'
  }
}

export interface PostgresIndexerRepositoryOptions {
  databaseScope?: DatabaseScope
}

type StoredNetworkProfile = Pick<
  typeof networkProfiles.$inferSelect,
  | 'profileId'
  | 'xcsVersion'
  | 'networkId'
  | 'requiredAmendment'
  | 'registryAddress'
  | 'registrationAmountDrops'
  | 'activationLedgerIndex'
  | 'activationLedgerHash'
>

export function assertStoredProfileMatches(
  stored: StoredNetworkProfile,
  configured: NetworkProfile,
): void {
  const expected: StoredNetworkProfile = {
    profileId: configured.profileId,
    xcsVersion: configured.xcsVersion,
    networkId: configured.networkId,
    requiredAmendment: configured.requiredAmendment.toUpperCase(),
    registryAddress: configured.registryAddress,
    registrationAmountDrops: Number(configured.registrationAmountDrops),
    activationLedgerIndex: configured.activationLedgerIndex,
    activationLedgerHash: configured.activationLedgerHash.toLowerCase(),
  }
  const mismatches = (Object.keys(expected) as Array<keyof StoredNetworkProfile>).filter(
    (field) => stored[field] !== expected[field],
  )
  if (mismatches.length > 0) {
    throw new Error(
      `Stored network profile ${configured.profileId} differs from configuration: ${mismatches.join(', ')}`,
    )
  }
}

function checkpointFromRow(row: typeof ledgerCheckpoints.$inferSelect): Checkpoint {
  return {
    ledgerIndex: row.ledgerIndex,
    ledgerHash: row.ledgerHash,
    parentHash: row.parentHash,
    closeTime: row.closeTime,
    transactionCount: row.transactionCount,
    transactionRoot: row.transactionRoot,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored schema value is not an object')
  }
  return value as Record<string, unknown>
}

function plainDatabaseJson(value: unknown): JsonValue {
  // Strict JSON intentionally uses null-prototype objects. Drizzle inspects
  // value prototypes before JSONB encoding, so materialize an equivalent
  // ordinary JSON value at the persistence boundary.
  return JSON.parse(canonicalJson(value)) as JsonValue
}

async function ensureNetworkProfile(database: XcsDatabase, profile: NetworkProfile): Promise<void> {
  await database
    .insert(networkProfiles)
    .values({
      profileId: profile.profileId,
      xcsVersion: profile.xcsVersion,
      networkId: profile.networkId,
      requiredAmendment: profile.requiredAmendment.toUpperCase(),
      registryAddress: profile.registryAddress,
      registrationAmountDrops: Number(profile.registrationAmountDrops),
      activationLedgerIndex: profile.activationLedgerIndex,
      activationLedgerHash: profile.activationLedgerHash.toLowerCase(),
    })
    .onConflictDoNothing({ target: networkProfiles.profileId })
  const [storedProfile] = await database
    .select()
    .from(networkProfiles)
    .where(eq(networkProfiles.profileId, profile.profileId))
    .limit(1)
  if (storedProfile === undefined) throw new Error('Network profile insert returned no row')
  assertStoredProfileMatches(storedProfile, profile)
}

export class PostgresIndexerRepository implements IndexerRepository {
  private readonly databaseScope: DatabaseScope

  constructor(
    private readonly db: XcsDatabase,
    options: PostgresIndexerRepositoryOptions = {},
  ) {
    this.databaseScope = options.databaseScope ?? 'shared'
  }

  async initializeProfile(profile: NetworkProfile): Promise<void> {
    await runSerializableTransaction(this.db, async (tx) => {
      if (this.databaseScope === 'exclusive-profile') {
        const rows = await tx.select({ profileId: networkProfiles.profileId }).from(networkProfiles)
        if (rows.some((row) => row.profileId !== profile.profileId)) {
          throw new IndexerDatabaseScopeError(profile.profileId)
        }
      }
      await ensureNetworkProfile(tx as unknown as XcsDatabase, profile)
    })
  }

  async acquireLease(
    profileId: string,
    writerId: string,
    leaseDurationMs: number,
  ): Promise<AcquiredIndexerLease> {
    return acquireIndexerLease(this.db, { profileId, writerId, leaseDurationMs })
  }

  async renewLease(
    token: IndexerLeaseToken,
    leaseDurationMs: number,
  ): Promise<AcquiredIndexerLease> {
    return renewIndexerLease(this.db, token, { leaseDurationMs })
  }

  async updateIndexerStatus(token: IndexerLeaseToken, status: IndexerStatusUpdate): Promise<void> {
    await updateDatabaseIndexerStatus(this.db, token, {
      state: status.state,
      ...(status.primarySourceTip === undefined
        ? {}
        : { primarySourceTip: status.primarySourceTip }),
      ...(status.secondarySourceTip === undefined
        ? {}
        : { secondarySourceTip: status.secondarySourceTip }),
      ...(status.lastAgreedLedgerIndex === undefined
        ? {}
        : { lastAgreedLedgerIndex: status.lastAgreedLedgerIndex }),
      ...(status.lastAgreedLedgerHash === undefined
        ? {}
        : { lastAgreedLedgerHash: status.lastAgreedLedgerHash }),
    })
  }

  async releaseLease(token: IndexerLeaseToken): Promise<void> {
    await releaseIndexerLease(this.db, token)
  }

  async haltIndexer(
    token: IndexerLeaseToken,
    status: IndexerHaltStatus,
    errorCode: string,
  ): Promise<void> {
    await haltDatabaseIndexer(this.db, token, status, errorCode)
  }

  async getLastCheckpoint(profileId: string): Promise<Checkpoint | undefined> {
    const [row] = await this.db
      .select()
      .from(ledgerCheckpoints)
      .where(eq(ledgerCheckpoints.profileId, profileId))
      .orderBy(desc(ledgerCheckpoints.ledgerIndex))
      .limit(1)
    return row === undefined ? undefined : checkpointFromRow(row)
  }

  async getSchemaCatalog(profileId: string): Promise<SchemaCatalogEntry[]> {
    const [profile] = await this.db
      .select({ networkId: networkProfiles.networkId })
      .from(networkProfiles)
      .where(eq(networkProfiles.profileId, profileId))
      .limit(1)
    if (profile === undefined) return []
    const rows = await this.db
      .select()
      .from(schemas)
      .where(eq(schemas.profileId, profileId))
      .orderBy(asc(schemas.ledgerIndex), asc(schemas.transactionIndex))

    return rows.map((row) => ({
      uid: row.schemaUid,
      definition: row.definition as unknown as SchemaCatalogEntry['definition'],
      resolved: asRecord(row.resolvedDefinition) as unknown as SchemaCatalogEntry['resolved'],
      publisher: row.publisher,
      networkId: profile.networkId,
      ledgerIndex: row.ledgerIndex,
      transactionIndex: row.transactionIndex,
      name: row.name,
      description: row.description,
      transactionHash: row.registrationTransactionHash,
    }))
  }

  async persistLedger(
    profile: NetworkProfile,
    projection: LedgerProjection,
    token: IndexerLeaseToken,
    status: IndexerStatusUpdate,
  ): Promise<'inserted' | 'already_processed'> {
    if (token.profileId !== profile.profileId) {
      throw new Error('Indexer lease profile does not match the projected profile')
    }
    return this.db.transaction(async (tx) => {
      await lockActiveIndexerLease(tx as unknown as XcsDatabase, token)

      await ensureNetworkProfile(tx as unknown as XcsDatabase, profile)

      const [sameIndex] = await tx
        .select()
        .from(ledgerCheckpoints)
        .where(
          and(
            eq(ledgerCheckpoints.profileId, profile.profileId),
            eq(ledgerCheckpoints.ledgerIndex, projection.ledger.ledgerIndex),
          ),
        )
        .limit(1)
      if (sameIndex !== undefined) {
        if (sameIndex.ledgerHash !== projection.ledger.ledgerHash) {
          throw new IndexerRepositoryError(
            'CHECKPOINT_CONFLICT',
            `Checkpoint conflict at ledger ${projection.ledger.ledgerIndex}: ${sameIndex.ledgerHash} != ${projection.ledger.ledgerHash}`,
          )
        }
        if (sameIndex.transactionRoot === null) {
          throw new IndexerRepositoryError(
            'CHECKPOINT_EVIDENCE_MISSING',
            `Checkpoint ${projection.ledger.ledgerIndex} predates transaction-root persistence and must be rebuilt`,
          )
        }
        if (
          sameIndex.transactionRoot !== projection.ledger.transactionRoot ||
          sameIndex.transactionCount !== projection.ledger.transactions.length
        ) {
          throw new IndexerRepositoryError(
            'CHECKPOINT_CONFLICT',
            `Checkpoint transaction evidence conflicts at ledger ${projection.ledger.ledgerIndex}`,
          )
        }
        await updateDatabaseIndexerStatus(tx as unknown as XcsDatabase, token, status)
        return 'already_processed' as const
      }

      const [latest] = await tx
        .select()
        .from(ledgerCheckpoints)
        .where(eq(ledgerCheckpoints.profileId, profile.profileId))
        .orderBy(desc(ledgerCheckpoints.ledgerIndex))
        .limit(1)
      assertLedgerContinuity(
        profile,
        latest === undefined ? undefined : checkpointFromRow(latest),
        projection.ledger,
      )

      for (const registration of projection.schemaRegistrations) {
        await tx
          .insert(schemaEvents)
          .values({
            profileId: profile.profileId,
            transactionHash: registration.transactionHash,
            ledgerIndex: projection.ledger.ledgerIndex,
            ledgerHash: projection.ledger.ledgerHash,
            transactionIndex: registration.transactionIndex,
            publisher: registration.publisher,
            status: registration.status,
            ...(registration.status === 'accepted'
              ? {
                  schemaUid: registration.schemaUid,
                  memoJson: plainDatabaseJson(registration.memoJson),
                }
              : {
                  reasonCode: registration.reasonCode,
                  ...(registration.memoJson === undefined
                    ? {}
                    : { memoJson: plainDatabaseJson(registration.memoJson) }),
                }),
          })
          .onConflictDoNothing()

        if (registration.status === 'accepted') {
          await tx
            .insert(schemas)
            .values({
              profileId: profile.profileId,
              schemaUid: registration.schemaUid,
              publisher: registration.publisher,
              name: registration.definition.name,
              description: registration.definition.description,
              ...(registration.definition.extends === undefined
                ? {}
                : { parentUid: registration.definition.extends }),
              ...(registration.definition.supersedes === undefined
                ? {}
                : { supersedesUid: registration.definition.supersedes }),
              definition: plainDatabaseJson(
                registration.definition as unknown as JsonValue,
              ) as Record<string, unknown>,
              resolvedDefinition: plainDatabaseJson(
                registration.resolved as unknown as JsonValue,
              ) as Record<string, unknown>,
              registrationTransactionHash: registration.transactionHash,
              ledgerIndex: projection.ledger.ledgerIndex,
              transactionIndex: registration.transactionIndex,
            })
            .onConflictDoNothing()
        }
      }

      for (const mutation of projection.credentialMutations) {
        await this.persistCredentialMutation(
          tx as unknown as XcsDatabase,
          profile.profileId,
          projection,
          mutation,
        )
      }

      await tx.insert(ledgerCheckpoints).values({
        profileId: profile.profileId,
        ledgerIndex: projection.ledger.ledgerIndex,
        ledgerHash: projection.ledger.ledgerHash,
        parentHash: projection.ledger.parentHash,
        closeTime: projection.ledger.closeTime,
        transactionCount: projection.ledger.transactions.length,
        transactionRoot: projection.ledger.transactionRoot,
      })

      await updateDatabaseIndexerStatus(tx as unknown as XcsDatabase, token, status)

      return 'inserted' as const
    })
  }

  private async persistCredentialMutation(
    tx: XcsDatabase,
    profileId: string,
    projection: LedgerProjection,
    mutation: CredentialMutation,
  ): Promise<void> {
    let generationId: string

    if (mutation.eventType === 'created') {
      generationId = mutation.transactionHash
      await tx.insert(credentialGenerations).values({
        profileId,
        generationId,
        ledgerObjectId: mutation.ledgerObjectId,
        issuer: mutation.issuer,
        subject: mutation.subject,
        schemaUid: mutation.schemaUid,
        ...(mutation.uriHex === undefined ? {} : { uriHex: mutation.uriHex }),
        ...(mutation.expiration === undefined ? {} : { expiration: mutation.expiration }),
        accepted: mutation.accepted,
        createdLedgerIndex: projection.ledger.ledgerIndex,
        createdTransactionIndex: mutation.transactionIndex,
        lastLedgerIndex: projection.ledger.ledgerIndex,
      })
    } else {
      const [liveGeneration] = await tx
        .select()
        .from(credentialGenerations)
        .where(
          and(
            eq(credentialGenerations.profileId, profileId),
            eq(credentialGenerations.ledgerObjectId, mutation.ledgerObjectId),
            isNull(credentialGenerations.deletedLedgerIndex),
          ),
        )
        .orderBy(desc(credentialGenerations.createdLedgerIndex))
        .limit(1)
      if (liveGeneration === undefined) {
        throw new Error(
          `Credential ${mutation.ledgerObjectId} was ${mutation.eventType} without a live generation`,
        )
      }
      generationId = liveGeneration.generationId

      if (mutation.eventType === 'accepted') {
        await tx
          .update(credentialGenerations)
          .set({
            accepted: true,
            lastLedgerIndex: projection.ledger.ledgerIndex,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(credentialGenerations.profileId, profileId),
              eq(credentialGenerations.generationId, generationId),
            ),
          )
      } else {
        await tx
          .update(credentialGenerations)
          .set({
            lastLedgerIndex: projection.ledger.ledgerIndex,
            deletedLedgerIndex: projection.ledger.ledgerIndex,
            deletionCause: mutation.deletionCause,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(credentialGenerations.profileId, profileId),
              eq(credentialGenerations.generationId, generationId),
            ),
          )
      }
    }

    await tx
      .insert(credentialEvents)
      .values({
        profileId,
        transactionHash: mutation.transactionHash,
        nodeIndex: mutation.nodeIndex,
        generationId,
        ledgerObjectId: mutation.ledgerObjectId,
        ledgerIndex: projection.ledger.ledgerIndex,
        ledgerHash: projection.ledger.ledgerHash,
        transactionIndex: mutation.transactionIndex,
        eventType: mutation.eventType,
        issuer: mutation.issuer,
        subject: mutation.subject,
        schemaUid: mutation.schemaUid,
        ...(mutation.uriHex === undefined ? {} : { uriHex: mutation.uriHex }),
        ...(mutation.expiration === undefined ? {} : { expiration: mutation.expiration }),
        accepted: mutation.accepted,
        ...(mutation.deletionCause === undefined ? {} : { deletionCause: mutation.deletionCause }),
        snapshot: mutation.snapshot,
      })
      .onConflictDoNothing()
  }
}
