import type { DatabaseClient } from './client.js'

export const XCS_INDEXER_DATABASE_ROLE = 'xcs_indexer' as const
export const XCS_API_DATABASE_ROLE = 'xcs_api' as const
export const XCS_MONITOR_DATABASE_ROLE = 'xcs_monitor' as const
export const XCS_DATABASE_CLUSTER_SCOPE = 'dedicated' as const

export const XCS_INDEXER_DATABASE_CONNECTION_LIMIT = 12
export const XCS_API_DATABASE_CONNECTION_LIMIT = 12
export const XCS_MONITOR_DATABASE_CONNECTION_LIMIT = 3

const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u
const PROVISION_LOCK_CLASS_ID = 1_480_807_217
const PROVISION_LOCK_OBJECT_ID = 1

export interface RuntimeDatabasePasswords {
  clusterScope: typeof XCS_DATABASE_CLUSTER_SCOPE
  administratorPassword: string
  indexerPassword: string
  apiPassword: string
  monitorPassword: string
}

export function parseDatabaseClusterScope(
  value: string | undefined,
): typeof XCS_DATABASE_CLUSTER_SCOPE {
  if (value !== XCS_DATABASE_CLUSTER_SCOPE) {
    throw new Error(
      `XCS_DATABASE_CLUSTER_SCOPE must be ${XCS_DATABASE_CLUSTER_SCOPE}; runtime roles are cluster-wide`,
    )
  }
  return XCS_DATABASE_CLUSTER_SCOPE
}

export function databasePasswordFromUrl(databaseUrl: string): string {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    throw new Error(
      'The selected administrator database URL must be a PostgreSQL URL with a password',
    )
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username.length === 0 ||
    url.password.length === 0
  ) {
    throw new Error(
      'The selected administrator database URL must be a PostgreSQL URL with a password',
    )
  }
  return decodeURIComponent(url.password)
}

function assertPassword(value: string, name: string): void {
  if (!PASSWORD_PATTERN.test(value)) {
    throw new Error(`${name} must be 32-256 URL-safe characters (A-Z, a-z, 0-9, _ or -)`)
  }
}

function assertPasswords(passwords: RuntimeDatabasePasswords): void {
  parseDatabaseClusterScope(passwords.clusterScope)
  assertPassword(passwords.administratorPassword, 'administratorPassword')
  assertPassword(passwords.indexerPassword, 'indexerPassword')
  assertPassword(passwords.apiPassword, 'apiPassword')
  assertPassword(passwords.monitorPassword, 'monitorPassword')

  if (
    new Set([
      passwords.administratorPassword,
      passwords.indexerPassword,
      passwords.apiPassword,
      passwords.monitorPassword,
    ]).size !== 4
  ) {
    throw new Error('administrator and runtime database passwords must be pairwise distinct')
  }
}

const CREATE_ROLES_SQL = `
  DO $xcs_roles$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_indexer') THEN
      CREATE ROLE xcs_indexer NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_api') THEN
      CREATE ROLE xcs_api NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_monitor') THEN
      CREATE ROLE xcs_monitor NOLOGIN;
    END IF;
  END
  $xcs_roles$;
`

const NORMALIZE_ROLE_MEMBERSHIPS_SQL = `
  DO $xcs_memberships$
  DECLARE
    membership record;
  BEGIN
    FOR membership IN
      SELECT granted_role.rolname AS granted_role, member_role.rolname AS member_role
      FROM pg_auth_members auth_membership
      JOIN pg_roles granted_role ON granted_role.oid = auth_membership.roleid
      JOIN pg_roles member_role ON member_role.oid = auth_membership.member
      WHERE granted_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
         OR member_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor')
    LOOP
      IF membership.granted_role = 'pg_monitor' AND membership.member_role = 'xcs_monitor' THEN
        CONTINUE;
      END IF;
      EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
    END LOOP;
  END
  $xcs_memberships$;
`

const NORMALIZE_ROLE_ATTRIBUTES_SQL = `
  ALTER ROLE xcs_indexer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_INDEXER_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity';
  ALTER ROLE xcs_api WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_API_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity';
  ALTER ROLE xcs_monitor WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_MONITOR_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity';
  ALTER ROLE xcs_indexer RESET ALL;
  ALTER ROLE xcs_api RESET ALL;
  ALTER ROLE xcs_monitor RESET ALL;
  ALTER ROLE xcs_indexer SET statement_timeout = '5min';
  ALTER ROLE xcs_indexer SET lock_timeout = '30s';
  ALTER ROLE xcs_indexer SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_api SET statement_timeout = '30s';
  ALTER ROLE xcs_api SET lock_timeout = '15s';
  ALTER ROLE xcs_api SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_monitor SET statement_timeout = '30s';
  ALTER ROLE xcs_monitor SET lock_timeout = '10s';
  ALTER ROLE xcs_monitor SET idle_in_transaction_session_timeout = '30s';
`

const SET_ROLE_PASSWORDS_SQL = `
  DO $xcs_passwords$
  BEGIN
    EXECUTE format(
      'ALTER ROLE xcs_indexer PASSWORD %L',
      current_setting('xcs.indexer_password')
    );
    EXECUTE format(
      'ALTER ROLE xcs_api PASSWORD %L',
      current_setting('xcs.api_password')
    );
    EXECUTE format(
      'ALTER ROLE xcs_monitor PASSWORD %L',
      current_setting('xcs.monitor_password')
    );
  END
  $xcs_passwords$;
`

const REVOKE_CURRENT_DATABASE_ACCESS_SQL = `
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor;
  REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  DO $xcs_database_grants$
  BEGIN
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_indexer, xcs_api, xcs_monitor', current_database());
  END
  $xcs_database_grants$;
`

const GRANT_RUNTIME_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_indexer, xcs_api;
  GRANT pg_monitor TO xcs_monitor WITH INHERIT TRUE, SET FALSE;

  GRANT SELECT, INSERT ON TABLE
    network_profiles, ledger_checkpoints, schema_events, schemas, credential_events
  TO xcs_indexer;
  GRANT SELECT, INSERT ON TABLE indexer_status, credential_generations TO xcs_indexer;
  GRANT UPDATE (
    state, primary_source_tip, secondary_source_tip, last_agreed_ledger_index,
    last_agreed_ledger_hash, error_code, writer_id, writer_epoch, lease_expires_at, updated_at
  ) ON TABLE indexer_status TO xcs_indexer;
  GRANT UPDATE (
    accepted, last_ledger_index, deleted_ledger_index, deletion_cause, updated_at
  ) ON TABLE credential_generations TO xcs_indexer;
  GRANT SELECT, INSERT ON TABLE indexer_incidents TO xcs_indexer;

  GRANT SELECT ON TABLE
    network_profiles, ledger_checkpoints, indexer_status, indexer_incidents,
    schema_events, schemas, credential_generations, credential_events
  TO xcs_api;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pin_challenges, demo_pins TO xcs_api;
`

export async function provisionRuntimeDatabaseRoles(
  client: DatabaseClient,
  passwords: RuntimeDatabasePasswords,
): Promise<void> {
  assertPasswords(passwords)

  await client.sql.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_CLASS_ID}, ${PROVISION_LOCK_OBJECT_ID})`
    await sql.unsafe(CREATE_ROLES_SQL)
    await sql.unsafe(NORMALIZE_ROLE_MEMBERSHIPS_SQL)
    await sql.unsafe(NORMALIZE_ROLE_ATTRIBUTES_SQL)
    await sql`SELECT set_config('password_encryption', 'scram-sha-256', true)`
    await sql`SELECT set_config('xcs.indexer_password', ${passwords.indexerPassword}, true)`
    await sql`SELECT set_config('xcs.api_password', ${passwords.apiPassword}, true)`
    await sql`SELECT set_config('xcs.monitor_password', ${passwords.monitorPassword}, true)`
    await sql.unsafe(SET_ROLE_PASSWORDS_SQL)
    await sql.unsafe(REVOKE_CURRENT_DATABASE_ACCESS_SQL)
    await sql.unsafe(GRANT_RUNTIME_ACCESS_SQL)
    await sql.unsafe(
      'ALTER ROLE xcs_indexer LOGIN; ALTER ROLE xcs_api LOGIN; ALTER ROLE xcs_monitor LOGIN;',
    )
  })
}
