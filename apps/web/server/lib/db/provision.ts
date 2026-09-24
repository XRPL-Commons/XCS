// Copied from packages/db/src/provision.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
// Diverges by design (recipient presentation writes and verifier evidence history on the shared portal pool); source sha256:95df14330b7a194a132a444fa26ded1872dde31f8ffc26897e9725430275d9cc.
import type { DatabaseClient } from './client.js'

export const XCS_INDEXER_DATABASE_ROLE = 'xcs_indexer' as const
export const XCS_API_DATABASE_ROLE = 'xcs_api' as const
export const XCS_PAYLOAD_WRITER_DATABASE_ROLE = 'xcs_payload_writer' as const
export const XCS_MONITOR_DATABASE_ROLE = 'xcs_monitor' as const
export const XCS_APP_DATABASE_ROLE = 'xcs_app' as const
export const XCS_ADMIN_APP_DATABASE_ROLE = 'xcs_admin_app' as const
export const XCS_NOTIFIER_DATABASE_ROLE = 'xcs_notifier' as const
export const XCS_ISSUER_DATABASE_ROLE = 'xcs_issuer' as const
export const XCS_DATABASE_CLUSTER_SCOPE = 'dedicated' as const

export const XCS_INDEXER_DATABASE_CONNECTION_LIMIT = 12
export const XCS_API_DATABASE_CONNECTION_LIMIT = 12
export const XCS_PAYLOAD_WRITER_DATABASE_CONNECTION_LIMIT = 12
export const XCS_MONITOR_DATABASE_CONNECTION_LIMIT = 3
export const XCS_APP_DATABASE_CONNECTION_LIMIT = 12

const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u
const PROVISION_LOCK_CLASS_ID = 1_480_807_217
const PROVISION_LOCK_OBJECT_ID = 1

export interface RuntimeDatabasePasswords {
  clusterScope: typeof XCS_DATABASE_CLUSTER_SCOPE
  administratorPassword: string
  indexerPassword: string
  apiPassword: string
  payloadWriterPassword: string
  monitorPassword: string
  applicationPassword?: string
  adminApplicationPassword?: string
  notifierPassword?: string
  issuerPassword?: string
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

export function assertRuntimeDatabasePasswords(passwords: RuntimeDatabasePasswords): void {
  parseDatabaseClusterScope(passwords.clusterScope)
  assertPassword(passwords.administratorPassword, 'administratorPassword')
  assertPassword(passwords.indexerPassword, 'indexerPassword')
  assertPassword(passwords.apiPassword, 'apiPassword')
  assertPassword(passwords.payloadWriterPassword, 'payloadWriterPassword')
  assertPassword(passwords.monitorPassword, 'monitorPassword')
  for (const name of [
    'applicationPassword',
    'adminApplicationPassword',
    'notifierPassword',
    'issuerPassword',
  ] as const) {
    const password = passwords[name]
    if (password !== undefined) assertPassword(password, name)
  }

  const values = [
    passwords.administratorPassword,
    passwords.indexerPassword,
    passwords.apiPassword,
    passwords.payloadWriterPassword,
    passwords.monitorPassword,
    passwords.applicationPassword,
    passwords.adminApplicationPassword,
    passwords.notifierPassword,
    passwords.issuerPassword,
  ].filter((value): value is string => value !== undefined)
  if (new Set(values).size !== values.length) {
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
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_payload_writer') THEN
      CREATE ROLE xcs_payload_writer NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_admin_app') THEN
      CREATE ROLE xcs_admin_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_notifier') THEN
      CREATE ROLE xcs_notifier NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_issuer') THEN
      CREATE ROLE xcs_issuer NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xcs_app') THEN
      CREATE ROLE xcs_app NOLOGIN;
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
      WHERE granted_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor', 'xcs_payload_writer', 'xcs_app', 'xcs_admin_app', 'xcs_notifier', 'xcs_issuer')
         OR member_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_monitor', 'xcs_payload_writer', 'xcs_app', 'xcs_admin_app', 'xcs_notifier', 'xcs_issuer')
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
  ALTER ROLE xcs_payload_writer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_PAYLOAD_WRITER_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity';
  ALTER ROLE xcs_monitor WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_MONITOR_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity';
  ALTER ROLE xcs_app WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${XCS_APP_DATABASE_CONNECTION_LIMIT} VALID UNTIL 'infinity' PASSWORD NULL;
  ALTER ROLE xcs_indexer RESET ALL;
  ALTER ROLE xcs_api RESET ALL;
  ALTER ROLE xcs_payload_writer RESET ALL;
  ALTER ROLE xcs_monitor RESET ALL;
  ALTER ROLE xcs_app RESET ALL;
  ALTER ROLE xcs_admin_app WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 VALID UNTIL 'infinity' PASSWORD NULL;
  ALTER ROLE xcs_notifier WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 VALID UNTIL 'infinity' PASSWORD NULL;
  ALTER ROLE xcs_admin_app RESET ALL;
  ALTER ROLE xcs_notifier RESET ALL;
  ALTER ROLE xcs_issuer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 VALID UNTIL 'infinity' PASSWORD NULL;
  ALTER ROLE xcs_issuer RESET ALL;
  ALTER ROLE xcs_issuer SET statement_timeout = '30s';
  ALTER ROLE xcs_issuer SET lock_timeout = '15s';
  ALTER ROLE xcs_issuer SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_admin_app SET statement_timeout = '30s';
  ALTER ROLE xcs_admin_app SET lock_timeout = '15s';
  ALTER ROLE xcs_admin_app SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_notifier SET statement_timeout = '30s';
  ALTER ROLE xcs_notifier SET lock_timeout = '15s';
  ALTER ROLE xcs_notifier SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_indexer SET statement_timeout = '5min';
  ALTER ROLE xcs_indexer SET lock_timeout = '30s';
  ALTER ROLE xcs_indexer SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_api SET statement_timeout = '30s';
  ALTER ROLE xcs_api SET lock_timeout = '15s';
  ALTER ROLE xcs_api SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_payload_writer SET statement_timeout = '30s';
  ALTER ROLE xcs_payload_writer SET lock_timeout = '15s';
  ALTER ROLE xcs_payload_writer SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_monitor SET statement_timeout = '30s';
  ALTER ROLE xcs_monitor SET lock_timeout = '10s';
  ALTER ROLE xcs_monitor SET idle_in_transaction_session_timeout = '30s';
  ALTER ROLE xcs_app SET statement_timeout = '30s';
  ALTER ROLE xcs_app SET lock_timeout = '15s';
  ALTER ROLE xcs_app SET idle_in_transaction_session_timeout = '30s';
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
      'ALTER ROLE xcs_payload_writer PASSWORD %L',
      current_setting('xcs.payload_writer_password')
    );
    EXECUTE format(
      'ALTER ROLE xcs_monitor PASSWORD %L',
      current_setting('xcs.monitor_password')
    );
  END
  $xcs_passwords$;
`

const REVOKE_CURRENT_DATABASE_ACCESS_SQL = `
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  DO $xcs_database_grants$
  BEGIN
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer', current_database());
  END
  $xcs_database_grants$;
`

// Table-level REVOKE does not remove column grants. Normalize these even when auth
// is disabled so prior application releases cannot retain additional privileges.
const REVOKE_APPLICATION_COLUMNS_SQL = `
  DO $xcs_app_columns$
  DECLARE relation record;
  BEGIN
    FOR relation IN
      SELECT table_name, string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) AS columns
      FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name
    LOOP
      EXECUTE format('REVOKE SELECT (%2$s), INSERT (%2$s), UPDATE (%2$s), REFERENCES (%2$s) ON TABLE public.%1$I FROM xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer', relation.table_name, relation.columns);
    END LOOP;
  END
  $xcs_app_columns$;
`

const GRANT_APPLICATION_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_app;
  DO $xcs_app_connect$
  BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_app', current_database());
    EXECUTE format('ALTER ROLE xcs_app PASSWORD %L', current_setting('xcs.application_password'));
  END
  $xcs_app_connect$;
  GRANT SELECT ON TABLE app_users, app_user_roles, app_wallets TO xcs_app;
  GRANT SELECT (id, responsible_user_id, name, status) ON TABLE app_organizations TO xcs_app;
  GRANT SELECT (organization_id, role, status) ON TABLE app_organization_applications TO xcs_app;
  GRANT INSERT (identity_issuer, identity_subject, email, email_verified_at, display_name) ON TABLE app_users TO xcs_app;
  GRANT UPDATE (email, email_verified_at, display_name) ON TABLE app_users TO xcs_app;
  GRANT INSERT (user_id) ON TABLE app_user_roles TO xcs_app;
  GRANT INSERT (user_id, network_id, address, verified_at) ON TABLE app_wallets TO xcs_app;
  GRANT UPDATE (verified_at, revoked_at) ON TABLE app_wallets TO xcs_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_sessions, app_auth_transactions, app_wallet_challenges TO xcs_app;
  ALTER ROLE xcs_app LOGIN;
`

// The portal administrator pool is separate from the bootstrap superuser xcs_admin.
const GRANT_ADMIN_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_admin_app;
  DO $xcs_admin_connect$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_admin_app', current_database());
    EXECUTE format('ALTER ROLE xcs_admin_app PASSWORD %L', current_setting('xcs.admin_application_password'));
  END $xcs_admin_connect$;
  GRANT SELECT (id, email, email_verified_at, display_name, status) ON app_users TO xcs_admin_app;
  GRANT SELECT ON app_user_roles, app_sessions, app_organizations, app_organization_applications, app_documents, app_wallets TO xcs_admin_app;
  GRANT SELECT, INSERT ON app_admin_decisions, app_admin_notifications TO xcs_admin_app;
  GRANT UPDATE (status, reviewed_by, reviewed_at, review_reason, revision) ON app_organization_applications TO xcs_admin_app;
  GRANT UPDATE (status, recipient_email, attempt_id, claimed_at, error_code) ON app_admin_notifications TO xcs_admin_app;
  ALTER ROLE xcs_admin_app LOGIN;
`
const GRANT_NOTIFIER_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_notifier;
  DO $xcs_notifier_connect$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_notifier', current_database());
    EXECUTE format('ALTER ROLE xcs_notifier PASSWORD %L', current_setting('xcs.notifier_password'));
  END $xcs_notifier_connect$;
  GRANT SELECT ON app_admin_notifications, app_admin_decisions TO xcs_notifier;
  GRANT SELECT (id, name) ON app_organizations TO xcs_notifier;
  GRANT SELECT (id, email, email_verified_at, status) ON app_users TO xcs_notifier;
  GRANT UPDATE (status, attempts, attempt_id, claimed_at, sent_at, error_code, recipient_email) ON app_admin_notifications TO xcs_notifier;
  ALTER ROLE xcs_notifier LOGIN;
`

const GRANT_ISSUER_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_issuer;
  DO $xcs_issuer_connect$ BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_issuer', current_database());
    EXECUTE format('ALTER ROLE xcs_issuer PASSWORD %L', current_setting('xcs.issuer_password'));
  END $xcs_issuer_connect$;
  GRANT SELECT (id, email, email_verified_at, display_name, status) ON app_users TO xcs_issuer;
  GRANT SELECT ON app_sessions, app_wallets, app_organizations, app_organization_applications,
    app_schema_metadata, app_invites, app_credential_metadata, app_issuer_payloads,
    app_invite_deliveries, app_presentations, network_profiles, schemas, schema_events,
    credential_generations, credential_events, ledger_checkpoints, indexer_status, app_verifier_history, app_presentation_challenges, app_presentation_proofs TO xcs_issuer;
  GRANT INSERT (id, responsible_user_id, name) ON app_organizations TO xcs_issuer;
  GRANT INSERT (organization_id, role, website, contact, jurisdiction, description, purpose) ON app_organization_applications TO xcs_issuer;
  GRANT INSERT (id, organization_id, application_role, storage_key, mime_type, byte_length, sha256, uploaded_by) ON app_documents TO xcs_issuer;
  GRANT INSERT ON app_schema_metadata, app_invites, app_credential_metadata, app_issuer_payloads, app_invite_deliveries TO xcs_issuer;
  GRANT UPDATE (token_hash, expires_at, revoked_at, claimed_by, claimed_at) ON app_invites TO xcs_issuer;
  GRANT UPDATE (status, error_code) ON app_invite_deliveries TO xcs_issuer;
  GRANT INSERT ON app_presentations, app_verifier_history, app_presentation_challenges, app_presentation_proofs TO xcs_issuer;
  GRANT DELETE ON app_presentation_challenges TO xcs_issuer;
  GRANT UPDATE (revoked_at) ON app_presentations TO xcs_issuer;
  ALTER ROLE xcs_issuer LOGIN;
`

const GRANT_RUNTIME_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_indexer, xcs_api, xcs_payload_writer;
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
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pin_challenges, demo_pins TO xcs_payload_writer;
  GRANT SELECT, INSERT ON TABLE hosted_payloads, hosted_payload_publications TO xcs_payload_writer;
`

export async function provisionRuntimeDatabaseRoles(
  client: DatabaseClient,
  passwords: RuntimeDatabasePasswords,
): Promise<void> {
  assertRuntimeDatabasePasswords(passwords)

  await client.sql.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_CLASS_ID}, ${PROVISION_LOCK_OBJECT_ID})`
    await sql.unsafe(CREATE_ROLES_SQL)
    await sql.unsafe(NORMALIZE_ROLE_MEMBERSHIPS_SQL)
    await sql.unsafe(NORMALIZE_ROLE_ATTRIBUTES_SQL)
    await sql`SELECT set_config('password_encryption', 'scram-sha-256', true)`
    await sql`SELECT set_config('xcs.indexer_password', ${passwords.indexerPassword}, true)`
    await sql`SELECT set_config('xcs.api_password', ${passwords.apiPassword}, true)`
    await sql`SELECT set_config('xcs.payload_writer_password', ${passwords.payloadWriterPassword}, true)`
    await sql`SELECT set_config('xcs.monitor_password', ${passwords.monitorPassword}, true)`
    await sql.unsafe(SET_ROLE_PASSWORDS_SQL)
    await sql.unsafe(REVOKE_CURRENT_DATABASE_ACCESS_SQL)
    await sql.unsafe(REVOKE_APPLICATION_COLUMNS_SQL)
    await sql.unsafe(GRANT_RUNTIME_ACCESS_SQL)
    if (passwords.applicationPassword !== undefined) {
      await sql`SELECT set_config('xcs.application_password', ${passwords.applicationPassword}, true)`
      await sql.unsafe(GRANT_APPLICATION_ACCESS_SQL)
    }
    if (passwords.adminApplicationPassword !== undefined) {
      await sql`SELECT set_config('xcs.admin_application_password', ${passwords.adminApplicationPassword}, true)`
      await sql.unsafe(GRANT_ADMIN_ACCESS_SQL)
    }
    if (passwords.notifierPassword !== undefined) {
      await sql`SELECT set_config('xcs.notifier_password', ${passwords.notifierPassword}, true)`
      await sql.unsafe(GRANT_NOTIFIER_ACCESS_SQL)
    }
    if (passwords.issuerPassword !== undefined) {
      await sql`SELECT set_config('xcs.issuer_password', ${passwords.issuerPassword}, true)`
      await sql.unsafe(GRANT_ISSUER_ACCESS_SQL)
    }
    await sql.unsafe(
      'ALTER ROLE xcs_indexer LOGIN; ALTER ROLE xcs_api LOGIN; ALTER ROLE xcs_monitor LOGIN; ALTER ROLE xcs_payload_writer LOGIN;',
    )
  })
}
