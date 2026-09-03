import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireIndexerLease,
  credentialEvents,
  credentialGenerations,
  createDatabaseClient,
  haltIndexer,
  indexerIncidents,
  indexerStatuses,
  ledgerCheckpoints,
  releaseIndexerLease,
  renewIndexerLease,
  schemaEvents,
  schemas,
  updateIndexerStatus,
  type DatabaseClient,
} from '@xcs-protocol/db'
import {
  databasePasswordFromUrl,
  initializeDatabase,
  provisionRuntimeDatabaseRoles,
  XCS_API_DATABASE_CONNECTION_LIMIT,
  XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
  XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
} from '@xcs-protocol/db/bootstrap'
import {
  canonicalize,
  computeSchemaUid,
  createIpfsRawPayloadUri,
  encodeUtf8,
  type JsonValue,
} from '@xcs-protocol/core'
import { and, asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { captureLedgerFixtureBundle, ledgerFixtureBundleDigest } from '../src/fixture-bundle.js'
import { prepareFixtureReplay } from '../src/fixture-replay.js'
import { computeProjectionDigest } from '../src/projection-digest.js'
import { QuorumLedgerSource } from '../src/quorum-ledger-source.js'
import { PostgresIndexerRepository } from '../src/repository.js'
import { IndexerWorker } from '../src/worker.js'
import type {
  CredentialDeletionCause,
  IndexerStatusUpdate,
  LedgerProjection,
  LedgerSource,
  LedgerSourcePreflight,
  LedgerTransaction,
  NetworkProfile,
  SchemaDefinition,
  ValidatedLedger,
} from '../src/types.js'

const rawAdminDatabaseUrl = process.env.XCS_TEST_DATABASE_URL?.trim()
const adminDatabaseUrl = rawAdminDatabaseUrl === '' ? undefined : rawAdminDatabaseUrl
const postgresTestsRequired = process.env.XCS_REQUIRE_POSTGRES_TESTS === '1'

if (postgresTestsRequired && adminDatabaseUrl === undefined) {
  throw new Error('XCS_TEST_DATABASE_URL is required by test:postgres')
}

const TEMPORARY_DATABASE_PATTERN = /^xcs_it_[0-9a-f]{32}$/u
const ACTIVATION_LEDGER_INDEX = 100
const ACTIVATION_LEDGER_HASH = 'a'.repeat(64)
const SCHEMA_UID = 'd'.repeat(64)
const SCHEMA_TRANSACTION_HASH = 'c'.repeat(64)
const CREDENTIAL_TRANSACTION_HASH = 'e'.repeat(64)
const CREDENTIAL_OBJECT_ID = 'f'.repeat(64)
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const FIXTURE_SUBJECTS = [
  SUBJECT,
  'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
  'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn',
  'rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY',
  'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
  'rrrrrrrrrrrrrrrrrrrrBZbvji',
] as const
const PROJECTION_INTEGRITY_CONSTRAINT_NAMES = [
  'ledger_checkpoints_index_uint32',
  'ledger_checkpoints_close_time_uint32',
  'schema_events_ledger_index_uint32',
  'schemas_ledger_index_uint32',
  'schemas_transaction_index',
  'credential_generations_expiration_uint32',
  'credential_generations_created_ledger_uint32',
  'credential_generations_created_transaction_index',
  'credential_generations_last_ledger_uint32',
  'credential_generations_deleted_ledger_uint32',
  'credential_generations_ledger_order',
  'credential_events_node_index',
  'credential_events_ledger_index_uint32',
  'credential_events_transaction_index',
  'credential_events_expiration_uint32',
] as const

interface TemporaryDatabase {
  name: string
  url: string
  client: DatabaseClient
}

interface TemporaryDatabaseOptions {
  initialize?: boolean
}

let adminClient: DatabaseClient | undefined
const temporaryDatabases: TemporaryDatabase[] = []
const createdDatabaseNames = new Set<string>()
let runtimeRoleCleanupAllowed = false

const INDEXER_DATABASE_PASSWORD = 'indexer-integration-password-000001'
const API_DATABASE_PASSWORD = 'api-integration-password-0000000001'
const MONITOR_DATABASE_PASSWORD = 'monitor-integration-password-00000001'

function temporaryDatabaseName(): string {
  const name = `xcs_it_${randomUUID().replaceAll('-', '')}`
  if (!TEMPORARY_DATABASE_PATTERN.test(name)) {
    throw new Error('Generated PostgreSQL test database name is invalid')
  }
  return name
}

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

async function closeAndDropTemporaryDatabases(): Promise<void> {
  const cleanupErrors: unknown[] = []

  for (const database of temporaryDatabases.splice(0).reverse()) {
    try {
      await database.client.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (adminClient !== undefined) {
    for (const name of [...createdDatabaseNames].reverse()) {
      try {
        if (!TEMPORARY_DATABASE_PATTERN.test(name)) {
          throw new Error('Refusing to drop an invalid PostgreSQL test database name')
        }
        await adminClient.sql`DROP DATABASE IF EXISTS ${adminClient.sql(name)} WITH (FORCE)`
        createdDatabaseNames.delete(name)
      } catch (error) {
        cleanupErrors.push(error)
      }
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
    throw new AggregateError(cleanupErrors, 'Failed to clean PostgreSQL integration databases')
  }
}

function runtimeDatabaseUrl(baseUrl: string, role: string, password: string): string {
  const parsed = new URL(baseUrl)
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

async function expectPermissionDenied(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: '42501' })
}

async function createTemporaryDatabase(
  baseUrl: string,
  options: TemporaryDatabaseOptions = {},
): Promise<TemporaryDatabase> {
  if (adminClient === undefined) throw new Error('PostgreSQL admin client is not initialized')

  const name = temporaryDatabaseName()
  const url = databaseUrl(baseUrl, name)
  await adminClient.sql`CREATE DATABASE ${adminClient.sql(name)} TEMPLATE template0 ENCODING 'UTF8'`
  createdDatabaseNames.add(name)

  const client = createDatabaseClient(url)
  const database = { name, url, client }
  temporaryDatabases.push(database)
  if (options.initialize !== false) {
    await initializeDatabase(client)
  }
  return database
}

async function projectionIntegrityConstraintStates(database: TemporaryDatabase) {
  const rows = await database.client.sql<
    Array<{ constraintName: string; tableName: string; validated: boolean }>
  >`
    SELECT
      constraint_object.conname AS "constraintName",
      relation.relname AS "tableName",
      constraint_object.convalidated AS validated
    FROM pg_constraint constraint_object
    JOIN pg_class relation ON relation.oid = constraint_object.conrelid
    JOIN pg_namespace namespace_object ON namespace_object.oid = relation.relnamespace
    WHERE namespace_object.nspname = 'public'
      AND constraint_object.contype = 'c'
      AND relation.relname IN (
        'ledger_checkpoints',
        'schema_events',
        'schemas',
        'credential_generations',
        'credential_events'
      )
  `
  const expectedNames = new Set<string>(PROJECTION_INTEGRITY_CONSTRAINT_NAMES)
  return rows
    .filter((row) => expectedNames.has(row.constraintName))
    .sort((left, right) => left.constraintName.localeCompare(right.constraintName))
}

async function restartConnection(database: TemporaryDatabase): Promise<DatabaseClient> {
  await database.client.close()
  database.client = createDatabaseClient(database.url)
  return database.client
}

function ledgerHash(ledgerIndex: number): string {
  return ledgerIndex === ACTIVATION_LEDGER_INDEX
    ? ACTIVATION_LEDGER_HASH
    : ledgerIndex.toString(16).padStart(64, '0')
}

function transactionRoot(ledgerIndex: number): string {
  return (ledgerIndex + 1_000).toString(16).padStart(64, '0')
}

function profile(profileId: string): NetworkProfile {
  return {
    profileId,
    xcsVersion: '0.1',
    networkId: 1,
    requiredAmendment: 'b'.repeat(64),
    registryAddress: ISSUER,
    registrationAmountDrops: '1',
    activationLedgerIndex: ACTIVATION_LEDGER_INDEX,
    activationLedgerHash: ACTIVATION_LEDGER_HASH,
  }
}

function ledger(ledgerIndex: number, transactionHashes: string[] = []): ValidatedLedger {
  return {
    ledgerIndex,
    ledgerHash: ledgerHash(ledgerIndex),
    parentHash:
      ledgerIndex === ACTIVATION_LEDGER_INDEX ? '0'.repeat(64) : ledgerHash(ledgerIndex - 1),
    accountRoot: (ledgerIndex + 2_000).toString(16).padStart(64, '0'),
    transactionRoot: transactionRoot(ledgerIndex),
    parentCloseTime: 999 + ledgerIndex,
    closeTime: 1_000 + ledgerIndex,
    closeTimeResolution: 10,
    closeFlags: 0,
    totalCoins: '100000000000000000',
    transactions: transactionHashes.map((hash, transactionIndex) => ({
      hash,
      transactionIndex,
      transaction: { TransactionType: 'Payment' },
      metadata: { TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
    })),
  }
}

function emptyProjection(value: ValidatedLedger): LedgerProjection {
  return {
    ledger: value,
    schemaRegistrations: [],
    credentialMutations: [],
    malformedCredentialNodes: 0,
  }
}

class DeterministicLedgerSource implements LedgerSource {
  constructor(
    private readonly replayProfile: NetworkProfile,
    private readonly tip: number,
  ) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async preflight(profileToCheck: NetworkProfile): Promise<LedgerSourcePreflight> {
    expect(profileToCheck).toEqual(this.replayProfile)
    return {
      networkId: this.replayProfile.networkId,
      completeLedgerRanges: [{ min: this.replayProfile.activationLedgerIndex, max: this.tip }],
      activationLedger: ledger(this.replayProfile.activationLedgerIndex),
      tips: { primary: this.tip, secondary: this.tip, effective: this.tip },
    }
  }

  async assertAmendmentEnabled(): Promise<void> {}

  async getValidatedLedgerIndex(): Promise<number> {
    return this.tip
  }

  async getValidatedLedgerTips() {
    return { primary: this.tip, secondary: this.tip, effective: this.tip }
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    return ledger(ledgerIndex)
  }
}

function readyStatus(value: ValidatedLedger): IndexerStatusUpdate {
  return {
    state: 'ready',
    primarySourceTip: value.ledgerIndex,
    secondarySourceTip: value.ledgerIndex,
    lastAgreedLedgerIndex: value.ledgerIndex,
    lastAgreedLedgerHash: value.ledgerHash,
  }
}

const schemaDefinition: SchemaDefinition = {
  xcsVersion: '0.1',
  name: 'Race participation',
  description: 'Confirms that the subject participated in a race.',
  fields: {
    raceId: { type: 'string' },
    participatedAt: { type: 'string' },
  },
}
const schemaMemoJson = {
  ...schemaDefinition,
  fields: {
    raceId: { type: 'string', optional: false },
    participatedAt: { type: 'string' },
  },
} as unknown as JsonValue

interface FixtureDeletionCase {
  cause: CredentialDeletionCause
  subject: (typeof FIXTURE_SUBJECTS)[number]
  transactionType: string
  actor: string
  accepted: boolean
  expiration?: number
  result: string
}

const FIXTURE_DELETION_CASES: readonly FixtureDeletionCase[] = [
  {
    cause: 'issuer_revoked',
    subject: FIXTURE_SUBJECTS[0],
    transactionType: 'CredentialDelete',
    actor: ISSUER,
    accepted: false,
    result: 'tesSUCCESS',
  },
  {
    cause: 'subject_rejected',
    subject: FIXTURE_SUBJECTS[1],
    transactionType: 'CredentialDelete',
    actor: FIXTURE_SUBJECTS[1],
    accepted: false,
    result: 'tesSUCCESS',
  },
  {
    cause: 'subject_removed',
    subject: FIXTURE_SUBJECTS[2],
    transactionType: 'CredentialDelete',
    actor: FIXTURE_SUBJECTS[2],
    accepted: true,
    result: 'tesSUCCESS',
  },
  {
    cause: 'expired_cleanup',
    subject: FIXTURE_SUBJECTS[3],
    transactionType: 'CredentialAccept',
    actor: FIXTURE_SUBJECTS[3],
    accepted: false,
    expiration: 1_102,
    result: 'tecEXPIRED',
  },
  {
    cause: 'account_deleted',
    subject: FIXTURE_SUBJECTS[4],
    transactionType: 'AccountDelete',
    actor: FIXTURE_SUBJECTS[4],
    accepted: false,
    result: 'tesSUCCESS',
  },
  {
    cause: 'self_deleted',
    subject: FIXTURE_SUBJECTS[5],
    transactionType: 'Payment',
    actor: ISSUER,
    accepted: false,
    expiration: 1_104,
    result: 'tesSUCCESS',
  },
]

const FIXTURE_URI_HEX = Buffer.from(createIpfsRawPayloadUri('complete-projection-fixture'), 'utf8')
  .toString('hex')
  .toUpperCase()

function fixtureHex(value: number): string {
  return value.toString(16).padStart(64, '0')
}

function fixtureObjectId(index: number): string {
  return fixtureHex(0x500 + index)
}

function fixtureCredentialFields(
  fixtureCase: FixtureDeletionCase,
  schemaUid: string,
  accepted = fixtureCase.accepted,
): Record<string, unknown> {
  return {
    Issuer: ISSUER,
    Subject: fixtureCase.subject,
    CredentialType: schemaUid.toUpperCase(),
    URI: FIXTURE_URI_HEX,
    Flags: accepted ? 0x0001_0000 : 0,
    ...(fixtureCase.expiration === undefined ? {} : { Expiration: fixtureCase.expiration }),
  }
}

function fixtureTransaction(input: {
  hash: string
  transactionIndex: number
  transaction: Record<string, unknown>
  affectedNodes?: unknown[]
  result?: string
}): LedgerTransaction {
  return {
    hash: input.hash,
    transactionIndex: input.transactionIndex,
    transaction: input.transaction,
    metadata: {
      TransactionIndex: input.transactionIndex,
      TransactionResult: input.result ?? 'tesSUCCESS',
      AffectedNodes: input.affectedNodes ?? [],
    },
  }
}

function completeProjectionFixture(replayProfile: NetworkProfile): {
  ledgers: ReadonlyMap<number, ValidatedLedger>
  schemaUid: string
} {
  const registrationText = canonicalize(schemaDefinition as unknown as JsonValue)
  const schemaUid = computeSchemaUid({
    networkId: replayProfile.networkId,
    ledgerHash: replayProfile.activationLedgerHash,
    ledgerIndex: replayProfile.activationLedgerIndex,
    transactionIndex: 0,
    publisher: ISSUER,
    schema: schemaDefinition,
  })
  const registration = fixtureTransaction({
    hash: fixtureHex(0x400),
    transactionIndex: 0,
    transaction: {
      TransactionType: 'Payment',
      Account: ISSUER,
      Destination: replayProfile.registryAddress,
      Amount: replayProfile.registrationAmountDrops,
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from('xcs:schema_register', 'utf8').toString('hex').toUpperCase(),
            MemoFormat: Buffer.from('application/json', 'utf8').toString('hex').toUpperCase(),
            MemoData: Buffer.from(registrationText, 'utf8').toString('hex').toUpperCase(),
          },
        },
      ],
    },
  })
  const creations = FIXTURE_DELETION_CASES.map((fixtureCase, index) =>
    fixtureTransaction({
      hash: fixtureHex(0x600 + index),
      transactionIndex: index,
      transaction: { TransactionType: 'CredentialCreate', Account: ISSUER },
      affectedNodes: [
        {
          CreatedNode: {
            LedgerEntryType: 'Credential',
            LedgerIndex: fixtureObjectId(index),
            NewFields: fixtureCredentialFields(fixtureCase, schemaUid, false),
          },
        },
      ],
    }),
  )
  const acceptedCaseIndex = FIXTURE_DELETION_CASES.findIndex(
    (fixtureCase) => fixtureCase.cause === 'subject_removed',
  )
  const acceptedCase = FIXTURE_DELETION_CASES[acceptedCaseIndex]
  if (acceptedCase === undefined) throw new Error('Accepted fixture case is missing')
  const acceptance = fixtureTransaction({
    hash: fixtureHex(0x700),
    transactionIndex: 0,
    transaction: { TransactionType: 'CredentialAccept', Account: acceptedCase.subject },
    affectedNodes: [
      {
        ModifiedNode: {
          LedgerEntryType: 'Credential',
          LedgerIndex: fixtureObjectId(acceptedCaseIndex),
          PreviousFields: { Flags: 0 },
          FinalFields: fixtureCredentialFields(acceptedCase, schemaUid, true),
        },
      },
    ],
  })
  const deletions = FIXTURE_DELETION_CASES.map((fixtureCase, index) =>
    fixtureTransaction({
      hash: fixtureHex(0x800 + index),
      transactionIndex: index,
      transaction: {
        TransactionType: fixtureCase.transactionType,
        Account: fixtureCase.actor,
      },
      affectedNodes: [
        {
          DeletedNode: {
            LedgerEntryType: 'Credential',
            LedgerIndex: fixtureObjectId(index),
            FinalFields: fixtureCredentialFields(fixtureCase, schemaUid),
          },
        },
      ],
      result: fixtureCase.result,
    }),
  )

  return {
    schemaUid,
    ledgers: new Map([
      [
        ACTIVATION_LEDGER_INDEX,
        { ...ledger(ACTIVATION_LEDGER_INDEX), transactions: [registration] },
      ],
      [
        ACTIVATION_LEDGER_INDEX + 1,
        { ...ledger(ACTIVATION_LEDGER_INDEX + 1), transactions: creations },
      ],
      [
        ACTIVATION_LEDGER_INDEX + 2,
        { ...ledger(ACTIVATION_LEDGER_INDEX + 2), transactions: [acceptance] },
      ],
      [
        ACTIVATION_LEDGER_INDEX + 3,
        { ...ledger(ACTIVATION_LEDGER_INDEX + 3), transactions: deletions },
      ],
    ]),
  }
}

class CompleteProjectionFixtureSource implements LedgerSource {
  private readonly tip: number

  constructor(
    private readonly replayProfile: NetworkProfile,
    private readonly ledgers: ReadonlyMap<number, ValidatedLedger>,
  ) {
    this.tip = Math.max(...ledgers.keys())
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async preflight(profileToCheck: NetworkProfile): Promise<LedgerSourcePreflight> {
    if (
      canonicalize(profileToCheck as unknown as JsonValue) !==
      canonicalize(this.replayProfile as unknown as JsonValue)
    ) {
      throw new Error('Fixture replay profile mismatch')
    }
    return {
      networkId: this.replayProfile.networkId,
      completeLedgerRanges: [{ min: this.replayProfile.activationLedgerIndex, max: this.tip }],
      activationLedger: await this.getLedger(this.replayProfile.activationLedgerIndex),
      tips: this.tips(),
    }
  }

  async assertAmendmentEnabled(): Promise<void> {}

  async getValidatedLedgerIndex(): Promise<number> {
    return this.tip
  }

  async getValidatedLedgerTips() {
    return this.tips()
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    const value = this.ledgers.get(ledgerIndex)
    if (value === undefined) throw new Error(`Missing fixture ledger ${ledgerIndex}`)
    return structuredClone(value)
  }

  private tips() {
    return { primary: this.tip, secondary: this.tip, effective: this.tip }
  }
}

function replayProjections(): [LedgerProjection, LedgerProjection] {
  const registrationLedger = ledger(ACTIVATION_LEDGER_INDEX, [SCHEMA_TRANSACTION_HASH])
  const credentialLedger = ledger(ACTIVATION_LEDGER_INDEX + 1, [CREDENTIAL_TRANSACTION_HASH])

  return [
    {
      ledger: registrationLedger,
      schemaRegistrations: [
        {
          status: 'accepted',
          transactionHash: SCHEMA_TRANSACTION_HASH,
          transactionIndex: 0,
          publisher: ISSUER,
          schemaUid: SCHEMA_UID,
          memoJson: schemaMemoJson,
          definition: schemaDefinition,
          resolved: {
            definition: schemaDefinition,
            fields: schemaDefinition.fields,
            lineage: [],
          },
        },
      ],
      credentialMutations: [],
      malformedCredentialNodes: 0,
    },
    {
      ledger: credentialLedger,
      schemaRegistrations: [],
      credentialMutations: [
        {
          transactionHash: CREDENTIAL_TRANSACTION_HASH,
          transactionIndex: 0,
          nodeIndex: 0,
          ledgerObjectId: CREDENTIAL_OBJECT_ID,
          eventType: 'created',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: false,
          snapshot: {
            Issuer: ISSUER,
            Subject: SUBJECT,
            CredentialType: SCHEMA_UID.toUpperCase(),
          },
        },
      ],
      malformedCredentialNodes: 0,
    },
  ]
}

async function replayProjection(database: TemporaryDatabase, replayProfile: NetworkProfile) {
  const repository = new PostgresIndexerRepository(database.client.db)
  await repository.initializeProfile(replayProfile)
  const token = await repository.acquireLease(
    replayProfile.profileId,
    `writer-${database.name.replaceAll('_', '-')}`,
    300_000,
  )
  const [first, second] = replayProjections()

  await expect(
    repository.persistLedger(replayProfile, first, token, {
      state: 'catching_up',
      primarySourceTip: second.ledger.ledgerIndex,
      secondarySourceTip: second.ledger.ledgerIndex,
      lastAgreedLedgerIndex: first.ledger.ledgerIndex,
      lastAgreedLedgerHash: first.ledger.ledgerHash,
    }),
  ).resolves.toBe('inserted')
  await expect(
    repository.persistLedger(replayProfile, second, token, readyStatus(second.ledger)),
  ).resolves.toBe('inserted')
}

async function boundedReplay(
  database: TemporaryDatabase,
  replayProfile: NetworkProfile,
  primaryTip: number,
  secondaryTip: number,
) {
  const target = ledger(ACTIVATION_LEDGER_INDEX + 2)
  let caughtUpLedger: number | undefined
  const worker = new IndexerWorker({
    profile: replayProfile,
    source: new QuorumLedgerSource(
      new DeterministicLedgerSource(replayProfile, primaryTip),
      new DeterministicLedgerSource(replayProfile, secondaryTip),
    ),
    repository: new PostgresIndexerRepository(database.client.db),
    pollIntervalMs: 250,
    batchSize: 2,
    writerId: `bounded-${database.name.replaceAll('_', '-')}`,
    replayTarget: {
      ledgerIndex: target.ledgerIndex,
      ledgerHash: target.ledgerHash,
    },
    observer: {
      caughtUp: (ledgerIndex) => {
        caughtUpLedger = ledgerIndex
      },
    },
  })

  await worker.start(new AbortController().signal)
  expect(caughtUpLedger).toBe(target.ledgerIndex)
  return computeProjectionDigest(database.client.db, replayProfile.profileId)
}

const describePostgres = describe.skipIf(adminDatabaseUrl === undefined)

describePostgres('PostgreSQL 18 indexer integration', () => {
  beforeAll(async () => {
    if (adminDatabaseUrl === undefined) return
    adminClient = createDatabaseClient(adminDatabaseUrl)

    try {
      const [version] = await adminClient.sql<{ serverVersion: number }[]>`
        SELECT current_setting('server_version_num')::integer AS "serverVersion"
      `
      expect(Math.trunc((version?.serverVersion ?? 0) / 10_000)).toBe(18)
      await createTemporaryDatabase(adminDatabaseUrl)
      await createTemporaryDatabase(adminDatabaseUrl)
    } catch (setupError) {
      try {
        await closeAndDropTemporaryDatabases()
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          'PostgreSQL integration setup and cleanup failed',
        )
      }
      throw setupError
    }
  }, 60_000)

  afterAll(async () => {
    await closeAndDropTemporaryDatabases()
  }, 60_000)

  it('initializes an empty database and safely reruns initialization', async () => {
    if (adminDatabaseUrl === undefined) throw new Error('PostgreSQL admin URL is not initialized')
    const database = await createTemporaryDatabase(adminDatabaseUrl, { initialize: false })

    await initializeDatabase(database.client)
    await initializeDatabase(database.client)

    const columns = await database.client.sql<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ledger_checkpoints'
    `
    const [statusTable] = await database.client.sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.indexer_status') IS NOT NULL AS exists
    `
    const [incidentTable] = await database.client.sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.indexer_incidents') IS NOT NULL AS exists
    `
    const discoveryIndexes = await database.client.sql<{ indexName: string }[]>`
      SELECT indexname AS "indexName"
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'credential_generations_stats_idx',
          'schema_events_activity_idx',
          'schemas_order_idx',
          'schemas_search_idx'
        )
      ORDER BY indexname
    `

    const integrityConstraints = await projectionIntegrityConstraintStates(database)

    expect(columns.map((row) => row.columnName)).toContain('transaction_root')
    expect(statusTable?.exists).toBe(true)
    expect(incidentTable?.exists).toBe(true)
    expect(discoveryIndexes.map((row) => row.indexName)).toEqual([
      'credential_generations_stats_idx',
      'schema_events_activity_idx',
      'schemas_order_idx',
      'schemas_search_idx',
    ])
    expect(integrityConstraints.map((constraint) => constraint.constraintName)).toEqual(
      [...PROJECTION_INTEGRITY_CONSTRAINT_NAMES].sort(),
    )
    expect(integrityConstraints.every((constraint) => constraint.validated)).toBe(true)
  })

  it('allows exact restarts but rejects another profile in exclusive database scope', async () => {
    if (adminDatabaseUrl === undefined) throw new Error('PostgreSQL admin URL is not initialized')
    const database = await createTemporaryDatabase(adminDatabaseUrl)
    const candidates = [profile('exclusive-profile-a'), profile('exclusive-profile-b')] as const
    const repository = new PostgresIndexerRepository(database.client.db, {
      databaseScope: 'exclusive-profile',
    })

    const concurrentResults = await Promise.allSettled(
      candidates.map((candidate) => repository.initializeProfile(candidate)),
    )
    expect(concurrentResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = concurrentResults.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'DATABASE_SCOPE_CONFLICT' },
    })

    const storedProfiles = await database.client.sql<Array<{ profileId: string }>>`
      SELECT profile_id AS "profileId" FROM network_profiles
    `
    expect(storedProfiles).toHaveLength(1)
    const winningProfile = candidates.find(
      (candidate) => candidate.profileId === storedProfiles[0]?.profileId,
    )
    const losingProfile = candidates.find(
      (candidate) => candidate.profileId !== storedProfiles[0]?.profileId,
    )
    if (winningProfile === undefined || losingProfile === undefined) {
      throw new Error('Concurrent exclusive-profile result is invalid')
    }
    await expect(repository.initializeProfile(winningProfile)).resolves.toBeUndefined()
    await expect(repository.initializeProfile(losingProfile)).rejects.toMatchObject({
      code: 'DATABASE_SCOPE_CONFLICT',
    })
  })

  it('provisions idempotent least-privilege indexer, API and monitor roles', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    if (adminClient === undefined) throw new Error('PostgreSQL admin client is not initialized')

    const passwords = {
      clusterScope: 'dedicated',
      administratorPassword: databasePasswordFromUrl(database.url),
      indexerPassword: INDEXER_DATABASE_PASSWORD,
      apiPassword: API_DATABASE_PASSWORD,
      monitorPassword: MONITOR_DATABASE_PASSWORD,
    } as const
    runtimeRoleCleanupAllowed = true
    await provisionRuntimeDatabaseRoles(database.client, passwords)
    await provisionRuntimeDatabaseRoles(database.client, passwords)

    const roleProperties = await adminClient.sql<
      Array<{
        roleName: string
        canLogin: boolean
        isSuperuser: boolean
        canCreateDatabase: boolean
        canCreateRole: boolean
        canReplicate: boolean
        canBypassRls: boolean
        inheritsPrivileges: boolean
        connectionLimit: number
        configuration: string[] | null
      }>
    >`
      SELECT
        rolname AS "roleName",
        rolcanlogin AS "canLogin",
        rolsuper AS "isSuperuser",
        rolcreatedb AS "canCreateDatabase",
        rolcreaterole AS "canCreateRole",
        rolreplication AS "canReplicate",
        rolbypassrls AS "canBypassRls",
        rolinherit AS "inheritsPrivileges",
        rolconnlimit AS "connectionLimit",
        ARRAY(
          SELECT setting
          FROM unnest(COALESCE(rolconfig, ARRAY[]::text[])) setting
          ORDER BY setting
        ) AS configuration
      FROM pg_roles
      WHERE rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
      ORDER BY rolname
    `
    expect(roleProperties).toEqual([
      {
        roleName: 'xcs_api',
        canLogin: true,
        isSuperuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false,
        canBypassRls: false,
        inheritsPrivileges: false,
        connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
        configuration: [
          'idle_in_transaction_session_timeout=30s',
          'lock_timeout=15s',
          'statement_timeout=30s',
        ],
      },
      {
        roleName: 'xcs_indexer',
        canLogin: true,
        isSuperuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false,
        canBypassRls: false,
        inheritsPrivileges: false,
        connectionLimit: XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
        configuration: [
          'idle_in_transaction_session_timeout=30s',
          'lock_timeout=30s',
          'statement_timeout=5min',
        ],
      },
      {
        roleName: 'xcs_monitor',
        canLogin: true,
        isSuperuser: false,
        canCreateDatabase: false,
        canCreateRole: false,
        canReplicate: false,
        canBypassRls: false,
        inheritsPrivileges: true,
        connectionLimit: XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
        configuration: [
          'idle_in_transaction_session_timeout=30s',
          'lock_timeout=10s',
          'statement_timeout=30s',
        ],
      },
    ])

    const runtimeMemberships = await adminClient.sql<
      Array<{
        grantedRole: string
        memberRole: string
        adminOption: boolean
        inheritOption: boolean
        setOption: boolean
      }>
    >`
      SELECT
        granted_role.rolname AS "grantedRole",
        member_role.rolname AS "memberRole",
        membership.admin_option AS "adminOption",
        membership.inherit_option AS "inheritOption",
        membership.set_option AS "setOption"
      FROM pg_auth_members membership
      JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE member_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
      ORDER BY granted_role.rolname, member_role.rolname
    `
    expect(runtimeMemberships).toEqual([
      {
        grantedRole: 'pg_monitor',
        memberRole: 'xcs_monitor',
        adminOption: false,
        inheritOption: true,
        setOption: false,
      },
    ])

    const tableGrants = await database.client.sql<
      Array<{
        grantee: string
        tableName: string
        privilegeType: string
        grantable: boolean
      }>
    >`
      SELECT
        grantee_role.rolname AS "grantee",
        relation.relname AS "tableName",
        privilege.privilege_type AS "privilegeType",
        privilege.is_grantable AS "grantable"
      FROM pg_class relation
      JOIN pg_namespace namespace_object ON namespace_object.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r'::"char", relation.relowner))
      ) privilege
      JOIN pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_object.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND grantee_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
      ORDER BY grantee_role.rolname, relation.relname, privilege.privilege_type
    `
    expect(tableGrants).toEqual([
      {
        grantee: 'xcs_api',
        tableName: 'credential_events',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'credential_generations',
        privilegeType: 'SELECT',
        grantable: false,
      },
      { grantee: 'xcs_api', tableName: 'demo_pins', privilegeType: 'DELETE', grantable: false },
      { grantee: 'xcs_api', tableName: 'demo_pins', privilegeType: 'INSERT', grantable: false },
      { grantee: 'xcs_api', tableName: 'demo_pins', privilegeType: 'SELECT', grantable: false },
      { grantee: 'xcs_api', tableName: 'demo_pins', privilegeType: 'UPDATE', grantable: false },
      {
        grantee: 'xcs_api',
        tableName: 'indexer_incidents',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'indexer_status',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'ledger_checkpoints',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'network_profiles',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'pin_challenges',
        privilegeType: 'DELETE',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'pin_challenges',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'pin_challenges',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_api',
        tableName: 'pin_challenges',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      { grantee: 'xcs_api', tableName: 'schema_events', privilegeType: 'SELECT', grantable: false },
      { grantee: 'xcs_api', tableName: 'schemas', privilegeType: 'SELECT', grantable: false },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_events',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_events',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_incidents',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_incidents',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'ledger_checkpoints',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'ledger_checkpoints',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'network_profiles',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'network_profiles',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'schema_events',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'schema_events',
        privilegeType: 'SELECT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'schemas',
        privilegeType: 'INSERT',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'schemas',
        privilegeType: 'SELECT',
        grantable: false,
      },
    ])

    const columnGrants = await database.client.sql<
      Array<{
        grantee: string
        tableName: string
        columnName: string
        privilegeType: string
        grantable: boolean
      }>
    >`
      SELECT
        grantee_role.rolname AS "grantee",
        relation.relname AS "tableName",
        attribute_object.attname AS "columnName",
        privilege.privilege_type AS "privilegeType",
        privilege.is_grantable AS "grantable"
      FROM pg_attribute attribute_object
      JOIN pg_class relation ON relation.oid = attribute_object.attrelid
      JOIN pg_namespace namespace_object ON namespace_object.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(attribute_object.attacl) privilege
      JOIN pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_object.nspname = 'public'
        AND attribute_object.attnum > 0
        AND NOT attribute_object.attisdropped
        AND grantee_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
      ORDER BY grantee_role.rolname, relation.relname, attribute_object.attname, privilege.privilege_type
    `
    expect(columnGrants).toEqual([
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        columnName: 'accepted',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        columnName: 'deleted_ledger_index',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        columnName: 'deletion_cause',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        columnName: 'last_ledger_index',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'credential_generations',
        columnName: 'updated_at',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'error_code',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'last_agreed_ledger_hash',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'last_agreed_ledger_index',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'lease_expires_at',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'primary_source_tip',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'secondary_source_tip',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'state',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'updated_at',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'writer_epoch',
        privilegeType: 'UPDATE',
        grantable: false,
      },
      {
        grantee: 'xcs_indexer',
        tableName: 'indexer_status',
        columnName: 'writer_id',
        privilegeType: 'UPDATE',
        grantable: false,
      },
    ])

    const indexerClient = createDatabaseClient(
      runtimeDatabaseUrl(database.url, 'xcs_indexer', INDEXER_DATABASE_PASSWORD),
    )
    const apiClient = createDatabaseClient(
      runtimeDatabaseUrl(database.url, 'xcs_api', API_DATABASE_PASSWORD),
    )
    const monitorClient = createDatabaseClient(
      runtimeDatabaseUrl(database.url, 'xcs_monitor', MONITOR_DATABASE_PASSWORD),
    )
    try {
      const permissionsProfile = profile('runtime-role-permissions')
      const repository = new PostgresIndexerRepository(indexerClient.db)
      await repository.initializeProfile(permissionsProfile)
      const lease = await repository.acquireLease(
        permissionsProfile.profileId,
        'role-test-writer',
        300_000,
      )
      const activation = ledger(ACTIVATION_LEDGER_INDEX)
      await expect(
        repository.persistLedger(
          permissionsProfile,
          emptyProjection(activation),
          lease,
          readyStatus(activation),
        ),
      ).resolves.toBe('inserted')
      await repository.haltIndexer(
        lease,
        {
          primarySourceTip: activation.ledgerIndex,
          secondarySourceTip: activation.ledgerIndex,
          lastAgreedLedgerIndex: activation.ledgerIndex,
          lastAgreedLedgerHash: activation.ledgerHash,
        },
        'OPERATOR_TEST_HALT',
      )

      const [projectionRead] = await apiClient.sql<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM ledger_checkpoints
        WHERE profile_id = ${permissionsProfile.profileId}
      `
      expect(projectionRead?.count).toBe(1)
      const [incidentRead] = await apiClient.sql<Array<{ writerEpoch: string; errorCode: string }>>`
        SELECT writer_epoch::text AS "writerEpoch", error_code AS "errorCode"
        FROM indexer_incidents
        WHERE profile_id = ${permissionsProfile.profileId}
      `
      expect(incidentRead).toEqual({
        writerEpoch: String(lease.epoch),
        errorCode: 'OPERATOR_TEST_HALT',
      })

      const [monitorRead] = await monitorClient.sql<
        Array<{ databaseName: string; logicalSizeBytes: string }>
      >`
        SELECT
          datname AS "databaseName",
          pg_database_size(datname)::text AS "logicalSizeBytes"
        FROM pg_stat_database
        WHERE datname = current_database()
      `
      expect(monitorRead?.databaseName).toBe(new URL(database.url).pathname.slice(1))
      expect(Number(monitorRead?.logicalSizeBytes)).toBeGreaterThan(0)
      await expectPermissionDenied(monitorClient.sql`SELECT * FROM public.network_profiles`)
      await expectPermissionDenied(
        monitorClient.sql`
          INSERT INTO public.indexer_incidents (profile_id, writer_epoch, error_code)
          VALUES (${permissionsProfile.profileId}, 998, 'FORBIDDEN_MONITOR_WRITE')
        `,
      )

      await expectPermissionDenied(
        indexerClient.sql`
          UPDATE ledger_checkpoints
          SET close_time = 4294967295
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      )
      await expectPermissionDenied(
        indexerClient.sql`
          UPDATE schemas
          SET name = 'forbidden rewrite'
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      )
      await expectPermissionDenied(
        indexerClient.sql`
          UPDATE credential_events
          SET event_type = 'deleted'
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      )

      await indexerClient.sql`
        INSERT INTO schema_events (
          profile_id, transaction_hash, ledger_index, ledger_hash, transaction_index,
          publisher, status, schema_uid, memo_json
        ) VALUES (
          ${permissionsProfile.profileId}, ${SCHEMA_TRANSACTION_HASH},
          ${ACTIVATION_LEDGER_INDEX}, ${ACTIVATION_LEDGER_HASH}, 1,
          ${ISSUER}, 'accepted', ${SCHEMA_UID}, ${JSON.stringify(schemaDefinition)}::jsonb
        )
      `
      await indexerClient.sql`
        INSERT INTO schemas (
          profile_id, schema_uid, publisher, name, description, definition,
          resolved_definition, registration_transaction_hash, ledger_index, transaction_index
        ) VALUES (
          ${permissionsProfile.profileId}, ${SCHEMA_UID}, ${ISSUER},
          ${schemaDefinition.name}, ${schemaDefinition.description},
          ${JSON.stringify(schemaDefinition)}::jsonb,
          ${JSON.stringify({ definition: schemaDefinition, fields: schemaDefinition.fields, lineage: [] })}::jsonb,
          ${SCHEMA_TRANSACTION_HASH}, ${ACTIVATION_LEDGER_INDEX}, 1
        )
      `
      await indexerClient.sql`
        INSERT INTO credential_generations (
          profile_id, generation_id, ledger_object_id, issuer, subject, schema_uid,
          uri_hex, accepted, created_ledger_index, created_transaction_index,
          last_ledger_index
        ) VALUES (
          ${permissionsProfile.profileId}, ${CREDENTIAL_TRANSACTION_HASH},
          ${CREDENTIAL_OBJECT_ID}, ${ISSUER}, ${SUBJECT}, ${SCHEMA_UID},
          'ABCD', false, ${ACTIVATION_LEDGER_INDEX}, 2, ${ACTIVATION_LEDGER_INDEX}
        )
      `
      await expect(
        indexerClient.sql`
          UPDATE credential_generations
          SET accepted = true,
              last_ledger_index = ${ACTIVATION_LEDGER_INDEX + 1},
              updated_at = CURRENT_TIMESTAMP
          WHERE profile_id = ${permissionsProfile.profileId}
            AND generation_id = ${CREDENTIAL_TRANSACTION_HASH}
        `,
      ).resolves.toBeDefined()
      for (const forbiddenUpdate of [
        indexerClient.sql`
          UPDATE credential_generations
          SET issuer = ${SUBJECT}
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
        indexerClient.sql`
          UPDATE credential_generations
          SET uri_hex = 'DCBA'
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
        indexerClient.sql`
          UPDATE credential_generations
          SET created_ledger_index = ${ACTIVATION_LEDGER_INDEX + 1}
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      ]) {
        await expectPermissionDenied(forbiddenUpdate)
      }

      await expectPermissionDenied(
        apiClient.sql`
          UPDATE network_profiles
          SET enabled = false
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      )
      await expectPermissionDenied(
        apiClient.sql`
          INSERT INTO indexer_incidents (profile_id, writer_epoch, error_code)
          VALUES (${permissionsProfile.profileId}, 999, 'FORBIDDEN_API_WRITE')
        `,
      )
      await expectPermissionDenied(
        indexerClient.sql`
          UPDATE indexer_incidents
          SET error_code = 'FORBIDDEN_INDEXER_UPDATE'
          WHERE profile_id = ${permissionsProfile.profileId}
        `,
      )
      await expectPermissionDenied(
        indexerClient.sql`
          INSERT INTO pin_challenges (
            challenge_id, profile_id, wallet, requester_ip_hash, message, expires_at
          ) VALUES (
            ${'7'.repeat(64)}, ${permissionsProfile.profileId}, ${ISSUER},
            ${'8'.repeat(64)}, 'not-authorized', CURRENT_TIMESTAMP + interval '5 minutes'
          )
        `,
      )

      const challengeId = '1'.repeat(64)
      const pinId = '2'.repeat(64)
      await apiClient.sql`
        INSERT INTO pin_challenges (
          challenge_id, profile_id, wallet, requester_ip_hash, message, expires_at
        ) VALUES (
          ${challengeId}, ${permissionsProfile.profileId}, ${ISSUER},
          ${'3'.repeat(64)}, 'authorized', CURRENT_TIMESTAMP + interval '5 minutes'
        )
      `
      await apiClient.sql`
        INSERT INTO demo_pins (
          pin_id, challenge_id, profile_id, wallet, requester_ip_hash,
          cid, byte_length, status, expires_at
        ) VALUES (
          ${pinId}, ${challengeId}, ${permissionsProfile.profileId}, ${ISSUER},
          ${'3'.repeat(64)}, 'bafybeigdyrzt', 128, 'pending',
          CURRENT_TIMESTAMP + interval '1 hour'
        )
      `
      const [pinRead] = await apiClient.sql<{ status: string }[]>`
        SELECT status FROM demo_pins WHERE pin_id = ${pinId}
      `
      expect(pinRead?.status).toBe('pending')
      await apiClient.sql`
        UPDATE demo_pins SET status = 'pinned' WHERE pin_id = ${pinId}
      `
      await apiClient.sql`DELETE FROM demo_pins WHERE pin_id = ${pinId}`
      await apiClient.sql`DELETE FROM pin_challenges WHERE challenge_id = ${challengeId}`

      await expectPermissionDenied(apiClient.sql`CREATE TABLE forbidden_api (id integer)`)
      await expectPermissionDenied(indexerClient.sql`CREATE TABLE forbidden_indexer (id integer)`)
    } finally {
      await Promise.allSettled([indexerClient.close(), apiClient.close(), monitorClient.close()])
    }
  }, 120_000)

  it('enforces NULL-safe agreed-ledger, ready and writer/lease shapes', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const constrainedProfile = profile('constraint-shapes')
    await new PostgresIndexerRepository(database.client.db).initializeProfile(constrainedProfile)

    await expect(
      database.client.sql`
        INSERT INTO indexer_status (
          profile_id, state, last_agreed_ledger_index, writer_epoch
        ) VALUES (${constrainedProfile.profileId}, 'catching_up', 100, 1)
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'indexer_status_agreed_ledger' })

    await expect(
      database.client.sql`
        INSERT INTO indexer_status (
          profile_id, state, primary_source_tip, secondary_source_tip,
          last_agreed_ledger_index, last_agreed_ledger_hash, writer_epoch
        ) VALUES (
          ${constrainedProfile.profileId}, 'ready', 100, 100,
          100, ${ACTIVATION_LEDGER_HASH}, 1
        )
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'indexer_status_ready_shape' })

    await expect(
      database.client.sql`
        INSERT INTO indexer_status (
          profile_id, state, writer_id, writer_epoch
        ) VALUES (${constrainedProfile.profileId}, 'starting', 'writer-without-lease', 1)
      `,
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'indexer_status_lease_window' })
  })

  it('fences writers across lease contention, expiry and takeover', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const fencedProfile = profile('lease-fencing')
    const repository = new PostgresIndexerRepository(database.client.db)
    await repository.initializeProfile(fencedProfile)

    const acquiredAt = new Date()
    const first = await acquireIndexerLease(database.client.db, {
      profileId: fencedProfile.profileId,
      writerId: 'writer-one',
      leaseDurationMs: 10_000,
      now: acquiredAt,
    })
    await expect(
      acquireIndexerLease(database.client.db, {
        profileId: fencedProfile.profileId,
        writerId: 'writer-two',
        leaseDurationMs: 10_000,
        now: new Date(acquiredAt.getTime() + 9_999),
      }),
    ).rejects.toMatchObject({
      code: 'INDEXER_LEASE_UNAVAILABLE',
    })

    const renewed = await renewIndexerLease(database.client.db, first, {
      leaseDurationMs: 10_000,
      now: new Date(acquiredAt.getTime() + 1_000),
    })
    expect(renewed.epoch).toBe(first.epoch)

    const takeoverAt = new Date(acquiredAt.getTime() + 11_000)
    const second = await acquireIndexerLease(database.client.db, {
      profileId: fencedProfile.profileId,
      writerId: 'writer-two',
      leaseDurationMs: 10_000,
      now: takeoverAt,
    })
    expect(second.epoch).toBe(first.epoch + 1)

    await expect(
      renewIndexerLease(database.client.db, first, {
        leaseDurationMs: 10_000,
        now: takeoverAt,
      }),
    ).rejects.toMatchObject({ code: 'INDEXER_LEASE_LOST' })
    await expect(
      updateIndexerStatus(database.client.db, first, { state: 'catching_up' }, { now: takeoverAt }),
    ).rejects.toMatchObject({ code: 'INDEXER_LEASE_LOST' })
    await expect(
      releaseIndexerLease(database.client.db, first, { now: takeoverAt }),
    ).rejects.toMatchObject({ code: 'INDEXER_LEASE_LOST' })
    await expect(
      haltIndexer(database.client.db, first, {}, 'STALE_WRITER_HALT', { now: takeoverAt }),
    ).rejects.toMatchObject({ code: 'INDEXER_LEASE_LOST' })
    expect(
      await database.client.db
        .select()
        .from(indexerIncidents)
        .where(eq(indexerIncidents.profileId, fencedProfile.profileId)),
    ).toEqual([])

    const activation = ledger(ACTIVATION_LEDGER_INDEX)
    await expect(
      repository.persistLedger(
        fencedProfile,
        emptyProjection(activation),
        first,
        readyStatus(activation),
      ),
    ).rejects.toMatchObject({ code: 'INDEXER_LEASE_LOST' })

    const checkpointsAfterFencedWrite = await database.client.db
      .select()
      .from(ledgerCheckpoints)
      .where(eq(ledgerCheckpoints.profileId, fencedProfile.profileId))
    expect(checkpointsAfterFencedWrite).toEqual([])

    await expect(
      repository.persistLedger(
        fencedProfile,
        emptyProjection(activation),
        second,
        readyStatus(activation),
      ),
    ).resolves.toBe('inserted')
  })

  it('starts a renewed lease after a blocking row lock is acquired', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const blockedProfile = profile('blocked-lease-renewal')
    const repository = new PostgresIndexerRepository(database.client.db)
    await repository.initializeProfile(blockedProfile)
    const token = await repository.acquireLease(
      blockedProfile.profileId,
      'blocked-renewal-writer',
      300_000,
    )

    const blockingClient = createDatabaseClient(database.url)
    let markLocked: (() => void) | undefined
    const rowLocked = new Promise<void>((resolve) => {
      markLocked = resolve
    })
    try {
      const blocker = blockingClient.sql.begin(async (sql) => {
        await sql`
          SELECT profile_id
          FROM indexer_status
          WHERE profile_id = ${blockedProfile.profileId}
          FOR UPDATE
        `
        markLocked?.()
        await sql`SELECT pg_sleep(2)`
      })
      await rowLocked

      const renewalStartedAt = Date.now()
      const renewal = renewIndexerLease(database.client.db, token, {
        leaseDurationMs: 10_000,
      })
      await blocker
      const renewed = await renewal

      expect(Date.now() - renewalStartedAt).toBeGreaterThanOrEqual(1_800)
      expect(renewed.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(9_000)
    } finally {
      await blockingClient.close()
    }
  }, 15_000)

  it('rolls back the halted status when the durable incident insert fails', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const atomicProfile = profile('atomic-halt')
    const repository = new PostgresIndexerRepository(database.client.db)
    await repository.initializeProfile(atomicProfile)
    const token = await repository.acquireLease(
      atomicProfile.profileId,
      'atomic-halt-writer',
      300_000,
    )

    await database.client.db.insert(indexerIncidents).values({
      profileId: atomicProfile.profileId,
      writerEpoch: token.epoch,
      errorCode: 'PREEXISTING_INCIDENT',
    })

    await expect(repository.haltIndexer(token, {}, 'SOURCE_DIVERGENCE')).rejects.toMatchObject({
      cause: { code: '23505' },
    })

    const [status] = await database.client.db
      .select()
      .from(indexerStatuses)
      .where(eq(indexerStatuses.profileId, atomicProfile.profileId))
      .limit(1)
    expect(status).toMatchObject({
      state: 'starting',
      writerId: token.writerId,
      writerEpoch: token.epoch,
      errorCode: null,
    })
  })

  it('rolls back all projection writes when a later mutation fails', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const rollbackProfile = profile('transaction-rollback')
    const repository = new PostgresIndexerRepository(database.client.db)
    await repository.initializeProfile(rollbackProfile)
    const token = await repository.acquireLease(
      rollbackProfile.profileId,
      'rollback-writer',
      300_000,
    )
    const [projection] = replayProjections()
    const failingProjection: LedgerProjection = {
      ...projection,
      credentialMutations: [
        {
          transactionHash: CREDENTIAL_TRANSACTION_HASH,
          transactionIndex: 0,
          nodeIndex: 0,
          ledgerObjectId: CREDENTIAL_OBJECT_ID,
          eventType: 'accepted',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: true,
          snapshot: { accepted: true },
        },
      ],
    }

    await expect(
      repository.persistLedger(
        rollbackProfile,
        failingProjection,
        token,
        readyStatus(failingProjection.ledger),
      ),
    ).rejects.toThrow('without a live generation')

    const [checkpointRows, eventRows, schemaRows] = await Promise.all([
      database.client.db
        .select()
        .from(ledgerCheckpoints)
        .where(eq(ledgerCheckpoints.profileId, rollbackProfile.profileId)),
      database.client.db
        .select()
        .from(schemaEvents)
        .where(eq(schemaEvents.profileId, rollbackProfile.profileId)),
      database.client.db
        .select()
        .from(schemas)
        .where(eq(schemas.profileId, rollbackProfile.profileId)),
    ])
    expect(checkpointRows).toEqual([])
    expect(eventRows).toEqual([])
    expect(schemaRows).toEqual([])
  })

  it('persists transactionRoot and remains idempotent after a connection restart', async () => {
    const database = temporaryDatabases[0]
    if (database === undefined) throw new Error('First temporary database was not created')
    const restartProfile = profile('restart-idempotence')
    let repository = new PostgresIndexerRepository(database.client.db)
    await repository.initializeProfile(restartProfile)
    const token = await repository.acquireLease(restartProfile.profileId, 'restart-writer', 300_000)
    const projection = emptyProjection(ledger(ACTIVATION_LEDGER_INDEX))

    await expect(
      repository.persistLedger(restartProfile, projection, token, readyStatus(projection.ledger)),
    ).resolves.toBe('inserted')

    const [storedBeforeRestart] = await database.client.db
      .select()
      .from(ledgerCheckpoints)
      .where(
        and(
          eq(ledgerCheckpoints.profileId, restartProfile.profileId),
          eq(ledgerCheckpoints.ledgerIndex, ACTIVATION_LEDGER_INDEX),
        ),
      )
      .limit(1)
    expect(storedBeforeRestart?.transactionRoot).toBe(projection.ledger.transactionRoot)

    const restartedClient = await restartConnection(database)
    repository = new PostgresIndexerRepository(restartedClient.db)
    await expect(
      repository.persistLedger(restartProfile, projection, token, readyStatus(projection.ledger)),
    ).resolves.toBe('already_processed')

    const rowsAfterRestart = await restartedClient.db
      .select()
      .from(ledgerCheckpoints)
      .where(eq(ledgerCheckpoints.profileId, restartProfile.profileId))
    expect(rowsAfterRestart).toHaveLength(1)
  })

  it('produces the same digest for two replays despite different database timestamps', async () => {
    const firstDatabase = temporaryDatabases[0]
    const secondDatabase = temporaryDatabases[1]
    if (firstDatabase === undefined || secondDatabase === undefined) {
      throw new Error('Two temporary databases are required for replay comparison')
    }
    const replayProfile = profile('digest-replay')

    await replayProjection(firstDatabase, replayProfile)
    await replayProjection(secondDatabase, replayProfile)

    const timestamps = [new Date('2025-01-01T00:00:00.000Z'), new Date('2035-01-01T00:00:00.000Z')]
    for (const [index, database] of [firstDatabase, secondDatabase].entries()) {
      const timestamp = timestamps[index]
      if (timestamp === undefined) throw new Error('Replay timestamp fixture is missing')
      const timestampIso = timestamp.toISOString()
      await database.client.sql`
        UPDATE network_profiles SET created_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
      await database.client.sql`
        UPDATE ledger_checkpoints SET processed_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
      await database.client.sql`
        UPDATE schema_events SET recorded_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
      await database.client.sql`
        UPDATE schemas SET registered_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
      await database.client.sql`
        UPDATE credential_events SET recorded_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
      await database.client.sql`
        UPDATE credential_generations
        SET created_at = ${timestampIso}, updated_at = ${timestampIso}
        WHERE profile_id = ${replayProfile.profileId}
      `
    }

    await firstDatabase.client.db.insert(indexerIncidents).values({
      profileId: replayProfile.profileId,
      writerEpoch: 99,
      errorCode: 'DIGEST_EXCLUDED_HALT',
    })

    const [firstDigest, secondDigest] = await Promise.all([
      computeProjectionDigest(firstDatabase.client.db, replayProfile.profileId),
      computeProjectionDigest(secondDatabase.client.db, replayProfile.profileId),
    ])
    const [storedRegistration] = await firstDatabase.client.db
      .select({ memoJson: schemaEvents.memoJson })
      .from(schemaEvents)
      .where(eq(schemaEvents.profileId, replayProfile.profileId))
      .limit(1)

    expect(secondDigest).toEqual(firstDigest)
    expect(storedRegistration?.memoJson).toEqual(schemaMemoJson)
    expect(firstDigest.rowCounts).toEqual({
      ledgerCheckpoints: 2,
      schemaEvents: 1,
      schemas: 1,
      credentialEvents: 1,
      credentialGenerations: 1,
    })
  })

  it('replays one integrity-bound ledger bundle into identical complete projections', async () => {
    const firstDatabase = temporaryDatabases[0]
    const secondDatabase = temporaryDatabases[1]
    if (firstDatabase === undefined || secondDatabase === undefined) {
      throw new Error('Two temporary databases are required for fixture replay comparison')
    }
    const replayProfile: NetworkProfile = {
      ...profile('complete-fixture-replay'),
      requiredAmendment: 'B'.repeat(64),
    }
    const fixture = completeProjectionFixture(replayProfile)
    const profileFileBytes = encodeUtf8(canonicalize(replayProfile as unknown as JsonValue))
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'xcs-complete-replay-'))
    const bundleDirectory = join(temporaryRoot, 'bundle')

    try {
      const manifest = await captureLedgerFixtureBundle({
        outputDirectory: bundleDirectory,
        profile: replayProfile,
        profileFileBytes,
        source: new CompleteProjectionFixtureSource(replayProfile, fixture.ledgers),
        toLedgerIndex: ACTIVATION_LEDGER_INDEX + 3,
        primaryOperator: 'XRPL Commons fixture',
        secondaryOperator: 'Independent fixture operator',
        capturedAt: new Date('2026-08-26T00:00:00.000Z'),
      })
      const bundleDigest = ledgerFixtureBundleDigest(manifest)
      const [firstReplay, secondReplay] = await Promise.all([
        prepareFixtureReplay({
          directory: bundleDirectory,
          bundleDigest,
          profile: replayProfile,
          profileFileBytes,
        }),
        prepareFixtureReplay({
          directory: bundleDirectory,
          bundleDigest,
          profile: replayProfile,
          profileFileBytes,
        }),
      ])
      expect(secondReplay.replayTarget).toEqual(firstReplay.replayTarget)
      expect(firstReplay.replayTarget).toEqual({
        ledgerIndex: ACTIVATION_LEDGER_INDEX + 3,
        ledgerHash: ledgerHash(ACTIVATION_LEDGER_INDEX + 3),
      })

      const replayInto = async (
        database: TemporaryDatabase,
        prepared: typeof firstReplay,
        writerId: string,
      ) => {
        let caughtUpLedger: number | undefined
        const worker = new IndexerWorker({
          profile: replayProfile,
          source: prepared.source,
          repository: new PostgresIndexerRepository(database.client.db),
          replayTarget: prepared.replayTarget,
          pollIntervalMs: 250,
          leaseDurationMs: 10_000,
          batchSize: 4,
          writerId,
          observer: {
            caughtUp: (ledgerIndex) => {
              caughtUpLedger = ledgerIndex
            },
          },
        })
        await worker.start(new AbortController().signal)
        expect(caughtUpLedger).toBe(prepared.replayTarget.ledgerIndex)
        return computeProjectionDigest(database.client.db, replayProfile.profileId)
      }

      const [firstDigest, secondDigest] = await Promise.all([
        replayInto(firstDatabase, firstReplay, 'complete-fixture-a'),
        replayInto(secondDatabase, secondReplay, 'complete-fixture-b'),
      ])
      const [deletionEvents, generationRows, storedSchemaRows] = await Promise.all([
        firstDatabase.client.db
          .select({
            transactionIndex: credentialEvents.transactionIndex,
            deletionCause: credentialEvents.deletionCause,
            accepted: credentialEvents.accepted,
          })
          .from(credentialEvents)
          .where(
            and(
              eq(credentialEvents.profileId, replayProfile.profileId),
              eq(credentialEvents.eventType, 'deleted'),
            ),
          )
          .orderBy(asc(credentialEvents.transactionIndex)),
        firstDatabase.client.db
          .select({
            subject: credentialGenerations.subject,
            expiration: credentialGenerations.expiration,
            accepted: credentialGenerations.accepted,
            createdTransactionIndex: credentialGenerations.createdTransactionIndex,
            lastLedgerIndex: credentialGenerations.lastLedgerIndex,
            deletedLedgerIndex: credentialGenerations.deletedLedgerIndex,
            deletionCause: credentialGenerations.deletionCause,
          })
          .from(credentialGenerations)
          .where(eq(credentialGenerations.profileId, replayProfile.profileId))
          .orderBy(asc(credentialGenerations.createdTransactionIndex)),
        firstDatabase.client.db
          .select({ schemaUid: schemas.schemaUid })
          .from(schemas)
          .where(eq(schemas.profileId, replayProfile.profileId)),
      ])

      expect(secondDigest).toEqual(firstDigest)
      expect(firstDigest.digestHex).toBe(
        '19b2a150af329cad035f5bc934b3db772237fa52bcc76a411439001ab6b1bed0',
      )
      expect(firstDigest.rowCounts).toEqual({
        ledgerCheckpoints: 4,
        schemaEvents: 1,
        schemas: 1,
        credentialEvents: 13,
        credentialGenerations: 6,
      })
      expect(storedSchemaRows).toEqual([{ schemaUid: fixture.schemaUid }])
      expect(deletionEvents).toEqual(
        FIXTURE_DELETION_CASES.map((fixtureCase, transactionIndex) => ({
          transactionIndex,
          deletionCause: fixtureCase.cause,
          accepted: fixtureCase.accepted,
        })),
      )
      expect(generationRows).toEqual(
        FIXTURE_DELETION_CASES.map((fixtureCase, createdTransactionIndex) => ({
          subject: fixtureCase.subject,
          expiration: fixtureCase.expiration ?? null,
          accepted: fixtureCase.accepted,
          createdTransactionIndex,
          lastLedgerIndex: ACTIVATION_LEDGER_INDEX + 3,
          deletedLedgerIndex: ACTIVATION_LEDGER_INDEX + 3,
          deletionCause: fixtureCase.cause,
        })),
      )
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }, 60_000)

  it('stops two quorum-backed replays at the same bound despite different source tips', async () => {
    const firstDatabase = temporaryDatabases[0]
    const secondDatabase = temporaryDatabases[1]
    if (firstDatabase === undefined || secondDatabase === undefined) {
      throw new Error('Two temporary databases are required for bounded replay comparison')
    }
    const replayProfile = profile('bounded-replay')

    const [firstDigest, secondDigest] = await Promise.all([
      boundedReplay(firstDatabase, replayProfile, 105, 104),
      boundedReplay(secondDatabase, replayProfile, 111, 109),
    ])

    expect(secondDigest).toEqual(firstDigest)
    expect(firstDigest.rowCounts).toEqual({
      ledgerCheckpoints: 3,
      schemaEvents: 0,
      schemas: 0,
      credentialEvents: 0,
      credentialGenerations: 0,
    })
  })
})
