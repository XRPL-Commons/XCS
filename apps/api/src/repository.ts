import {
  credentialEvents,
  credentialGenerations,
  indexerStatuses,
  ledgerCheckpoints,
  networkProfiles,
  schemaEvents,
  schemas,
  type XcsDatabase,
} from '@xcs-protocol/db'
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  lt,
  max,
  min,
  or,
  sql,
} from 'drizzle-orm'

import type { ApiRepository } from './types.js'
import { MAX_SCHEMA_CATALOG_ENTRIES } from './schema-catalog.js'

const MAX_UINT32 = 4_294_967_295

export class PostgresApiRepository implements ApiRepository {
  constructor(private readonly db: XcsDatabase) {}

  withConsistentSnapshot<T>(callback: (repository: ApiRepository) => Promise<T>): Promise<T> {
    return this.db.transaction(
      (transaction) => callback(new PostgresApiRepository(transaction as unknown as XcsDatabase)),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }

  async getDatabaseTime(): Promise<Date> {
    // Raw timestamptz values are strings in postgres.js. Asking PostgreSQL for
    // epoch milliseconds keeps this boundary independent from timestamp text
    // parsing and from the server's DateStyle setting.
    const [row] = await this.db.execute<{ nowMilliseconds: number }>(sql`
      SELECT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::double precision
        AS "nowMilliseconds"
    `)
    if (row === undefined || !Number.isFinite(row.nowMilliseconds)) {
      throw new Error('PostgreSQL returned an invalid current timestamp')
    }
    const now = new Date(row.nowMilliseconds)
    if (!Number.isFinite(now.getTime())) {
      throw new Error('PostgreSQL returned an invalid current timestamp')
    }
    return now
  }

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`)
  }

  listNetworks() {
    return this.db
      .select()
      .from(networkProfiles)
      .where(eq(networkProfiles.enabled, true))
      .orderBy(asc(networkProfiles.profileId))
  }

  async getNetwork(profileId: string) {
    const [row] = await this.db
      .select()
      .from(networkProfiles)
      .where(and(eq(networkProfiles.profileId, profileId), eq(networkProfiles.enabled, true)))
      .limit(1)
    return row
  }

  async getIndexerStatus(profileId: string) {
    const [row] = await this.db
      .select()
      .from(indexerStatuses)
      .where(eq(indexerStatuses.profileId, profileId))
      .limit(1)
    return row
  }

  async getLatestCheckpoint(profileId: string) {
    const [row] = await this.db
      .select()
      .from(ledgerCheckpoints)
      .where(eq(ledgerCheckpoints.profileId, profileId))
      .orderBy(desc(ledgerCheckpoints.ledgerIndex))
      .limit(1)
    return row
  }

  async getSchema(profileId: string, schemaUid: string) {
    const [row] = await this.db
      .select()
      .from(schemas)
      .where(and(eq(schemas.profileId, profileId), eq(schemas.schemaUid, schemaUid)))
      .limit(1)
    return row
  }

  getSchemaProjectionEvidence(input: Parameters<ApiRepository['getSchemaProjectionEvidence']>[0]) {
    if (input.schemaUids.length === 0) return Promise.resolve([])
    return this.db
      .select({ schema: schemas, registration: schemaEvents })
      .from(schemas)
      .innerJoin(
        schemaEvents,
        and(
          eq(schemaEvents.profileId, schemas.profileId),
          eq(schemaEvents.transactionHash, schemas.registrationTransactionHash),
        ),
      )
      .where(
        and(
          eq(schemas.profileId, input.profileId),
          inArray(schemas.schemaUid, [...input.schemaUids]),
        ),
      )
  }

  async getSchemaCatalogEvidence(input: Parameters<ApiRepository['getSchemaCatalogEvidence']>[0]) {
    const rows = await this.db.execute<{ schemaUid: string }>(sql`
      WITH RECURSIVE catalog AS (
        SELECT schema_uid, parent_uid, supersedes_uid
        FROM schemas
        WHERE profile_id = ${input.profileId}
          AND schema_uid = ${input.targetUid}
        UNION
        SELECT related.schema_uid, related.parent_uid, related.supersedes_uid
        FROM catalog AS catalog_entry
        JOIN schemas AS related
          ON related.profile_id = ${input.profileId}
         AND (
           related.schema_uid = catalog_entry.parent_uid
           OR related.schema_uid = catalog_entry.supersedes_uid
         )
      )
      SELECT schema_uid AS "schemaUid"
      FROM catalog
      LIMIT ${MAX_SCHEMA_CATALOG_ENTRIES + 1}
    `)
    return this.getSchemaProjectionEvidence({
      profileId: input.profileId,
      schemaUids: rows.map((row) => row.schemaUid),
    })
  }

  async getSchemaRegistrationByTransaction(
    input: Parameters<ApiRepository['getSchemaRegistrationByTransaction']>[0],
  ) {
    const [row] = await this.db
      .select()
      .from(schemaEvents)
      .where(
        and(
          eq(schemaEvents.profileId, input.profileId),
          eq(schemaEvents.transactionHash, input.transactionHash),
        ),
      )
      .limit(1)
    return row
  }

  listSchemas(input: Parameters<ApiRepository['listSchemas']>[0]) {
    const filters = [eq(schemas.profileId, input.profileId)]
    if (input.publisher !== undefined) {
      filters.push(eq(schemas.publisher, input.publisher))
    }
    if (input.cursor !== undefined) {
      filters.push(
        or(
          gt(schemas.ledgerIndex, input.cursor.ledgerIndex),
          and(
            eq(schemas.ledgerIndex, input.cursor.ledgerIndex),
            gt(schemas.transactionIndex, input.cursor.transactionIndex),
          ),
          and(
            eq(schemas.ledgerIndex, input.cursor.ledgerIndex),
            eq(schemas.transactionIndex, input.cursor.transactionIndex),
            gt(schemas.schemaUid, input.cursor.schemaUid),
          ),
        )!,
      )
    }

    return this.db
      .select()
      .from(schemas)
      .where(and(...filters))
      .orderBy(asc(schemas.ledgerIndex), asc(schemas.transactionIndex), asc(schemas.schemaUid))
      .limit(input.limit + 1)
  }

  searchSchemas(input: Parameters<ApiRepository['searchSchemas']>[0]) {
    const filters = [eq(schemas.profileId, input.profileId)]
    if (input.publisher !== undefined) {
      filters.push(eq(schemas.publisher, input.publisher))
    } else if (input.query !== undefined) {
      filters.push(
        sql`to_tsvector('simple', ${schemas.name} || ' ' || ${schemas.description}) @@ plainto_tsquery('simple', ${input.query})`,
      )
    }
    return this.db
      .select()
      .from(schemas)
      .where(and(...filters))
      .orderBy(desc(schemas.ledgerIndex), desc(schemas.transactionIndex), desc(schemas.schemaUid))
      .limit(input.limit + 1)
  }

  listSchemaRegistrations(input: Parameters<ApiRepository['listSchemaRegistrations']>[0]) {
    const filters = [eq(schemaEvents.profileId, input.profileId)]
    if (input.cursor !== undefined) {
      filters.push(
        or(
          lt(schemaEvents.ledgerIndex, input.cursor.ledgerIndex),
          and(
            eq(schemaEvents.ledgerIndex, input.cursor.ledgerIndex),
            lt(schemaEvents.transactionIndex, input.cursor.transactionIndex),
          ),
          and(
            eq(schemaEvents.ledgerIndex, input.cursor.ledgerIndex),
            eq(schemaEvents.transactionIndex, input.cursor.transactionIndex),
            lt(schemaEvents.transactionHash, input.cursor.transactionHash),
          ),
        )!,
      )
    }
    return this.db
      .select()
      .from(schemaEvents)
      .where(and(...filters))
      .orderBy(
        desc(schemaEvents.ledgerIndex),
        desc(schemaEvents.transactionIndex),
        desc(schemaEvents.transactionHash),
      )
      .limit(input.limit + 1)
  }

  async getDiscoveryStats(input: Parameters<ApiRepository['getDiscoveryStats']>[0]) {
    const [schemaStats] = await this.db
      .select({
        total: count(),
        publishers: countDistinct(schemas.publisher),
        minimumLedgerIndex: min(schemas.ledgerIndex),
        maximumLedgerIndex: max(schemas.ledgerIndex),
      })
      .from(schemas)
      .where(eq(schemas.profileId, input.profileId))
    const [credentialStats] = await this.db
      .select({
        total: count(),
        pending: count(
          sql`CASE WHEN ${credentialGenerations.deletedLedgerIndex} IS NULL
            AND (${credentialGenerations.expiration} IS NULL OR ${credentialGenerations.expiration} > ${input.checkpointCloseTime})
            AND ${credentialGenerations.accepted} = false THEN 1 END`,
        ),
        active: count(
          sql`CASE WHEN ${credentialGenerations.deletedLedgerIndex} IS NULL
            AND (${credentialGenerations.expiration} IS NULL OR ${credentialGenerations.expiration} > ${input.checkpointCloseTime})
            AND ${credentialGenerations.accepted} = true THEN 1 END`,
        ),
        expired: count(
          sql`CASE WHEN ${credentialGenerations.deletedLedgerIndex} IS NULL
            AND ${credentialGenerations.expiration} IS NOT NULL
            AND ${credentialGenerations.expiration} <= ${input.checkpointCloseTime} THEN 1 END`,
        ),
        deleted: count(
          sql`CASE WHEN ${credentialGenerations.deletedLedgerIndex} IS NOT NULL THEN 1 END`,
        ),
        invalidEvidence: count(
          sql`CASE WHEN (${credentialGenerations.expiration} IS NOT NULL
              AND (${credentialGenerations.expiration} < 0 OR ${credentialGenerations.expiration} > ${MAX_UINT32}))
            OR ${credentialGenerations.createdLedgerIndex} < 0
            OR ${credentialGenerations.createdLedgerIndex} > ${MAX_UINT32}
            OR ${credentialGenerations.createdTransactionIndex} < 0
            OR ${credentialGenerations.lastLedgerIndex} < 0
            OR ${credentialGenerations.lastLedgerIndex} > ${MAX_UINT32}
            OR ${credentialGenerations.lastLedgerIndex} < ${credentialGenerations.createdLedgerIndex}
            OR (${credentialGenerations.deletedLedgerIndex} IS NOT NULL
              AND (${credentialGenerations.deletedLedgerIndex} < 0
                OR ${credentialGenerations.deletedLedgerIndex} > ${MAX_UINT32}
                OR ${credentialGenerations.deletedLedgerIndex} < ${credentialGenerations.createdLedgerIndex}
                OR ${credentialGenerations.deletedLedgerIndex} <> ${credentialGenerations.lastLedgerIndex}))
            THEN 1 END`,
        ),
        minimumCreatedLedgerIndex: min(credentialGenerations.createdLedgerIndex),
        maximumLastLedgerIndex: max(credentialGenerations.lastLedgerIndex),
      })
      .from(credentialGenerations)
      .where(eq(credentialGenerations.profileId, input.profileId))
    if (schemaStats === undefined || credentialStats === undefined) {
      throw new Error('PostgreSQL returned incomplete discovery aggregates')
    }
    return {
      schemas: schemaStats,
      credentialGenerations: credentialStats,
    }
  }

  async getCredential(input: Parameters<ApiRepository['getCredential']>[0]) {
    const [row] = await this.db
      .select()
      .from(credentialGenerations)
      .where(
        and(
          eq(credentialGenerations.profileId, input.profileId),
          eq(credentialGenerations.issuer, input.issuer),
          eq(credentialGenerations.subject, input.subject),
          eq(credentialGenerations.schemaUid, input.schemaUid),
        ),
      )
      .orderBy(
        desc(credentialGenerations.createdLedgerIndex),
        desc(credentialGenerations.createdTransactionIndex),
      )
      .limit(1)
    return row
  }

  async getCredentialGenerationById(
    input: Parameters<ApiRepository['getCredentialGenerationById']>[0],
  ) {
    const [row] = await this.db
      .select()
      .from(credentialGenerations)
      .where(
        and(
          eq(credentialGenerations.profileId, input.profileId),
          eq(credentialGenerations.generationId, input.generationId),
        ),
      )
      .limit(1)
    return row
  }

  getCredentialEvents(input: Parameters<ApiRepository['getCredentialEvents']>[0]) {
    return this.db
      .select()
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, input.profileId),
          eq(credentialEvents.issuer, input.issuer),
          eq(credentialEvents.subject, input.subject),
          eq(credentialEvents.schemaUid, input.schemaUid),
        ),
      )
      .orderBy(
        asc(credentialEvents.ledgerIndex),
        asc(credentialEvents.transactionIndex),
        asc(credentialEvents.nodeIndex),
      )
      .limit(input.limit)
  }

  getCredentialEventsByTransaction(
    input: Parameters<ApiRepository['getCredentialEventsByTransaction']>[0],
  ) {
    return this.db
      .select()
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, input.profileId),
          eq(credentialEvents.transactionHash, input.transactionHash),
          eq(credentialEvents.issuer, input.issuer),
          eq(credentialEvents.subject, input.subject),
          eq(credentialEvents.schemaUid, input.schemaUid),
        ),
      )
      .orderBy(asc(credentialEvents.nodeIndex))
      .limit(input.limit)
  }

  getCredentialEventsByGeneration(
    input: Parameters<ApiRepository['getCredentialEventsByGeneration']>[0],
  ) {
    return this.db
      .select()
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, input.profileId),
          eq(credentialEvents.generationId, input.generationId),
        ),
      )
      .orderBy(
        asc(credentialEvents.ledgerIndex),
        asc(credentialEvents.transactionIndex),
        asc(credentialEvents.nodeIndex),
      )
      .limit(input.limit)
  }

  async getTransactionProjectionSummary(
    input: Parameters<ApiRepository['getTransactionProjectionSummary']>[0],
  ) {
    const registration = await this.getSchemaRegistrationByTransaction(input)
    const [firstCredentialEvent] = await this.db
      .select()
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, input.profileId),
          eq(credentialEvents.transactionHash, input.transactionHash),
        ),
      )
      .orderBy(asc(credentialEvents.nodeIndex))
      .limit(1)
    const [eventCount] = await this.db
      .select({ value: count() })
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, input.profileId),
          eq(credentialEvents.transactionHash, input.transactionHash),
        ),
      )
    if (eventCount === undefined) {
      throw new Error('PostgreSQL returned an incomplete transaction aggregate')
    }
    return {
      registration,
      firstCredentialEvent,
      credentialEventCount: eventCount.value,
    }
  }

  getCredentialEventsByTransactionPage(
    input: Parameters<ApiRepository['getCredentialEventsByTransactionPage']>[0],
  ) {
    const filters = [
      eq(credentialEvents.profileId, input.profileId),
      eq(credentialEvents.transactionHash, input.transactionHash),
    ]
    if (input.afterNodeIndex !== undefined) {
      filters.push(gt(credentialEvents.nodeIndex, input.afterNodeIndex))
    }
    return this.db
      .select()
      .from(credentialEvents)
      .where(and(...filters))
      .orderBy(asc(credentialEvents.nodeIndex))
      .limit(input.limit + 1)
  }
}
