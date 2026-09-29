// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
import { createDatabaseClient } from '../client.js'
import { databaseMigrationStatus } from '../migrations.js'
import { requiredEnvironment } from './environment.js'

try {
  const client = createDatabaseClient(requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL'), {
    onNotice: () => undefined,
  })
  try {
    const result = await databaseMigrationStatus(client)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } finally {
    await client.close()
  }
} catch {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: 'DATABASE_MIGRATION_STATUS_FAILED' })}\n`,
  )
  process.exitCode = 1
}
