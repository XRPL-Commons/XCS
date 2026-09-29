// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
// Provisioning is grants-only: DigitalOcean owns runtime users and passwords.
import type { TransactionSql } from 'postgres'

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

const PROVISION_LOCK_CLASS_ID = 1_480_807_217
const PROVISION_LOCK_OBJECT_ID = 1

export const XCS_RUNTIME_DATABASE_ROLES = [
  XCS_INDEXER_DATABASE_ROLE,
  XCS_API_DATABASE_ROLE,
  XCS_PAYLOAD_WRITER_DATABASE_ROLE,
  XCS_MONITOR_DATABASE_ROLE,
  XCS_APP_DATABASE_ROLE,
  XCS_ADMIN_APP_DATABASE_ROLE,
  XCS_NOTIFIER_DATABASE_ROLE,
  XCS_ISSUER_DATABASE_ROLE,
] as const

export const XCS_INDEXER_DATABASE_CONNECTION_LIMIT = 12
export const XCS_API_DATABASE_CONNECTION_LIMIT = 12
export const XCS_MONITOR_DATABASE_CONNECTION_LIMIT = 3

export interface RuntimeDatabaseProvisioning {
  clusterScope: typeof XCS_DATABASE_CLUSTER_SCOPE
}

export function parseDatabaseClusterScope(
  value: string | undefined,
): typeof XCS_DATABASE_CLUSTER_SCOPE {
  if (value !== XCS_DATABASE_CLUSTER_SCOPE) {
    throw new DatabaseBootstrapConfigurationError(
      `XCS_DATABASE_CLUSTER_SCOPE must be ${XCS_DATABASE_CLUSTER_SCOPE}; runtime roles are cluster-wide`,
    )
  }
  return XCS_DATABASE_CLUSTER_SCOPE
}

/** An operator configuration mistake: a missing or invalid environment value.
 * It is built from names and fixed text only, never from a connection string,
 * so the CLI can print its message without leaking a credential. */
export class DatabaseBootstrapConfigurationError extends Error {
  readonly code = 'DATABASE_BOOTSTRAP_CONFIGURATION' as const

  constructor(message: string) {
    super(message)
    this.name = 'DatabaseBootstrapConfigurationError'
  }
}

/** The managed database service creates the users and holds their passwords; this
 * step only assigns privileges, so a role it cannot find is an operator error.
 * It names the missing roles and carries no credential, so the CLI can print it. */
export class MissingRuntimeDatabaseRolesError extends Error {
  readonly code = 'DATABASE_ROLES_MISSING' as const
  readonly roles: readonly string[]

  constructor(missing: readonly string[]) {
    const names = missing.join(', ')
    super(
      `Database ${missing.length === 1 ? 'role' : 'roles'} ${names} ` +
        `${missing.length === 1 ? 'does' : 'do'} not exist. Database users are owned by the ` +
        'managed database service, not by this step: create ' +
        `${names} in the DigitalOcean control panel (Databases -> the cluster -> Users) or with ` +
        '`doctl databases user create`, then run the grants step again. This step never creates ' +
        'a role and never sets, resets or reads a role password.',
    )
    this.name = 'MissingRuntimeDatabaseRolesError'
    this.roles = missing
  }
}

/** A runtime role the managed database service has configured in a way this
 * deployment must not run against: it cannot log in, or it holds an attribute
 * that would defeat least privilege. Provisioning does not own role attributes
 * -- altering them requires a superuser, which a managed cluster's
 * administrator is not -- so it verifies them and refuses to continue.
 * It names roles and findings only, never a credential, so the CLI can print it. */
export class UnsafeRuntimeDatabaseRolesError extends Error {
  readonly code = 'DATABASE_ROLES_UNSAFE' as const
  readonly roles: readonly string[]
  readonly findings: readonly string[]

  constructor(findings: readonly string[], roles: readonly string[]) {
    super(
      `Database ${roles.length === 1 ? 'role' : 'roles'} ${roles.join(', ')} ` +
        `${roles.length === 1 ? 'is' : 'are'} not configured safely for least-privilege ` +
        `runtime access: ${findings.join('; ')}. Role attributes and role memberships belong to ` +
        'the managed database service, not to this step: a managed cluster administrator is not a ' +
        'superuser and cannot change them. Fix them in the DigitalOcean control panel ' +
        '(Databases -> the cluster -> Users) or with `doctl databases user` and run the grants ' +
        'step again. This step never creates a role and never sets, resets or reads a role password.',
    )
    this.name = 'UnsafeRuntimeDatabaseRolesError'
    this.roles = roles
    this.findings = findings
  }
}

/** Per-role resource and safety controls. These are not security attributes:
 * a non-superuser administrator holding CREATEROLE and ADMIN OPTION on the
 * role may set them (verified against PostgreSQL 16 and 17), so provisioning
 * still applies them -- one statement each, outside the grants, so a cluster
 * that refuses one cannot cost the deployment its privileges. */
interface RuntimeRoleResourceControls {
  readonly connectionLimit: number
  readonly settings: Readonly<Record<string, string>>
}

const XCS_RUNTIME_DATABASE_ROLE_RESOURCE_CONTROLS: Readonly<
  Record<(typeof XCS_RUNTIME_DATABASE_ROLES)[number], RuntimeRoleResourceControls>
> = {
  xcs_indexer: {
    connectionLimit: XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '5min',
      lock_timeout: '30s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_api: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_payload_writer: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_monitor: {
    connectionLimit: XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '10s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_app: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_admin_app: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_notifier: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
  xcs_issuer: {
    connectionLimit: XCS_API_DATABASE_CONNECTION_LIMIT,
    settings: {
      statement_timeout: '30s',
      lock_timeout: '15s',
      idle_in_transaction_session_timeout: '30s',
    },
  },
}

/** A resource control the cluster refused and that is not already in effect.
 * Reported rather than thrown: the privilege grants are the point of this step
 * and must not be lost to a missing timeout, but a deployment must never
 * quietly lose one either. */
export interface UnappliedRuntimeRoleResourceControl {
  readonly role: string
  readonly control: string
  readonly intended: string
  readonly actual: string
}

export interface RuntimeDatabaseProvisioningReport {
  /** The cluster administrator this run authenticated as, read from the live
   * session. Its membership in the runtime roles is how a managed service
   * administers its own users and is accepted, not revoked. */
  readonly administrator: string
  readonly unappliedResourceControls: readonly UnappliedRuntimeRoleResourceControl[]
}

interface RuntimeRoleAttributes {
  roleName: string
  canLogin: boolean
  isSuperuser: boolean
  canCreateDatabase: boolean
  canCreateRole: boolean
  canReplicate: boolean
  canBypassRls: boolean
  connectionLimit: number
  configuration: string[] | null
}

const UNSAFE_ROLE_ATTRIBUTES = [
  ['isSuperuser', 'is a superuser'],
  ['canCreateDatabase', 'can create databases'],
  ['canCreateRole', 'can create roles'],
  ['canReplicate', 'can replicate'],
  ['canBypassRls', 'can bypass row-level security'],
] as const

function unsafeRoleAttributeFindings(roles: readonly RuntimeRoleAttributes[]): string[] {
  const findings: string[] = []
  for (const role of roles) {
    const reasons: string[] = []
    if (!role.canLogin) reasons.push('cannot log in')
    for (const [attribute, reason] of UNSAFE_ROLE_ATTRIBUTES) {
      if (role[attribute]) reasons.push(reason)
    }
    if (reasons.length > 0) findings.push(`${role.roleName} ${reasons.join(' and ')}`)
  }
  return findings
}

interface RuntimeRoleMembership {
  grantedRole: string
  memberRole: string
}

function unsafeRoleMembershipFindings(
  memberships: readonly RuntimeRoleMembership[],
  administrator: string,
): string[] {
  const runtimeRoles = new Set<string>(XCS_RUNTIME_DATABASE_ROLES)
  const findings: string[] = []
  for (const { grantedRole, memberRole } of memberships) {
    // The one membership this deployment grants itself.
    if (grantedRole === 'pg_monitor' && memberRole === XCS_MONITOR_DATABASE_ROLE) continue
    // The cluster administrator is a member of every user the managed service
    // creates for it, granted by the platform's own superuser. That is how the
    // service administers those users; it is not ours to remove.
    if (memberRole === administrator && runtimeRoles.has(grantedRole)) continue
    if (runtimeRoles.has(memberRole)) {
      findings.push(`${memberRole} is a member of ${grantedRole}`)
    } else {
      findings.push(
        `${memberRole} is a member of ${grantedRole} but is not the cluster administrator`,
      )
    }
  }
  return findings
}

function unsafeRoleNames(findings: readonly string[]): string[] {
  const named = XCS_RUNTIME_DATABASE_ROLES.filter((role) =>
    findings.some((finding) => finding.includes(role)),
  )
  return named.length > 0 ? [...named] : [...XCS_RUNTIME_DATABASE_ROLES]
}

const REVOKE_CURRENT_DATABASE_ACCESS_SQL = `
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  DO $xcs_database_grants$
  BEGIN
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC, xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer', current_database());
  END
  $xcs_database_grants$;
`

// Table-level REVOKE does not remove column grants. Normalize every runtime role
// so a previous release cannot retain broader column-level privileges.
const REVOKE_RUNTIME_COLUMNS_SQL = `
  DO $xcs_app_columns$
  DECLARE relation record;
  BEGIN
    FOR relation IN
      SELECT table_name, string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) AS columns
      FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name
    LOOP
      EXECUTE format('REVOKE SELECT (%2$s), INSERT (%2$s), UPDATE (%2$s), REFERENCES (%2$s) ON TABLE public.%1$I FROM xcs_indexer, xcs_api, xcs_monitor, xcs_payload_writer, xcs_app, xcs_admin_app, xcs_notifier, xcs_issuer', relation.table_name, relation.columns);
    END LOOP;
  END
  $xcs_app_columns$;
`

const GRANT_APPLICATION_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_app;
  GRANT SELECT ON TABLE app_users, app_user_roles, app_wallets TO xcs_app;
  GRANT SELECT (id, responsible_user_id, name, status) ON TABLE app_organizations TO xcs_app;
  GRANT SELECT (organization_id, role, status) ON TABLE app_organization_applications TO xcs_app;
  GRANT INSERT (identity_issuer, identity_subject, email, email_verified_at, display_name) ON TABLE app_users TO xcs_app;
  GRANT UPDATE (email, email_verified_at, display_name) ON TABLE app_users TO xcs_app;
  GRANT INSERT (user_id) ON TABLE app_user_roles TO xcs_app;
  GRANT INSERT (user_id, network_id, address, verified_at) ON TABLE app_wallets TO xcs_app;
  GRANT UPDATE (verified_at, revoked_at) ON TABLE app_wallets TO xcs_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_sessions, app_auth_transactions, app_wallet_challenges TO xcs_app;
`

// The portal administrator pool is separate from the bootstrap superuser xcs_admin.
const GRANT_ADMIN_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_admin_app;
  GRANT SELECT (id, email, email_verified_at, display_name, status) ON app_users TO xcs_admin_app;
  GRANT SELECT ON app_user_roles, app_sessions, app_organizations, app_organization_applications, app_documents, app_wallets TO xcs_admin_app;
  GRANT SELECT, INSERT ON app_admin_decisions, app_admin_notifications TO xcs_admin_app;
  GRANT UPDATE (status, reviewed_by, reviewed_at, review_reason, revision) ON app_organization_applications TO xcs_admin_app;
  GRANT UPDATE (status, recipient_email, attempt_id, claimed_at, error_code) ON app_admin_notifications TO xcs_admin_app;
`
const GRANT_NOTIFIER_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_notifier;
  GRANT SELECT ON app_admin_notifications, app_admin_decisions TO xcs_notifier;
  GRANT SELECT (id, name) ON app_organizations TO xcs_notifier;
  GRANT SELECT (id, email, email_verified_at, status) ON app_users TO xcs_notifier;
  GRANT UPDATE (status, attempts, attempt_id, claimed_at, sent_at, error_code, recipient_email) ON app_admin_notifications TO xcs_notifier;
`

const GRANT_ISSUER_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_issuer;
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
`

const GRANT_RUNTIME_ACCESS_SQL = `
  GRANT USAGE ON SCHEMA public TO xcs_indexer, xcs_api, xcs_payload_writer;

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

const RUNTIME_ROLE_ATTRIBUTES_SQL = `
  SELECT
    rolname AS "roleName",
    rolcanlogin AS "canLogin",
    rolsuper AS "isSuperuser",
    rolcreatedb AS "canCreateDatabase",
    rolcreaterole AS "canCreateRole",
    rolreplication AS "canReplicate",
    rolbypassrls AS "canBypassRls",
    rolconnlimit AS "connectionLimit",
    rolconfig AS "configuration"
  FROM pg_roles
  WHERE rolname IN ('xcs_indexer', 'xcs_api', 'xcs_payload_writer', 'xcs_monitor', 'xcs_app', 'xcs_admin_app', 'xcs_notifier', 'xcs_issuer')
  ORDER BY rolname
`

const RUNTIME_ROLE_MEMBERSHIPS_SQL = `
  SELECT granted_role.rolname AS "grantedRole", member_role.rolname AS "memberRole"
  FROM pg_auth_members auth_membership
  JOIN pg_roles granted_role ON granted_role.oid = auth_membership.roleid
  JOIN pg_roles member_role ON member_role.oid = auth_membership.member
  WHERE granted_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_payload_writer', 'xcs_monitor', 'xcs_app', 'xcs_admin_app', 'xcs_notifier', 'xcs_issuer')
     OR member_role.rolname IN ('xcs_indexer', 'xcs_api', 'xcs_payload_writer', 'xcs_monitor', 'xcs_app', 'xcs_admin_app', 'xcs_notifier', 'xcs_issuer')
  ORDER BY granted_role.rolname, member_role.rolname
`

function settingOf(configuration: readonly string[] | null, name: string): string | undefined {
  const prefix = `${name}=`
  const entry = configuration?.find((candidate) => candidate.startsWith(prefix))
  return entry === undefined ? undefined : entry.slice(prefix.length)
}

export async function prepareRuntimeDatabaseProvisioningInTransaction(
  sql: TransactionSql,
  provisioning: RuntimeDatabaseProvisioning,
): Promise<string> {
  parseDatabaseClusterScope(provisioning.clusterScope)
  await sql`SELECT pg_advisory_xact_lock(${PROVISION_LOCK_CLASS_ID}, ${PROVISION_LOCK_OBJECT_ID})`

  const [session] = await sql<{ administrator: string }[]>`
    SELECT current_user AS "administrator"
  `
  const administrator = session?.administrator
  if (administrator === undefined) {
    throw new DatabaseBootstrapConfigurationError(
      'The database session reported no current user, so the cluster administrator could not ' +
        'be identified. Provisioning verifies role memberships against it and cannot continue.',
    )
  }

  const present = await sql.unsafe<RuntimeRoleAttributes[]>(RUNTIME_ROLE_ATTRIBUTES_SQL)
  const found = new Set(present.map((row) => row.roleName))
  const missing = XCS_RUNTIME_DATABASE_ROLES.filter((role) => !found.has(role))
  if (missing.length > 0) throw new MissingRuntimeDatabaseRolesError(missing)

  const memberships = await sql.unsafe<RuntimeRoleMembership[]>(RUNTIME_ROLE_MEMBERSHIPS_SQL)
  const findings = [
    ...unsafeRoleAttributeFindings(present),
    ...unsafeRoleMembershipFindings(memberships, administrator),
  ]
  if (findings.length > 0) {
    throw new UnsafeRuntimeDatabaseRolesError(findings, unsafeRoleNames(findings))
  }

  return administrator
}

export async function applyRuntimeDatabasePrivilegesInTransaction(
  sql: TransactionSql,
  administrator: string,
): Promise<RuntimeDatabaseProvisioningReport> {
  await sql.unsafe(REVOKE_CURRENT_DATABASE_ACCESS_SQL)
  await sql.unsafe(REVOKE_RUNTIME_COLUMNS_SQL)
  await sql.unsafe(GRANT_RUNTIME_ACCESS_SQL)
  await sql.unsafe(GRANT_APPLICATION_ACCESS_SQL)
  await sql.unsafe(GRANT_ADMIN_ACCESS_SQL)
  await sql.unsafe(GRANT_NOTIFIER_ACCESS_SQL)
  await sql.unsafe(GRANT_ISSUER_ACCESS_SQL)

  // pg_monitor is a predefined role the cluster owns. Passing it on requires
  // the administrator to hold it WITH ADMIN OPTION, which a managed provider
  // need not grant, so this is attempted rather than assumed: DigitalOcean
  // refuses it at `check_role_membership_authorization`. A refusal costs the
  // monitor role its server statistics, not the deployment, and it is named
  // in the report rather than passing unnoticed.
  const monitorGrants: { role: string; control: string; intended: string }[] = []
  try {
    await sql.savepoint(async (scoped) => {
      await scoped.unsafe('GRANT pg_monitor TO xcs_monitor WITH INHERIT TRUE, SET FALSE')
    })
  } catch {
    monitorGrants.push({
      role: XCS_MONITOR_DATABASE_ROLE,
      control: 'pg_monitor membership',
      intended: 'granted',
    })
  }

  // Resource controls last, one statement each inside its own savepoint, so
  // a cluster that refuses one keeps the grants above.
  const refused: { role: string; control: string; intended: string }[] = []
  for (const role of XCS_RUNTIME_DATABASE_ROLES) {
    const controls = XCS_RUNTIME_DATABASE_ROLE_RESOURCE_CONTROLS[role]
    const statements: { control: string; intended: string; statement: string }[] = [
      {
        control: 'CONNECTION LIMIT',
        intended: String(controls.connectionLimit),
        statement: `ALTER ROLE ${role} WITH CONNECTION LIMIT ${controls.connectionLimit}`,
      },
      ...Object.entries(controls.settings).map(([name, value]) => ({
        control: name,
        intended: value,
        statement: `ALTER ROLE ${role} SET ${name} = '${value}'`,
      })),
    ]
    for (const { control, intended, statement } of statements) {
      try {
        await sql.savepoint(async (scoped) => {
          await scoped.unsafe(statement)
        })
      } catch {
        refused.push({ role, control, intended })
      }
    }
  }

  // A refusal is only a loss if the intended value is not already in effect.
  let unappliedResourceControls: UnappliedRuntimeRoleResourceControl[] = []
  if (refused.length > 0) {
    const effective = await sql.unsafe<RuntimeRoleAttributes[]>(RUNTIME_ROLE_ATTRIBUTES_SQL)
    const byRole = new Map(effective.map((row) => [row.roleName, row]))
    unappliedResourceControls = refused.flatMap(({ role, control, intended }) => {
      const row = byRole.get(role)
      const actual =
        control === 'CONNECTION LIMIT'
          ? row === undefined
            ? undefined
            : String(row.connectionLimit)
          : settingOf(row?.configuration ?? null, control)
      return actual === intended ? [] : [{ role, control, intended, actual: actual ?? 'unset' }]
    })
  }

  // A refused pg_monitor grant is only a loss when the membership is absent.
  const unappliedMonitorGrants: UnappliedRuntimeRoleResourceControl[] = []
  if (monitorGrants.length > 0) {
    const [held] = await sql<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        JOIN pg_roles member_role ON member_role.oid = membership.member
        WHERE granted_role.rolname = 'pg_monitor'
          AND member_role.rolname = ${XCS_MONITOR_DATABASE_ROLE}
      ) AS present
    `
    if (held?.present !== true) {
      unappliedMonitorGrants.push(...monitorGrants.map((entry) => ({ ...entry, actual: 'absent' })))
    }
  }

  return {
    administrator,
    unappliedResourceControls: [...unappliedResourceControls, ...unappliedMonitorGrants],
  }
}
export async function provisionRuntimeDatabasePrivileges(
  client: DatabaseClient,
  provisioning: RuntimeDatabaseProvisioning,
): Promise<RuntimeDatabaseProvisioningReport> {
  parseDatabaseClusterScope(provisioning.clusterScope)
  return await client.sql.begin(async (sql) => {
    const administrator = await prepareRuntimeDatabaseProvisioningInTransaction(sql, provisioning)
    return await applyRuntimeDatabasePrivilegesInTransaction(sql, administrator)
  })
}
