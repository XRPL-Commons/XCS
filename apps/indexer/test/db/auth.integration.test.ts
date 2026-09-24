import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabaseClient, type DatabaseClient } from '../../src/lib/db/client.js'
import {
  databasePasswordFromUrl,
  provisionRuntimeDatabaseRoles,
} from '../../src/lib/db/bootstrap.js'
import { DATABASE_MIGRATIONS_FOLDER, migrateDatabase } from '../../src/lib/db/migrations.js'

const adminUrl = process.env.XCS_TEST_DATABASE_URL?.trim() || undefined
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !adminUrl) {
  throw new Error('XCS_TEST_DATABASE_URL is required')
}
const passwords = {
  clusterScope: 'dedicated' as const,
  indexerPassword: randomBytes(32).toString('base64url'),
  apiPassword: randomBytes(32).toString('base64url'),
  payloadWriterPassword: randomBytes(32).toString('base64url'),
  monitorPassword: randomBytes(32).toString('base64url'),
  applicationPassword: randomBytes(32).toString('base64url'),
}
const address = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
let administrator: DatabaseClient
let database: DatabaseClient
let application: DatabaseClient
let databaseName: string
let fixtureFolder: string | undefined
let userId: string

async function session() {
  const [row] = await application.sql<{ id: string }[]>`
    INSERT INTO app_sessions (token_hash, user_id, csrf_token, expires_at, absolute_expires_at)
    VALUES (${randomBytes(32).toString('hex')}, ${userId}, ${randomBytes(32).toString('base64url')}, now() + interval '1 hour', now() + interval '1 day') RETURNING id
  `
  return row!.id
}

describe.skipIf(!adminUrl)('authentication schema and restricted application role', () => {
  beforeAll(async () => {
    administrator = createDatabaseClient(adminUrl!, { onNotice: () => undefined })
    databaseName = `xcs_auth_test_${randomUUID().replaceAll('-', '')}`
    await administrator.sql`CREATE DATABASE ${administrator.sql(databaseName)} TEMPLATE template0`
    const url = new URL(adminUrl!)
    url.pathname = `/${databaseName}`
    database = createDatabaseClient(url.toString(), { onNotice: () => undefined })

    // Upgrade the actual preceding catalog, retaining an existing identity/admin grant.
    const journal = JSON.parse(
      await readFile(join(DATABASE_MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] }
    const authIndex = journal.entries.findIndex(({ tag }) => tag === '0004_auth_sessions')
    expect(authIndex).toBe(4)
    fixtureFolder = await mkdtemp(join(tmpdir(), 'xcs-auth-migrations-'))
    await mkdir(join(fixtureFolder, 'meta'))
    const entries = journal.entries.slice(0, authIndex)
    for (const { tag } of entries)
      await copyFile(
        join(DATABASE_MIGRATIONS_FOLDER, `${tag}.sql`),
        join(fixtureFolder, `${tag}.sql`),
      )
    await writeFile(
      join(fixtureFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries }),
    )
    await migrateDatabase(database, fixtureFolder)
    const [user] = await database.sql<{ id: string }[]>`
      INSERT INTO app_users (identity_issuer, identity_subject) VALUES ('https://identity.example.invalid', 'existing') RETURNING id
    `
    userId = user!.id
    await database.sql`INSERT INTO app_user_roles (user_id, role) VALUES (${userId}, 'admin')`
    await migrateDatabase(database)
    await migrateDatabase(database)
    await provisionRuntimeDatabaseRoles(database, {
      ...passwords,
      administratorPassword: databasePasswordFromUrl(adminUrl!),
    })
    url.username = 'xcs_app'
    url.password = passwords.applicationPassword
    application = createDatabaseClient(url.toString(), { onNotice: () => undefined })
  }, 30_000)

  afterAll(async () => {
    await application?.close()
    await database?.close()
    if (administrator && /^xcs_auth_test_[a-f0-9]{32}$/.test(databaseName)) {
      await administrator.sql`DROP DATABASE IF EXISTS ${administrator.sql(databaseName)} WITH (FORCE)`
    }
    await administrator?.close()
    if (fixtureFolder) await rm(fixtureFolder, { recursive: true, force: true })
  })

  it('preserves existing identities and admin grants while defaulting new roles to recipient', async () => {
    expect(
      await application.sql`SELECT role FROM app_user_roles WHERE user_id = ${userId}`,
    ).toEqual([{ role: 'admin' }])
    const [user] = await application.sql<{ id: string }[]>`
      INSERT INTO app_users (identity_issuer, identity_subject, email, display_name)
      VALUES ('https://identity.example.invalid', 'new', 'fixture@example.invalid', 'Fixture') RETURNING id
    `
    await application.sql`INSERT INTO app_user_roles (user_id) VALUES (${user!.id})`
    expect(
      await application.sql`SELECT role FROM app_user_roles WHERE user_id = ${user!.id}`,
    ).toEqual([{ role: 'recipient' }])
    await application.sql`UPDATE app_users SET display_name = 'Updated fixture' WHERE id = ${user!.id}`
    for (const query of [
      () =>
        application.sql`INSERT INTO app_user_roles (user_id, role) VALUES (${user!.id}, 'admin')`,
      () => application.sql`UPDATE app_user_roles SET role = 'admin' WHERE user_id = ${user!.id}`,
      () => application.sql`UPDATE app_users SET status = 'active' WHERE id = ${user!.id}`,
      () =>
        application.sql`UPDATE app_users SET identity_subject = 'another' WHERE id = ${user!.id}`,
      () => application.sql`DELETE FROM app_users WHERE id = ${user!.id}`,
      () => application.sql`UPDATE app_organization_applications SET status = 'approved'`,
      () => application.sql`SELECT * FROM app_organization_applications`,
      () => application.sql`SELECT * FROM app_credential_metadata`,
      () => application.sql`SELECT * FROM app_documents`,
      () => application.sql`SELECT * FROM app_presentations`,
      () => application.sql`SELECT * FROM hosted_payloads`,
      () => application.sql`DELETE FROM schemas`,
      () => application.sql`CREATE TABLE forbidden_auth_table (id integer)`,
    ])
      await expect(query()).rejects.toMatchObject({ code: '42501' })
    expect(
      await application.sql`SELECT organization_id, role, status FROM app_organization_applications`,
    ).toEqual([])
  })

  it('checks session bounds and makes challenge consumption atomic with cascade on logout', async () => {
    const sessionId = await session()
    await expect(
      application.sql`UPDATE app_sessions SET expires_at = absolute_expires_at + interval '1 second' WHERE id = ${sessionId}`,
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      application.sql`UPDATE app_sessions SET token_hash = 'invalid' WHERE id = ${sessionId}`,
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      application.sql`UPDATE app_sessions SET absolute_expires_at = 'infinity' WHERE id = ${sessionId}`,
    ).rejects.toMatchObject({ code: '23514' })
    const [challenge] = await application.sql<{ id: string }[]>`
      INSERT INTO app_wallet_challenges (session_id, network_id, address, message, expires_at)
      VALUES (${sessionId}, 1, ${address}, 'Synthetic proof fixture', now() + interval '5 minutes') RETURNING id
    `
    const consumed = await Promise.all(
      [1, 2].map(
        () => application.sql`
      DELETE FROM app_wallet_challenges WHERE id = ${challenge!.id} AND session_id = ${sessionId} AND expires_at > now() RETURNING id
    `,
      ),
    )
    expect(consumed.map((rows) => rows.length).sort()).toEqual([0, 1])
    await application.sql`
      INSERT INTO app_wallet_challenges (session_id, network_id, address, message, expires_at)
      VALUES (${sessionId}, 1, ${address}, 'Synthetic proof fixture', now() + interval '5 minutes')
    `
    await application.sql`DELETE FROM app_sessions WHERE id = ${sessionId}`
    expect(
      await application.sql`SELECT id FROM app_wallet_challenges WHERE session_id = ${sessionId}`,
    ).toEqual([])
  })

  it('enforces transaction shape, expiry and one-time state consumption', async () => {
    const stateHash = randomBytes(32).toString('hex')
    await application.sql`
      INSERT INTO app_auth_transactions (state_hash, browser_hash, nonce, code_verifier, return_to, expires_at)
      VALUES (${stateHash}, ${randomBytes(32).toString('hex')}, ${randomBytes(32).toString('base64url')}, ${randomBytes(32).toString('base64url')}, '/account', now() + interval '5 minutes')
    `
    for (const invalid of [
      '//attacker.example',
      '/\\attacker.example',
      'https://attacker.example',
      '/account\n',
    ]) {
      await expect(
        application.sql`UPDATE app_auth_transactions SET return_to = ${invalid} WHERE state_hash = ${stateHash}`,
      ).rejects.toMatchObject({ code: '23514' })
    }
    await expect(
      application.sql`UPDATE app_auth_transactions SET expires_at = created_at WHERE state_hash = ${stateHash}`,
    ).rejects.toMatchObject({ code: '23514' })
    const results = await Promise.all(
      [1, 2].map(
        () =>
          application.sql`DELETE FROM app_auth_transactions WHERE state_hash = ${stateHash} RETURNING state_hash`,
      ),
    )
    expect(results.map((rows) => rows.length).sort()).toEqual([0, 1])
  })

  it('permits wallet verification without allowing account reassignment', async () => {
    await application.sql`INSERT INTO app_wallets (user_id, network_id, address, verified_at) VALUES (${userId}, 1, ${address}, now())`
    await application.sql`UPDATE app_wallets SET revoked_at = now() WHERE user_id = ${userId}`
    await expect(
      application.sql`UPDATE app_wallets SET user_id = ${userId} WHERE address = ${address}`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      application.sql`INSERT INTO app_wallets (user_id, network_id, address, verified_at) VALUES (${userId}, 4294967296, ${address}, now())`,
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      application.sql`INSERT INTO app_wallets (user_id, network_id, address, verified_at) VALUES (${userId}, 1, ${address}, now())`,
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('normalizes accidental column grants and disables login and retained connections when omitted', async () => {
    await database.sql`GRANT UPDATE (status) ON app_users TO xcs_app`
    await provisionRuntimeDatabaseRoles(database, {
      ...passwords,
      administratorPassword: databasePasswordFromUrl(adminUrl!),
    })
    await expect(
      application.sql`UPDATE app_users SET status = 'active' WHERE id = ${userId}`,
    ).rejects.toMatchObject({ code: '42501' })
    const { applicationPassword: omitted, ...disabledPasswords } = passwords
    void omitted
    await provisionRuntimeDatabaseRoles(database, {
      ...disabledPasswords,
      administratorPassword: databasePasswordFromUrl(adminUrl!),
    })
    const [role] = await database.sql<{ rolcanlogin: boolean; password_cleared: boolean }[]>`
      SELECT rolcanlogin, rolpassword IS NULL AS password_cleared FROM pg_authid WHERE rolname = 'xcs_app'
    `
    expect(role).toEqual({ rolcanlogin: false, password_cleared: true })
    await expect(application.sql`SELECT id FROM public.app_users`).rejects.toMatchObject({
      code: '42501',
    })
    const [grant] = await database.sql<
      { insert_allowed: boolean }[]
    >`SELECT has_column_privilege('xcs_app', 'app_user_roles', 'user_id', 'INSERT') AS insert_allowed`
    expect(grant?.insert_allowed).toBe(false)
  })
})
