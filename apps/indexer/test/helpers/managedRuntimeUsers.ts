import type { DatabaseClient } from '../../src/lib/db/client.js'

const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u

export interface ManagedRuntimeDatabasePasswords {
  indexerPassword: string
  apiPassword: string
  payloadWriterPassword: string
  monitorPassword: string
  applicationPassword: string
  adminApplicationPassword: string
  notifierPassword: string
  issuerPassword: string
}

export const MANAGED_RUNTIME_DATABASE_PASSWORDS: ManagedRuntimeDatabasePasswords = {
  indexerPassword: 'integration-only-indexer-password-0001',
  apiPassword: 'integration-only-api-password-00000001',
  payloadWriterPassword: 'integration-only-payload-password-001',
  monitorPassword: 'integration-only-monitor-password-0001',
  applicationPassword: 'integration-only-application-password-1',
  adminApplicationPassword: 'integration-only-admin-password-00001',
  notifierPassword: 'integration-only-notifier-password-001',
  issuerPassword: 'integration-only-issuer-password-00001',
}

const ROLE_PASSWORD_PROPERTIES = [
  ['xcs_indexer', 'indexerPassword'],
  ['xcs_api', 'apiPassword'],
  ['xcs_payload_writer', 'payloadWriterPassword'],
  ['xcs_monitor', 'monitorPassword'],
  ['xcs_app', 'applicationPassword'],
  ['xcs_admin_app', 'adminApplicationPassword'],
  ['xcs_notifier', 'notifierPassword'],
  ['xcs_issuer', 'issuerPassword'],
] as const

/**
 * Test-only stand-in for DigitalOcean. Production bootstrap must never call this:
 * the managed database service creates the users and owns their passwords.
 */
export async function createManagedRuntimeDatabaseUsers(
  administrator: DatabaseClient,
  overrides: Partial<ManagedRuntimeDatabasePasswords> = {},
): Promise<ManagedRuntimeDatabasePasswords> {
  const passwords = { ...MANAGED_RUNTIME_DATABASE_PASSWORDS, ...overrides }
  for (const [, property] of ROLE_PASSWORD_PROPERTIES) {
    if (!PASSWORD_PATTERN.test(passwords[property])) {
      throw new Error(`Invalid test password for ${property}`)
    }
  }

  // Role names are fixed constants and passwords are constrained above to URL-safe
  // characters. PostgreSQL utility statements do not accept password parameters.
  await administrator.sql.unsafe(
    ROLE_PASSWORD_PROPERTIES.map(
      ([role, property]) => `
        DO $xcs_test_user$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
            CREATE ROLE ${role} LOGIN;
          END IF;
        END
        $xcs_test_user$;
        ALTER ROLE ${role} WITH LOGIN PASSWORD '${passwords[property]}';
      `,
    ).join('\n'),
  )
  return passwords
}
