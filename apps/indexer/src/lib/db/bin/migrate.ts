// Copied from packages/db/src/bin/migrate.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { createDatabaseClient } from '../client.js'
import { migrateDatabase } from '../migrations.js'
import { requiredEnvironment } from './environment.js'

try {
  const client = createDatabaseClient(requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL'), {
    onNotice: () => undefined,
  })
  try {
    const result = await migrateDatabase(client)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } finally {
    await client.close()
  }
} catch {
  // Database errors may include connection credentials or SQL; never serialize them.
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'DATABASE_MIGRATION_FAILED' })}\n`)
  process.exitCode = 1
}
