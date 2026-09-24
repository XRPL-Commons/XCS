// Copied from packages/db/src/migrations.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
// Diverges by design (shared db/migrations location and XCS_MIGRATIONS_DIR deployment override); source sha256:42c7d5380bba58dcfc4414b033d5e9c028d5dc93bec2ddce6db860d43cb1abae.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMigrationFiles } from 'drizzle-orm/migrator'
import type { Sql, TransactionSql } from 'postgres'

import type { DatabaseClient } from './client.js'

const DEFAULT_MIGRATIONS_FOLDERS = [
  fileURLToPath(new URL('../../../../../db/migrations', import.meta.url)),
  fileURLToPath(new URL('../../../db/migrations', import.meta.url)),
]

export function migrationsFolder(): string {
  return (
    process.env.XCS_MIGRATIONS_DIR?.trim() ||
    DEFAULT_MIGRATIONS_FOLDERS.find((folder) => existsSync(join(folder, 'meta/_journal.json'))) ||
    DEFAULT_MIGRATIONS_FOLDERS[0]!
  )
}

export const DATABASE_MIGRATIONS_FOLDER = migrationsFolder()
const LOCK_CLASS = 1_480_807_217
const LOCK_OBJECT = 2

export interface MigrationStatus {
  applied: string[]
  pending: string[]
}

interface MigrationEntry {
  tag: string
  when: number
  hash: string
  statements: string[]
}

function readCatalog(folder: string): MigrationEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    dialect?: unknown
    entries?: Array<{ idx?: unknown; tag?: unknown; when?: unknown }>
  }
  if (
    journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  ) {
    throw new Error('DATABASE_MIGRATION_CATALOG_INVALID')
  }
  const tags = new Set<string>()
  let previous = 0
  for (const [index, entry] of journal.entries.entries()) {
    if (
      entry.idx !== index ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag) ||
      tags.has(entry.tag) ||
      typeof entry.when !== 'number' ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previous
    ) {
      throw new Error('DATABASE_MIGRATION_CATALOG_INVALID')
    }
    tags.add(entry.tag)
    previous = entry.when
  }
  const migrations = readMigrationFiles({ migrationsFolder: folder })
  return migrations.map((migration, index) => ({
    tag: journal.entries![index]!.tag as string,
    when: migration.folderMillis,
    hash: migration.hash,
    statements: migration.sql,
  }))
}

async function status(
  sql: Sql | TransactionSql,
  catalog: MigrationEntry[],
): Promise<MigrationStatus> {
  const [table] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists
  `
  // Inspection of an empty database must not create the Drizzle schema or journal.
  const applied = table?.exists
    ? await sql<{ hash: string; created_at: string | number | null }[]>`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id
      `
    : []
  if (
    applied.length > catalog.length ||
    applied.some((row, index) => {
      const expected = catalog[index]!
      return row.hash !== expected.hash || String(row.created_at) !== String(expected.when)
    })
  ) {
    throw new Error('DATABASE_MIGRATION_HISTORY_MISMATCH')
  }
  return {
    applied: catalog.slice(0, applied.length).map((entry) => entry.tag),
    pending: catalog.slice(applied.length).map((entry) => entry.tag),
  }
}

export async function databaseMigrationStatus(
  client: DatabaseClient,
  migrationsFolder = DATABASE_MIGRATIONS_FOLDER,
): Promise<MigrationStatus> {
  return status(client.sql, readCatalog(migrationsFolder))
}

/** Applies the existing Drizzle journal without rotating passwords or widening runtime grants. */
export async function migrateDatabase(
  client: DatabaseClient,
  migrationsFolder = DATABASE_MIGRATIONS_FOLDER,
): Promise<MigrationStatus> {
  const catalog = readCatalog(migrationsFolder)
  return client.sql.begin(async (transaction) => {
    // The stock migrator reads history before its transaction. Read, validate and apply on
    // one locked transaction instead, retaining Drizzle's SQL reader and exact journal format.
    const [lock] = await transaction<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${LOCK_CLASS}, ${LOCK_OBJECT}) AS locked
    `
    if (!lock?.locked) throw new Error('DATABASE_MIGRATION_BUSY')
    const before = await status(transaction, catalog)
    if (before.pending.length === 0) return before
    await transaction`CREATE SCHEMA IF NOT EXISTS drizzle`
    await transaction`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `
    for (const migration of catalog.slice(before.applied.length)) {
      // These are reviewed local migration artifacts, never request-supplied SQL.
      for (const statement of migration.statements) await transaction.unsafe(statement)
      await transaction`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.when})
      `
    }
    return status(transaction, catalog)
  })
}
