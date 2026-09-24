import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TransactionSql } from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDatabaseClient, type DatabaseClient } from '../../src/lib/db/client.js'
import {
  DATABASE_MIGRATIONS_FOLDER,
  databaseMigrationStatus,
  migrateDatabase,
} from '../../src/lib/db/migrations.js'

const adminUrl = process.env.XCS_TEST_DATABASE_URL?.trim() || undefined
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && adminUrl === undefined) {
  throw new Error('XCS_TEST_DATABASE_URL is required by test:postgres')
}

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

const journal = JSON.parse(
  await readFile(join(DATABASE_MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
) as { version: string; dialect: string; entries: JournalEntry[] }
const tags = journal.entries.map((entry) => entry.tag)
const temporaryNames = /^xcs_migration_(?:db|role)_[0-9a-f]{32}$/u
let administrator: DatabaseClient
let database: DatabaseClient
let databaseName: string | undefined
let roleName: string | undefined
const fixtureFolders: string[] = []

async function fixture(count = journal.entries.length): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'xcs-migration-fixture-'))
  fixtureFolders.push(folder)
  await mkdir(join(folder, 'meta'))
  const entries = journal.entries.slice(0, count)
  for (const entry of entries) {
    await copyFile(
      join(DATABASE_MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    )
  }
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
  return folder
}

async function additiveFixture(sql: string): Promise<string> {
  const folder = await fixture()
  const entry = {
    idx: journal.entries.length,
    version: '7',
    when: journal.entries.at(-1)!.when + 1,
    tag: `${String(journal.entries.length).padStart(4, '0')}_integration_probe`,
    breakpoints: true,
  }
  await writeFile(join(folder, `${entry.tag}.sql`), sql)
  await writeFile(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [...journal.entries, entry] }),
  )
  return folder
}

async function journalRows() {
  return database.sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
}

async function exists(relation: string): Promise<boolean> {
  const [row] = await database.sql<{ exists: boolean }[]>`
    SELECT to_regclass(${relation}) IS NOT NULL AS exists
  `
  return row?.exists === true
}

describe.skipIf(adminUrl === undefined)('PostgreSQL 18 migration lifecycle', () => {
  beforeAll(async () => {
    administrator = createDatabaseClient(adminUrl!)
    const [version] = await administrator.sql<{ version: number }[]>`
      SELECT current_setting('server_version_num')::integer AS version
    `
    expect(Math.trunc((version?.version ?? 0) / 10_000)).toBe(18)
  })

  beforeEach(async () => {
    databaseName = `xcs_migration_db_${randomUUID().replaceAll('-', '')}`
    if (!temporaryNames.test(databaseName)) throw new Error('Invalid test database name')
    await administrator.sql`CREATE DATABASE ${administrator.sql(databaseName)} TEMPLATE template0`
    const url = new URL(adminUrl!)
    url.pathname = `/${databaseName}`
    database = createDatabaseClient(url.toString())
  })

  afterEach(async () => {
    await database?.close()
    if (databaseName !== undefined && temporaryNames.test(databaseName)) {
      await administrator.sql`DROP DATABASE IF EXISTS ${administrator.sql(databaseName)} WITH (FORCE)`
      databaseName = undefined
    }
    if (roleName !== undefined && temporaryNames.test(roleName)) {
      await administrator.sql`DROP ROLE IF EXISTS ${administrator.sql(roleName)}`
      roleName = undefined
    }
    for (const folder of fixtureFolders.splice(0)) {
      await rm(folder, { recursive: true, force: true })
    }
  }, 30_000)

  afterAll(async () => {
    await administrator?.close()
  })

  it('inspects an empty database without DDL and applies the journal exactly once', async () => {
    expect(await databaseMigrationStatus(database)).toEqual({ applied: [], pending: tags })
    const schemas = await database.sql`SELECT nspname FROM pg_namespace WHERE nspname = 'drizzle'`
    expect(schemas).toHaveLength(0)

    expect(await migrateDatabase(database)).toEqual({ applied: tags, pending: [] })
    const rows = await journalRows()
    expect(rows).toHaveLength(tags.length)
    expect(await migrateDatabase(database)).toEqual({ applied: tags, pending: [] })
    expect(await journalRows()).toEqual(rows)
  })

  it('upgrades a populated baseline and preserves legacy payload bytes and locators', async () => {
    await migrateDatabase(database, await fixture(1))
    await database.sql`
      INSERT INTO network_profiles (
        profile_id, xcs_version, network_id, required_amendment, registry_address,
        registration_amount_drops, activation_ledger_index, activation_ledger_hash
      ) VALUES (
        'migration-test', '0.1', 1, 'Credentials', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        1, 100, ${'a'.repeat(64)}
      )
    `
    await migrateDatabase(database, await fixture(2))
    await database.sql`
      INSERT INTO hosted_payloads (locator, digest_hex, content)
      VALUES (${'b'.repeat(20)}, ${'b'.repeat(64)}, '{"retained":true}')
    `
    expect(await databaseMigrationStatus(database)).toEqual({
      applied: tags.slice(0, 2),
      pending: tags.slice(2),
    })
    await migrateDatabase(database)
    expect(await database.sql`SELECT profile_id FROM network_profiles`).toEqual([
      { profile_id: 'migration-test' },
    ])
    await database.sql`
      INSERT INTO hosted_payloads (locator, digest_hex, content)
      VALUES (${'b'.repeat(18)}, ${'b'.repeat(64)}, '{"retained":true}')
    `
    expect(
      await database.sql`SELECT locator, content FROM hosted_payloads ORDER BY locator`,
    ).toEqual([
      { locator: 'b'.repeat(18), content: '{"retained":true}' },
      { locator: 'b'.repeat(20), content: '{"retained":true}' },
    ])
  })

  it('upgrades 0006 without rewriting accounts or existing presentation columns', async () => {
    await migrateDatabase(database, await fixture(7))
    await database.sql`INSERT INTO app_users(identity_issuer,identity_subject,display_name) VALUES ('https://identity.test','migration-recipient','Retained recipient')`
    const users = await database.sql`SELECT * FROM app_users`
    const columns =
      await database.sql`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='app_presentations' ORDER BY ordinal_position`
    const history = await journalRows()
    expect(await exists('public.app_verifier_history')).toBe(false)
    await migrateDatabase(database)
    expect(await database.sql`SELECT * FROM app_users`).toEqual(users)
    expect(
      await database.sql`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='app_presentations' ORDER BY ordinal_position`,
    ).toEqual(columns)
    expect((await journalRows()).slice(0, history.length)).toEqual(history)
    expect(await exists('public.app_verifier_history')).toBe(true)
    expect(await database.sql`SELECT * FROM app_verifier_history`).toEqual([])
  })

  it('upgrades 0007 additively while preserving legacy unsigned presentations and session records', async () => {
    await migrateDatabase(database, await fixture(8))
    await database.sql`INSERT INTO app_users(identity_issuer,identity_subject,display_name) VALUES ('https://identity.test','proof-migration','Retained recipient')`
    const users = await database.sql`SELECT * FROM app_users`
    const columns =
      await database.sql`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='app_presentations' ORDER BY ordinal_position`
    const history = await journalRows()
    expect(await exists('public.app_presentation_challenges')).toBe(false)
    await migrateDatabase(database)
    expect(await database.sql`SELECT * FROM app_users`).toEqual(users)
    expect(
      await database.sql`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='app_presentations' ORDER BY ordinal_position`,
    ).toEqual(columns)
    expect((await journalRows()).slice(0, history.length)).toEqual(history)
    expect(await exists('public.app_presentation_challenges')).toBe(true)
    expect(await database.sql`SELECT * FROM app_presentation_proofs`).toEqual([])
  })

  it.each(['tampered', 'future', 'nonprefix'] as const)(
    'rejects %s history before executing pending DDL',
    async (variant) => {
      await migrateDatabase(database)
      const folder = await additiveFixture('CREATE TABLE migration_probe (id integer);')
      if (variant === 'tampered') {
        await database.sql`UPDATE drizzle.__drizzle_migrations SET hash = ${'0'.repeat(64)} WHERE id = 1`
      } else if (variant === 'future') {
        await database.sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${'f'.repeat(64)}, ${journal.entries.at(-1)!.when + 10})
        `
      } else {
        await database.sql`DELETE FROM drizzle.__drizzle_migrations WHERE id = 1`
      }
      const before = await journalRows()
      await expect(databaseMigrationStatus(database, folder)).rejects.toThrow(
        'DATABASE_MIGRATION_HISTORY_MISMATCH',
      )
      await expect(migrateDatabase(database, folder)).rejects.toThrow(
        'DATABASE_MIGRATION_HISTORY_MISMATCH',
      )
      expect(await exists('public.migration_probe')).toBe(false)
      expect(await journalRows()).toEqual(before)
    },
  )

  it('rejects an edited applied SQL file before executing a pending migration', async () => {
    await migrateDatabase(database)
    const before = await journalRows()
    const folder = await additiveFixture('CREATE TABLE migration_probe (id integer);')
    const appliedFile = join(folder, `${tags[0]}.sql`)
    await writeFile(appliedFile, `${await readFile(appliedFile, 'utf8')}\n-- modified artifact\n`)

    await expect(migrateDatabase(database, folder)).rejects.toThrow(
      'DATABASE_MIGRATION_HISTORY_MISMATCH',
    )
    expect(await exists('public.migration_probe')).toBe(false)
    expect(await journalRows()).toEqual(before)
  })

  it.each(['index', 'timestamp', 'order'] as const)(
    'rejects an invalid catalog %s without creating the journal',
    async (variant) => {
      const folder = await fixture()
      const entries = journal.entries.map((entry) => ({ ...entry }))
      if (variant === 'index') entries[0]!.idx = 1
      else if (variant === 'timestamp') entries[0]!.when = 0.5
      else entries[1]!.when = entries[0]!.when
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))

      await expect(databaseMigrationStatus(database, folder)).rejects.toThrow(
        'DATABASE_MIGRATION_CATALOG_INVALID',
      )
      await expect(migrateDatabase(database, folder)).rejects.toThrow(
        'DATABASE_MIGRATION_CATALOG_INVALID',
      )
      expect(await exists('drizzle.__drizzle_migrations')).toBe(false)
    },
  )

  it('rejects concurrent migration ownership and succeeds after its release', async () => {
    const holder = await database.sql.reserve()
    try {
      await holder`SELECT pg_advisory_lock(1480807217, 2)`
      await expect(migrateDatabase(database)).rejects.toThrow('DATABASE_MIGRATION_BUSY')
      expect(await exists('drizzle.__drizzle_migrations')).toBe(false)
    } finally {
      await holder`SELECT pg_advisory_unlock(1480807217, 2)`
      holder.release()
    }
    expect(await migrateDatabase(database)).toEqual({ applied: tags, pending: [] })
  })

  it('rolls back failed additive DDL and permits a corrected pending migration to retry', async () => {
    await migrateDatabase(database)
    const before = await journalRows()
    const folder = await additiveFixture(
      'CREATE TABLE migration_probe (id integer);--> statement-breakpoint\nSELECT * FROM migration_missing_relation;',
    )
    await expect(migrateDatabase(database, folder)).rejects.toThrow()
    expect(await exists('public.migration_probe')).toBe(false)
    expect(await journalRows()).toEqual(before)
    const pending = await databaseMigrationStatus(database, folder)
    expect(pending.applied).toEqual(tags)
    expect(pending.pending).toHaveLength(1)

    await writeFile(
      join(folder, `${pending.pending[0]}.sql`),
      'CREATE TABLE migration_probe (id integer);',
    )
    expect(await migrateDatabase(database, folder)).toEqual({
      applied: [...tags, ...pending.pending],
      pending: [],
    })
    expect(await exists('public.migration_probe')).toBe(true)
  })

  it('cannot perform DDL as a restricted runtime identity', async () => {
    roleName = `xcs_migration_role_${randomUUID().replaceAll('-', '')}`
    if (!temporaryNames.test(roleName)) throw new Error('Invalid test role name')
    await administrator.sql`CREATE ROLE ${administrator.sql(roleName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`
    const runtimeRole = roleName
    // Apply the identity inside a real transaction; rollback also resets the role.
    const restrictedSql = new Proxy(database.sql, {
      get(target, property, receiver) {
        if (property === 'begin') {
          return async (callback: (sql: TransactionSql) => Promise<unknown>) =>
            database.sql.begin(async (transaction) => {
              await transaction`SET LOCAL ROLE ${transaction(runtimeRole)}`
              return callback(transaction)
            })
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const restricted = {
      ...database,
      sql: restrictedSql,
    }
    await expect(migrateDatabase(restricted)).rejects.toMatchObject({ code: '42501' })
    expect(await exists('drizzle.__drizzle_migrations')).toBe(false)
  })
})
