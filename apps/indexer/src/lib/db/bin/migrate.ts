// Not a vendored copy (no upstream: packages/db never had a bin/migrate.ts): applies
// db/migrations without provisioning roles.
import { initializeDatabase, migrationsFolder } from '../bootstrap.js'
import { createDatabaseClient } from '../client.js'

function administratorDatabaseUrl(): string {
  for (const name of ['XCS_BOOTSTRAP_DATABASE_URL', 'XCS_DATABASE_URL'] as const) {
    const value = process.env[name]
    if (value !== undefined && value.trim().length > 0) return value
  }
  throw new Error('XCS_BOOTSTRAP_DATABASE_URL or XCS_DATABASE_URL is required')
}

async function main(): Promise<void> {
  const client = createDatabaseClient(administratorDatabaseUrl())

  try {
    // The migrator records applied migrations in `drizzle.__drizzle_migrations`,
    // so a second run against the same database applies nothing.
    await initializeDatabase(client)
    process.stdout.write(`${JSON.stringify({ ok: true, migrationsFolder: migrationsFolder() })}\n`)
  } finally {
    await client.close()
  }
}

try {
  await main()
} catch {
  // Do not serialize the thrown error: connection errors may contain a URL or password.
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'DATABASE_MIGRATE_FAILED' })}\n`)
  process.exitCode = 1
}
