// Copied from packages/db/src/app/bootstrap-admin.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import type { DatabaseClient } from '../client.js'

/** Explicit one-time operator action. Never invoked by login or migration. */
export async function bootstrapFirstAdmin(
  client: DatabaseClient,
  input: { issuer: string; subject: string; operator: string },
): Promise<{ userId: string; created: boolean }> {
  if (
    !input.issuer.trim() ||
    !input.subject.trim() ||
    !input.operator.trim() ||
    input.operator.length > 200
  ) {
    throw new Error('ADMIN_BOOTSTRAP_INPUT_INVALID')
  }
  return client.sql.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(1480807217, 30)`
    const [user] = await sql<{ id: string }[]>`SELECT id FROM app_users
      WHERE identity_issuer = ${input.issuer} AND identity_subject = ${input.subject} AND status = 'active' FOR UPDATE`
    if (!user) throw new Error('ADMIN_BOOTSTRAP_ACCOUNT_NOT_FOUND')
    const roles = await sql<
      { user_id: string; revoked_at: Date | null }[]
    >`SELECT user_id, revoked_at FROM app_user_roles WHERE role = 'admin' FOR UPDATE`
    if (roles.some((role) => role.user_id === user.id && role.revoked_at !== null))
      throw new Error('ADMIN_BOOTSTRAP_REVOKED')
    if (roles.some((role) => role.user_id !== user.id && role.revoked_at === null))
      throw new Error('ADMIN_BOOTSTRAP_ALREADY_INITIALIZED')
    if (roles.some((role) => role.user_id === user.id)) return { userId: user.id, created: false }
    // Historical bootstrap also prevents using this command to replace a removed administrator.
    const previous = await sql`SELECT id FROM app_admin_bootstrap_audit LIMIT 1`
    if (previous.length) throw new Error('ADMIN_BOOTSTRAP_ALREADY_INITIALIZED')
    await sql`INSERT INTO app_user_roles (user_id, role, granted_by) VALUES (${user.id}, 'admin', ${user.id})`
    await sql`INSERT INTO app_admin_bootstrap_audit (user_id, operator) VALUES (${user.id}, ${input.operator.trim()})`
    return { userId: user.id, created: true }
  })
}
