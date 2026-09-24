import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDatabaseClient, type DatabaseClient } from '../../src/lib/db/client.js'
import { bootstrapFirstAdmin } from '../../src/lib/db/app/bootstrap-admin.js'
import {
  databasePasswordFromUrl,
  provisionRuntimeDatabaseRoles,
} from '../../src/lib/db/bootstrap.js'
import { migrateDatabase } from '../../src/lib/db/migrations.js'

const adminUrl = process.env.XCS_TEST_DATABASE_URL?.trim() || undefined
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !adminUrl)
  throw new Error('XCS_TEST_DATABASE_URL is required')
let root: DatabaseClient, database: DatabaseClient, admin: DatabaseClient, notifier: DatabaseClient
let databaseName: string,
  userId: string,
  secondUserId: string,
  organizationId: string,
  decisionId: string
const passwords = {
  clusterScope: 'dedicated' as const,
  indexerPassword: randomBytes(32).toString('base64url'),
  apiPassword: randomBytes(32).toString('base64url'),
  payloadWriterPassword: randomBytes(32).toString('base64url'),
  monitorPassword: randomBytes(32).toString('base64url'),
  adminApplicationPassword: randomBytes(32).toString('base64url'),
  notifierPassword: randomBytes(32).toString('base64url'),
}
const identity = {
  issuer: 'https://identity.example.invalid',
  subject: 'initial-admin',
  operator: 'synthetic-test-operator',
}

describe.skipIf(!adminUrl)('admin audit, operator bootstrap and restricted database roles', () => {
  beforeAll(async () => {
    root = createDatabaseClient(adminUrl!, { onNotice: () => undefined })
    databaseName = `xcs_admin_test_${randomUUID().replaceAll('-', '')}`
    await root.sql`CREATE DATABASE ${root.sql(databaseName)} TEMPLATE template0`
    const url = new URL(adminUrl!)
    url.pathname = `/${databaseName}`
    database = createDatabaseClient(url.toString(), { onNotice: () => undefined })
    await migrateDatabase(database)
    await migrateDatabase(database)
    await provisionRuntimeDatabaseRoles(database, {
      ...passwords,
      administratorPassword: databasePasswordFromUrl(adminUrl!),
    })
    url.username = 'xcs_admin_app'
    url.password = passwords.adminApplicationPassword
    admin = createDatabaseClient(url.toString(), { onNotice: () => undefined })
    url.username = 'xcs_notifier'
    url.password = passwords.notifierPassword
    notifier = createDatabaseClient(url.toString(), { onNotice: () => undefined })
    const users = await database.sql<
      { id: string }[]
    >`INSERT INTO app_users (identity_issuer, identity_subject) VALUES (${identity.issuer}, ${identity.subject}), (${identity.issuer}, 'another') RETURNING id`
    userId = users[0]!.id
    secondUserId = users[1]!.id
    const [org] = await database.sql<
      { id: string }[]
    >`INSERT INTO app_organizations (responsible_user_id, name) VALUES (${secondUserId}, 'Synthetic organization') RETURNING id`
    organizationId = org!.id
    await database.sql`INSERT INTO app_organization_applications (organization_id, role) VALUES (${organizationId}, 'verifier')`
  }, 30_000)
  afterAll(async () => {
    await admin?.close()
    await notifier?.close()
    await database?.close()
    if (root && /^xcs_admin_test_[a-f0-9]{32}$/.test(databaseName))
      await root.sql`DROP DATABASE IF EXISTS ${root.sql(databaseName)} WITH (FORCE)`
    await root?.close()
  })

  it('serializes initial admin bootstrap, grants once and retains exactly one audit record', async () => {
    const outcomes = await Promise.all([
      bootstrapFirstAdmin(database, identity),
      bootstrapFirstAdmin(database, identity),
    ])
    expect(outcomes.map((x) => x.created).sort()).toEqual([false, true])
    expect(await database.sql`SELECT user_id, operator FROM app_admin_bootstrap_audit`).toEqual([
      { user_id: userId, operator: identity.operator },
    ])
    await expect(
      bootstrapFirstAdmin(database, { ...identity, subject: 'another' }),
    ).rejects.toThrow('ADMIN_BOOTSTRAP_ALREADY_INITIALIZED')
    await expect(
      bootstrapFirstAdmin(database, { ...identity, issuer: 'https://another.example.invalid' }),
    ).rejects.toThrow('ADMIN_BOOTSTRAP_ACCOUNT_NOT_FOUND')
    await database.sql`UPDATE app_user_roles SET revoked_at = now() WHERE user_id = ${userId} AND role = 'admin'`
    await expect(bootstrapFirstAdmin(database, identity)).rejects.toThrow('ADMIN_BOOTSTRAP_REVOKED')
    await database.sql`UPDATE app_user_roles SET revoked_at = NULL WHERE user_id = ${userId} AND role = 'admin'`
  })

  it('rolls back the approval and audit when its notification insert fails', async () => {
    await expect(
      admin.sql.begin(async (sql) => {
        await sql`UPDATE app_organization_applications SET status = 'approved', revision = 1, reviewed_by = ${userId}, reviewed_at = now() WHERE organization_id = ${organizationId} AND role = 'verifier'`
        const [decision] = await sql<
          { id: string }[]
        >`INSERT INTO app_admin_decisions (organization_id,role,actor_id,action,before_status,after_status,revision,idempotency_key,request_hash) VALUES (${organizationId},'verifier',${userId},'approve','pending','approved',1,${randomUUID()},${'a'.repeat(64)}) RETURNING id`
        await sql`INSERT INTO app_admin_notifications (decision_id,recipient_user_id,status) VALUES (${decision!.id},${secondUserId},'invalid')`
      }),
    ).rejects.toMatchObject({ code: '23514' })
    expect(
      await admin.sql`SELECT status, revision FROM app_organization_applications WHERE organization_id = ${organizationId}`,
    ).toEqual([{ status: 'pending', revision: 0 }])
    expect(await admin.sql`SELECT id FROM app_admin_decisions`).toEqual([])
  })

  it('enforces immutable audit, notification uniqueness and valid state metadata', async () => {
    const key = randomUUID()
    const [decision] = await admin.sql<
      { id: string }[]
    >`INSERT INTO app_admin_decisions (organization_id,role,actor_id,action,before_status,after_status,revision,idempotency_key,request_hash) VALUES (${organizationId},'verifier',${userId},'approve','pending','approved',1,${key},${'a'.repeat(64)}) RETURNING id`
    decisionId = decision!.id
    await expect(
      admin.sql`INSERT INTO app_admin_decisions (organization_id,role,actor_id,action,before_status,after_status,revision,idempotency_key,request_hash) VALUES (${organizationId},'verifier',${userId},'approve','pending','approved',2,${key},${'a'.repeat(64)})`,
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      admin.sql`INSERT INTO app_admin_decisions (organization_id,role,actor_id,action,before_status,after_status,revision,idempotency_key,request_hash) VALUES (${organizationId},'verifier',${userId},'suspend','approved','suspended',2,${randomUUID()},${'a'.repeat(64)})`,
    ).rejects.toMatchObject({ code: '23514' })
    await admin.sql`INSERT INTO app_admin_notifications (decision_id,recipient_user_id,status) VALUES (${decisionId},${secondUserId},'blocked')`
    await expect(
      admin.sql`INSERT INTO app_admin_notifications (decision_id,recipient_user_id,status) VALUES (${decisionId},${secondUserId},'blocked')`,
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      notifier.sql`UPDATE app_admin_notifications SET status = 'sending' WHERE decision_id = ${decisionId}`,
    ).rejects.toMatchObject({ code: '23514' })
    await notifier.sql`UPDATE app_admin_notifications SET status = 'sending', attempts = attempts + 1, attempt_id = ${randomUUID()}, claimed_at = now(), recipient_email = 'synthetic@example.invalid' WHERE decision_id = ${decisionId}`
    await notifier.sql`UPDATE app_admin_notifications SET status = 'uncertain', error_code = 'INTERRUPTED' WHERE decision_id = ${decisionId}`
    expect(
      await admin.sql`SELECT status, attempts FROM app_admin_notifications WHERE decision_id = ${decisionId}`,
    ).toEqual([{ status: 'uncertain', attempts: 1 }])
  })

  it('denies claims, ledger data, identity subjects, admin grants and audit modifications to runtime pools', async () => {
    for (const client of [admin, notifier]) {
      for (const query of [
        () => client.sql`SELECT * FROM app_credential_metadata`,
        () => client.sql`SELECT * FROM app_presentations`,
        () => client.sql`SELECT * FROM schemas`,
        () => client.sql`SELECT identity_subject FROM public.app_users`,
        () =>
          client.sql`INSERT INTO app_user_roles (user_id,role) VALUES (${secondUserId},'admin')`,
        () =>
          client.sql`UPDATE app_admin_decisions SET reason = 'tampered' WHERE id = ${decisionId}`,
        () => client.sql`DELETE FROM app_admin_decisions WHERE id = ${decisionId}`,
        () => client.sql`DELETE FROM app_admin_notifications WHERE decision_id = ${decisionId}`,
      ])
        await expect(query()).rejects.toMatchObject({ code: '42501' })
    }
    await expect(notifier.sql`SELECT * FROM app_documents`).rejects.toMatchObject({ code: '42501' })
    await expect(
      notifier.sql`UPDATE app_organization_applications SET revision = 2`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(admin.sql`UPDATE app_admin_notifications SET attempts = 0`).rejects.toMatchObject({
      code: '42501',
    })
    await expect(
      admin.sql`UPDATE app_organizations SET responsible_user_id = ${userId}`,
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('removes stale column grants and disables both optional runtime roles when omitted', async () => {
    await database.sql`GRANT SELECT (identity_subject) ON app_users TO xcs_admin_app, xcs_notifier`
    const { adminApplicationPassword: a, notifierPassword: n, ...disabled } = passwords
    void a
    void n
    await provisionRuntimeDatabaseRoles(database, {
      ...disabled,
      administratorPassword: databasePasswordFromUrl(adminUrl!),
    })
    const rows = await database.sql<
      { rolcanlogin: boolean; cleared: boolean }[]
    >`SELECT rolcanlogin, rolpassword IS NULL AS cleared FROM pg_authid WHERE rolname IN ('xcs_admin_app','xcs_notifier')`
    expect(rows).toEqual([
      { rolcanlogin: false, cleared: true },
      { rolcanlogin: false, cleared: true },
    ])
    for (const client of [admin, notifier])
      await expect(client.sql`SELECT identity_subject FROM public.app_users`).rejects.toMatchObject(
        {
          code: '42501',
        },
      )
  })
})
