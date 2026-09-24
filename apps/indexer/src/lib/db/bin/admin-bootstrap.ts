// Copied from packages/db/src/bin/admin-bootstrap.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { createDatabaseClient } from '../client.js'
import { bootstrapFirstAdmin } from '../app/bootstrap-admin.js'
import { requiredEnvironment } from './environment.js'

try {
  const client = createDatabaseClient(requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL'), {
    onNotice: () => undefined,
  })
  try {
    const result = await bootstrapFirstAdmin(client, {
      issuer: requiredEnvironment('XCS_ADMIN_IDENTITY_ISSUER'),
      subject: requiredEnvironment('XCS_ADMIN_IDENTITY_SUBJECT'),
      operator: requiredEnvironment('XCS_ADMIN_BOOTSTRAP_OPERATOR'),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, created: result.created })}\n`)
  } finally {
    await client.close()
  }
} catch (error) {
  const code =
    error instanceof Error && /^ADMIN_BOOTSTRAP_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'ADMIN_BOOTSTRAP_FAILED'
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
}
