import { randomUUID } from 'node:crypto'

import {
  computeSchemaUid,
  MAX_SCHEMA_CATALOG_ENTRIES,
  validateSchema,
  type SchemaDefinition,
} from '@xcs-protocol/core'
import { createDatabaseClient, schemaEvents, schemas, type DatabaseClient } from '@xcs-protocol/db'
import { bootstrapDatabase, databasePasswordFromUrl } from '@xcs-protocol/db/bootstrap'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresOperationalMetricsRepository } from '../src/operational-metrics-repository.js'
import { PostgresPinningRepository } from '../src/pinning-repository.js'
import { PostgresApiRepository } from '../src/repository.js'
import { authoritativeSchemaCatalogBundle } from '../src/schema-catalog.js'

const rawAdminDatabaseUrl = process.env.XCS_TEST_DATABASE_URL?.trim()
const adminDatabaseUrl = rawAdminDatabaseUrl === '' ? undefined : rawAdminDatabaseUrl
const postgresTestsRequired = process.env.XCS_REQUIRE_POSTGRES_TESTS === '1'

if (postgresTestsRequired && adminDatabaseUrl === undefined) {
  throw new Error('XCS_TEST_DATABASE_URL is required by test:postgres')
}

const TEMPORARY_DATABASE_PATTERN = /^xcs_api_it_[0-9a-f]{32}$/u
const PROFILE_ID = 'metrics-testnet'
const CATALOG_PROFILE_ID = 'catalog-testnet'
const HASH = 'a'.repeat(64)
const CATALOG_LEDGER_HASH = '2'.repeat(64)
const CATALOG_NETWORK_ID = 2
const PUBLISHER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const INDEXER_DATABASE_PASSWORD = 'indexer-metrics-integration-password-01'
const API_DATABASE_PASSWORD = 'api-metrics-integration-password-000001'
const MONITOR_DATABASE_PASSWORD = 'monitor-metrics-integration-password-01'

let adminClient: DatabaseClient | undefined
let databaseClient: DatabaseClient | undefined
let runtimeApiClient: DatabaseClient | undefined
let temporaryDatabaseName: string | undefined
let temporaryDatabaseUrl: string | undefined
let runtimeRoleCleanupAllowed = false

function databaseUrl(baseUrl: string, databaseName: string): string {
  if (!TEMPORARY_DATABASE_PATTERN.test(databaseName)) {
    throw new Error('Refusing to use an invalid PostgreSQL test database name')
  }
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('XCS_TEST_DATABASE_URL must use the postgres protocol')
  }
  parsed.pathname = `/${databaseName}`
  return parsed.toString()
}

function runtimeDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const parsed = new URL(baseUrl)
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

interface CatalogNode {
  uid: string
  transactionHash: string
  transactionIndex: number
  definition: SchemaDefinition
  resolvedDefinition: Record<string, unknown>
}

function transactionHash(sequence: number): string {
  return sequence.toString(16).padStart(64, '0')
}

function validCatalogNodes(count: number): CatalogNode[] {
  const nodes: CatalogNode[] = []
  for (let index = 0; index < count; index += 1) {
    const root = nodes[0]
    const previous = nodes.at(-1)
    const ownFields = { [`field${index}`]: { type: 'string' as const } }
    const definition = validateSchema({
      xcsVersion: '0.1',
      name: `Catalog schema ${index}`,
      description: `PostgreSQL catalog closure node ${index}.`,
      ...(index >= 2 && root !== undefined ? { extends: root.uid } : {}),
      ...(index >= 1 && previous !== undefined ? { supersedes: previous.uid } : {}),
      fields: ownFields,
    })
    const uid = computeSchemaUid({
      networkId: CATALOG_NETWORK_ID,
      ledgerHash: CATALOG_LEDGER_HASH,
      ledgerIndex: 100,
      transactionIndex: index,
      publisher: PUBLISHER,
      schema: definition,
    })
    nodes.push({
      uid,
      transactionHash: transactionHash(index + 1),
      transactionIndex: index,
      definition,
      resolvedDefinition: {
        definition,
        fields:
          index >= 2 && root !== undefined
            ? { ...root.definition.fields, ...definition.fields }
            : { ...definition.fields },
        lineage: index >= 2 && root !== undefined ? [root.uid] : [],
      },
    })
  }
  return nodes
}

const describePostgres = adminDatabaseUrl === undefined ? describe.skip : describe

describePostgres('PostgreSQL 18 API integration', () => {
  beforeAll(async () => {
    if (adminDatabaseUrl === undefined) return
    adminClient = createDatabaseClient(adminDatabaseUrl)
    const [version] = await adminClient.sql<{ serverVersion: number }[]>`
      SELECT current_setting('server_version_num')::integer AS "serverVersion"
    `
    if (
      version === undefined ||
      version.serverVersion < 180_000 ||
      version.serverVersion >= 190_000
    ) {
      throw new Error('PostgreSQL integration tests require PostgreSQL 18')
    }

    temporaryDatabaseName = `xcs_api_it_${randomUUID().replaceAll('-', '')}`
    if (!TEMPORARY_DATABASE_PATTERN.test(temporaryDatabaseName)) {
      throw new Error('Generated PostgreSQL test database name is invalid')
    }
    await adminClient.sql`
      CREATE DATABASE ${adminClient.sql(temporaryDatabaseName)} TEMPLATE template0 ENCODING 'UTF8'
    `
    temporaryDatabaseUrl = databaseUrl(adminDatabaseUrl, temporaryDatabaseName)
    databaseClient = createDatabaseClient(temporaryDatabaseUrl)
    runtimeRoleCleanupAllowed = true
    const bootstrapPasswords = {
      clusterScope: 'dedicated',
      administratorPassword: databasePasswordFromUrl(temporaryDatabaseUrl),
      indexerPassword: INDEXER_DATABASE_PASSWORD,
      apiPassword: API_DATABASE_PASSWORD,
      monitorPassword: MONITOR_DATABASE_PASSWORD,
    } as const
    await bootstrapDatabase(databaseClient, bootstrapPasswords)
    await bootstrapDatabase(databaseClient, bootstrapPasswords)
    runtimeApiClient = createDatabaseClient(
      runtimeDatabaseUrl(temporaryDatabaseUrl, 'xcs_api', API_DATABASE_PASSWORD),
    )
  }, 120_000)

  afterAll(async () => {
    const cleanupErrors: unknown[] = []
    if (runtimeApiClient !== undefined) {
      try {
        await runtimeApiClient.close()
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        runtimeApiClient = undefined
      }
    }
    if (databaseClient !== undefined) {
      try {
        await databaseClient.close()
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        databaseClient = undefined
      }
    }
    if (adminClient !== undefined) {
      try {
        if (
          temporaryDatabaseName !== undefined &&
          TEMPORARY_DATABASE_PATTERN.test(temporaryDatabaseName)
        ) {
          await adminClient.sql`
            DROP DATABASE IF EXISTS ${adminClient.sql(temporaryDatabaseName)} WITH (FORCE)
          `
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (runtimeRoleCleanupAllowed) {
        try {
          await adminClient.sql`
            DROP ROLE IF EXISTS
              xcs_indexer,
              xcs_api,
              xcs_monitor
          `
          runtimeRoleCleanupAllowed = false
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await adminClient.close()
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        adminClient = undefined
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean API PostgreSQL integration database')
    }
  })

  it('decodes database time inside an authoritative read snapshot', async () => {
    if (runtimeApiClient === undefined) {
      throw new Error('PostgreSQL test database is not initialized')
    }

    const repository = new PostgresApiRepository(runtimeApiClient.db)
    const observedAt = await repository.withConsistentSnapshot((snapshot) =>
      snapshot.getDatabaseTime(),
    )

    expect(observedAt).toBeInstanceOf(Date)
    expect(Number.isFinite(observedAt.getTime())).toBe(true)
  })

  it('reads exact durable metrics with the least-privilege xcs_api role', async () => {
    if (databaseClient === undefined || runtimeApiClient === undefined) {
      throw new Error('PostgreSQL test database is not initialized')
    }
    await databaseClient.sql`
      INSERT INTO network_profiles (
        profile_id, xcs_version, network_id, required_amendment,
        registry_address, registration_amount_drops,
        activation_ledger_index, activation_ledger_hash, enabled
      ) VALUES (
        ${PROFILE_ID}, '0.1', 1, ${'b'.repeat(64)},
        'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 1, 100, ${HASH}, true
      )
    `
    await databaseClient.sql`
      INSERT INTO ledger_checkpoints (
        profile_id, ledger_index, ledger_hash, parent_hash, close_time,
        transaction_count, transaction_root
      ) VALUES (${PROFILE_ID}, 100, ${HASH}, ${'c'.repeat(64)}, 800000000, 2, ${'d'.repeat(64)})
    `
    await databaseClient.sql`
      INSERT INTO indexer_status (
        profile_id, state, primary_source_tip, secondary_source_tip,
        last_agreed_ledger_index, last_agreed_ledger_hash,
        error_code, writer_epoch
      ) VALUES (
        ${PROFILE_ID}, 'halted', 103, 102, 100, ${HASH},
        'LEDGER_PARENT_MISMATCH', 1
      )
    `
    await databaseClient.sql`
      INSERT INTO indexer_incidents (
        profile_id, writer_epoch, error_code, primary_source_tip,
        secondary_source_tip, last_agreed_ledger_index, last_agreed_ledger_hash
      ) VALUES (
        ${PROFILE_ID}, 1, 'LEDGER_PARENT_MISMATCH', 103, 102, 100, ${HASH}
      )
    `
    await databaseClient.sql`
      INSERT INTO schema_events (
        profile_id, transaction_hash, ledger_index, ledger_hash, transaction_index,
        publisher, status, reason_code, schema_uid, memo_json
      ) VALUES
        (
          ${PROFILE_ID}, ${'e'.repeat(64)}, 100, ${HASH}, 0,
          'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'accepted', null,
          ${'f'.repeat(64)}, '{}'::jsonb
        ),
        (
          ${PROFILE_ID}, ${'1'.repeat(64)}, 100, ${HASH}, 1,
          'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'rejected',
          'REGISTRATION_INVALID', null, null
        )
    `

    const snapshot = await new PostgresOperationalMetricsRepository(
      runtimeApiClient.db,
    ).getSnapshot()

    expect(snapshot.observedAt).toBeInstanceOf(Date)
    expect(snapshot.database.usedConnections).toBeGreaterThan(0)
    expect(snapshot.database.maxConnections).toBeGreaterThan(0)
    expect(snapshot.database.sizeBytes).toBeGreaterThan(0)
    expect(snapshot.profiles).toEqual([
      {
        profileId: PROFILE_ID,
        activationLedgerIndex: 100,
        status: {
          state: 'halted',
          primarySourceTip: 103,
          secondarySourceTip: 102,
          lastAgreedLedgerIndex: 100,
          lastAgreedLedgerHash: HASH,
          errorCode: 'LEDGER_PARENT_MISMATCH',
          writerPresent: false,
          leaseExpiresAt: null,
          updatedAt: expect.any(Date),
        },
        checkpoint: {
          ledgerIndex: 100,
          ledgerHash: HASH,
          closeTime: 800_000_000,
          transactionRootPresent: true,
        },
        acceptedRegistrations: 1,
        rejectedRegistrations: 1,
        haltHistory: {
          total: 1,
          latest: {
            writerEpoch: 1,
            errorCode: 'LEDGER_PARENT_MISMATCH',
            primarySourceTip: 103,
            secondarySourceTip: 102,
            lastAgreedLedgerIndex: 100,
            recordedAt: expect.any(Date),
          },
        },
      },
    ])
  })

  it('serializes concurrent pin quota reservations without raw advisory locks', async () => {
    if (databaseClient === undefined || runtimeApiClient === undefined) {
      throw new Error('PostgreSQL test database is not initialized')
    }
    await databaseClient.sql`
      INSERT INTO network_profiles (
        profile_id, xcs_version, network_id, required_amendment,
        registry_address, registration_amount_drops,
        activation_ledger_index, activation_ledger_hash, enabled
      ) VALUES (
        ${PROFILE_ID}, '0.1', 1, ${'b'.repeat(64)},
        ${PUBLISHER}, 1, 100, ${HASH}, true
      ) ON CONFLICT (profile_id) DO NOTHING
    `
    const repository = new PostgresPinningRepository(runtimeApiClient.db)
    const now = new Date('2030-01-01T00:00:00.000Z')
    const wallet = PUBLISHER
    const requesterIpHash = '6'.repeat(64)
    const challengeIds = ['7'.repeat(64), '8'.repeat(64)] as const

    await Promise.all(
      challengeIds.map((challengeId) =>
        repository.createChallenge({
          challengeId,
          profileId: PROFILE_ID,
          wallet,
          requesterIpHash,
          message: `quota:${challengeId}`,
          expiresAt: new Date(now.getTime() + 5 * 60_000),
        }),
      ),
    )

    const reservations = await Promise.allSettled(
      challengeIds.map((challengeId, index) =>
        repository.reservePin({
          pinId: (index === 0 ? '9' : 'a').repeat(64),
          challengeId,
          profileId: PROFILE_ID,
          wallet,
          requesterIpHash,
          cid: `bafybeigdyrz${index === 0 ? 't' : 'u'}`,
          byteLength: 128,
          expiresAt: new Date(now.getTime() + 60 * 60_000),
          now,
          dailyLimit: 1,
        }),
      ),
    )

    expect(reservations.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(reservations.find((result) => result.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { statusCode: 429 },
    })
    const [storedPins] = await runtimeApiClient.sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM demo_pins
      WHERE requester_ip_hash = ${requesterIpHash}
    `
    expect(storedPins?.count).toBe(1)
  })

  it('executes bounded recursive schema catalog closure without truncation', async () => {
    if (databaseClient === undefined || runtimeApiClient === undefined) {
      throw new Error('PostgreSQL test database is not initialized')
    }

    await databaseClient.sql`
      INSERT INTO network_profiles (
        profile_id, xcs_version, network_id, required_amendment,
        registry_address, registration_amount_drops,
        activation_ledger_index, activation_ledger_hash, enabled
      ) VALUES (
        ${CATALOG_PROFILE_ID}, '0.1', ${CATALOG_NETWORK_ID}, ${'3'.repeat(64)},
        ${PUBLISHER}, 1, 100, ${CATALOG_LEDGER_HASH}, true
      )
    `
    await databaseClient.sql`
      INSERT INTO ledger_checkpoints (
        profile_id, ledger_index, ledger_hash, parent_hash, close_time,
        transaction_count, transaction_root
      ) VALUES (
        ${CATALOG_PROFILE_ID}, 100, ${CATALOG_LEDGER_HASH}, ${'4'.repeat(64)},
        800000100, ${MAX_SCHEMA_CATALOG_ENTRIES + 3}, ${'5'.repeat(64)}
      )
    `

    const nodes = validCatalogNodes(MAX_SCHEMA_CATALOG_ENTRIES + 1)
    const cycleAUid = `${'f'.repeat(63)}0`
    const cycleBUid = `${'f'.repeat(63)}1`
    const cycleADefinition = validateSchema({
      xcsVersion: '0.1',
      name: 'Projection cycle A',
      description: 'Deliberately corrupted relational projection used to exercise the SQL CTE.',
      extends: cycleBUid,
      fields: { cycleA: { type: 'string' } },
    })
    const cycleBDefinition = validateSchema({
      xcsVersion: '0.1',
      name: 'Projection cycle B',
      description: 'Deliberately corrupted relational projection used to exercise the SQL CTE.',
      supersedes: cycleAUid,
      fields: { cycleB: { type: 'string' } },
    })
    const cycleNodes: CatalogNode[] = [
      {
        uid: cycleAUid,
        transactionHash: transactionHash(MAX_SCHEMA_CATALOG_ENTRIES + 2),
        transactionIndex: MAX_SCHEMA_CATALOG_ENTRIES + 1,
        definition: cycleADefinition,
        resolvedDefinition: {
          definition: cycleADefinition,
          fields: cycleADefinition.fields,
          lineage: [cycleBUid],
        },
      },
      {
        uid: cycleBUid,
        transactionHash: transactionHash(MAX_SCHEMA_CATALOG_ENTRIES + 3),
        transactionIndex: MAX_SCHEMA_CATALOG_ENTRIES + 2,
        definition: cycleBDefinition,
        resolvedDefinition: {
          definition: cycleBDefinition,
          fields: cycleBDefinition.fields,
          lineage: [],
        },
      },
    ]
    const storedNodes = [...nodes, ...cycleNodes]

    await databaseClient.db.insert(schemaEvents).values(
      storedNodes.map((node) => ({
        profileId: CATALOG_PROFILE_ID,
        transactionHash: node.transactionHash,
        ledgerIndex: 100,
        ledgerHash: CATALOG_LEDGER_HASH,
        transactionIndex: node.transactionIndex,
        publisher: PUBLISHER,
        status: 'accepted',
        schemaUid: node.uid,
        memoJson: node.definition,
      })),
    )
    await databaseClient.db.insert(schemas).values(
      storedNodes.map((node) => ({
        profileId: CATALOG_PROFILE_ID,
        schemaUid: node.uid,
        publisher: PUBLISHER,
        name: node.definition.name,
        description: node.definition.description,
        parentUid: node.definition.extends,
        supersedesUid: node.definition.supersedes,
        definition: node.definition as unknown as Record<string, unknown>,
        resolvedDefinition: node.resolvedDefinition,
        registrationTransactionHash: node.transactionHash,
        ledgerIndex: 100,
        transactionIndex: node.transactionIndex,
      })),
    )

    const repository = new PostgresApiRepository(runtimeApiClient.db)
    const network = await repository.getNetwork(CATALOG_PROFILE_ID)
    const checkpoint = await repository.getLatestCheckpoint(CATALOG_PROFILE_ID)
    const acceptedTarget = nodes[MAX_SCHEMA_CATALOG_ENTRIES - 1]!
    const acceptedTargetRow = await repository.getSchema(CATALOG_PROFILE_ID, acceptedTarget.uid)
    const acceptedEvidence = await repository.getSchemaCatalogEvidence({
      profileId: CATALOG_PROFILE_ID,
      targetUid: acceptedTarget.uid,
    })

    expect(network).toBeDefined()
    expect(checkpoint).toBeDefined()
    expect(acceptedTargetRow).toBeDefined()
    expect(acceptedEvidence).toHaveLength(MAX_SCHEMA_CATALOG_ENTRIES)
    expect(new Set(acceptedEvidence.map(({ schema }) => schema.schemaUid))).toEqual(
      new Set(nodes.slice(0, MAX_SCHEMA_CATALOG_ENTRIES).map(({ uid }) => uid)),
    )
    const acceptedBundle = authoritativeSchemaCatalogBundle({
      network: network!,
      checkpoint: checkpoint!,
      target: acceptedTargetRow!,
      evidence: acceptedEvidence,
    })
    expect(acceptedBundle.schemas).toHaveLength(MAX_SCHEMA_CATALOG_ENTRIES)
    expect(acceptedBundle.schemas.filter(({ uid }) => uid === nodes[0]!.uid)).toHaveLength(1)

    const cycleEvidence = await repository.getSchemaCatalogEvidence({
      profileId: CATALOG_PROFILE_ID,
      targetUid: cycleAUid,
    })
    expect(cycleEvidence.map(({ schema }) => schema.schemaUid).sort()).toEqual(
      [cycleAUid, cycleBUid].sort(),
    )

    const overflowTarget = nodes[MAX_SCHEMA_CATALOG_ENTRIES]!
    const overflowTargetRow = await repository.getSchema(CATALOG_PROFILE_ID, overflowTarget.uid)
    const overflowEvidence = await repository.getSchemaCatalogEvidence({
      profileId: CATALOG_PROFILE_ID,
      targetUid: overflowTarget.uid,
    })
    expect(overflowTargetRow).toBeDefined()
    expect(overflowEvidence).toHaveLength(MAX_SCHEMA_CATALOG_ENTRIES + 1)
    expect(new Set(overflowEvidence.map(({ schema }) => schema.schemaUid))).toEqual(
      new Set(nodes.map(({ uid }) => uid)),
    )

    expect(() =>
      authoritativeSchemaCatalogBundle({
        network: network!,
        checkpoint: checkpoint!,
        target: overflowTargetRow!,
        evidence: overflowEvidence,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SCHEMA_PROJECTION_INVALID',
        cause: expect.objectContaining({ code: 'SCHEMA_CATALOG_LIMIT_EXCEEDED' }),
      }),
    )
  }, 30_000)
})
