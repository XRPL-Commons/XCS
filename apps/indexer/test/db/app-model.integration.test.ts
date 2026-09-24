import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDatabaseClient, type DatabaseClient } from '../../src/lib/db/client.js'
import { claimInvitation } from '../../src/lib/db/app/invitations.js'
import { createAppToken, hashAppToken } from '../../src/lib/db/app/tokens.js'
import { filterCredentialClaims, getCredentialAccess } from '../../src/lib/db/app/visibility.js'
import {
  appUsers,
  appUserRoles,
  appOrganizations,
  appOrganizationApplications,
  appSchemaMetadata,
  appInvites,
  appCredentialMetadata,
  appPresentations,
  appWallets,
  appDocuments,
} from '#db/schema/app/index.js'

const adminUrl = process.env.XCS_TEST_DATABASE_URL?.trim() || undefined
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !adminUrl)
  throw new Error('XCS_TEST_DATABASE_URL is required')
const migrationsFolder = fileURLToPath(new URL('../../../../db/migrations', import.meta.url))
const ids = {
  issuer: randomUUID(),
  recipient: randomUUID(),
  verifier: randomUUID(),
  outsider: randomUUID(),
  admin: randomUUID(),
  issuerOrg: randomUUID(),
  verifierOrg: randomUUID(),
  otherOrg: randomUUID(),
}
const key = { profileId: 'app-testnet', generationId: 'b'.repeat(64) }
const schemaUid = 'a'.repeat(64)
const address = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const privateClaims = { course: 'XRPL basics', learner: { name: 'Synthetic learner' } }
let administrator: DatabaseClient
let database: DatabaseClient
let databaseName: string
let fixtureFolder: string | undefined
let presentationToken: string

async function invitation(overrides: Partial<typeof appInvites.$inferInsert> = {}) {
  const token = createAppToken()
  const [invite] = await database.db
    .insert(appInvites)
    .values({
      organizationId: ids.issuerOrg,
      profileId: key.profileId,
      schemaUid,
      deliveryEmail: 'invited@example.invalid',
      createdBy: ids.issuer,
      tokenHash: token.tokenHash,
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    })
    .returning()
  return { ...token, invite: invite! }
}

async function access(userId: string | null, token?: string, identity = key) {
  return getCredentialAccess(database.db, {
    ...identity,
    viewerUserId: userId,
    ...(token === undefined ? {} : { presentationToken: token }),
  })
}

describe.skipIf(!adminUrl)('application model on PostgreSQL', () => {
  beforeAll(async () => {
    administrator = createDatabaseClient(adminUrl!)
    databaseName = `xcs_app_test_${randomUUID().replaceAll('-', '')}`
    await administrator.sql`CREATE DATABASE ${administrator.sql(databaseName)} TEMPLATE template0`
    const url = new URL(adminUrl!)
    url.pathname = `/${databaseName}`
    database = createDatabaseClient(url.toString())

    // Upgrade an actual previous database; preserve a pre-existing public payload.
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as {
      version: string
      dialect: string
      entries: { tag: string }[]
    }
    const appIndex = journal.entries.findIndex((entry) => entry.tag.endsWith('_application_model'))
    expect(appIndex).toBeGreaterThan(0)
    fixtureFolder = await mkdtemp(join(tmpdir(), 'xcs-app-migrations-'))
    await mkdir(join(fixtureFolder, 'meta'))
    const entries = journal.entries.slice(0, appIndex)
    for (const entry of entries)
      await copyFile(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(fixtureFolder, `${entry.tag}.sql`),
      )
    await writeFile(
      join(fixtureFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries }),
    )
    await migrate(database.db, { migrationsFolder: fixtureFolder })
    await database.sql`INSERT INTO hosted_payloads (locator, digest_hex, content) VALUES (${'1'.repeat(20)}, ${'a'.repeat(64)}, ${'{"test":true}'})`
    await migrate(database.db, { migrationsFolder })
    await migrate(database.db, { migrationsFolder })
  }, 30_000)

  afterAll(async () => {
    await database?.close()
    if (administrator && /^xcs_app_test_[a-f0-9]{32}$/.test(databaseName)) {
      await administrator.sql`DROP DATABASE IF EXISTS ${administrator.sql(databaseName)} WITH (FORCE)`
    }
    await administrator?.close()
    if (fixtureFolder?.startsWith(join(tmpdir(), 'xcs-app-migrations-')))
      await rm(fixtureFolder, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Only this suite's isolated database and application tables are reset.
    await database.sql`TRUNCATE app_presentation_challenges, app_presentation_proofs, app_verifier_history, app_issuer_payloads, app_invite_deliveries, app_admin_notifications, app_admin_decisions, app_admin_bootstrap_audit, app_wallet_challenges, app_sessions, app_auth_transactions, app_presentations, app_credential_metadata, app_invites, app_schema_metadata, app_documents, app_organization_applications, app_wallets, app_user_roles, app_organizations, app_users`
    await database.db.insert(appUsers).values(
      Object.entries(ids)
        .filter(([name]) => !name.endsWith('Org'))
        .map(([name, id]) => ({
          id,
          identityIssuer: 'https://identity.example.invalid',
          identitySubject: name,
          email: `${name}@example.invalid`,
        })),
    )
    await database.db.insert(appUserRoles).values({ userId: ids.admin, role: 'admin' })
    await database.db.insert(appOrganizations).values([
      { id: ids.issuerOrg, responsibleUserId: ids.issuer, name: 'Example school' },
      { id: ids.verifierOrg, responsibleUserId: ids.verifier, name: 'Example verifier' },
      { id: ids.otherOrg, responsibleUserId: ids.outsider, name: 'Other verifier' },
    ])
    await database.db.insert(appOrganizationApplications).values(
      [
        { organizationId: ids.issuerOrg, role: 'issuer' as const },
        { organizationId: ids.verifierOrg, role: 'verifier' as const },
        { organizationId: ids.otherOrg, role: 'verifier' as const },
      ].map((row) => ({
        ...row,
        status: 'approved' as const,
        reviewedBy: ids.admin,
        reviewedAt: sql`CURRENT_TIMESTAMP`,
      })),
    )
    await database.db.insert(appSchemaMetadata).values({
      profileId: key.profileId,
      schemaUid,
      organizationId: ids.issuerOrg,
      registrationTransactionHash: 'c'.repeat(64),
    })
    await database.db.insert(appCredentialMetadata).values({
      ...key,
      schemaUid,
      issuerOrganizationId: ids.issuerOrg,
      recipientUserId: ids.recipient,
      issuerAddress: address,
      subjectAddress: address,
      visibility: 'private',
      publicFields: ['/course'],
      payloadStorageKey: 'private/fictional-test-object',
      payloadDigest: 'd'.repeat(64),
      creationTransactionHash: 'e'.repeat(64),
      creationLedgerIndex: 100,
    })
    const token = createAppToken()
    presentationToken = token.token
    await database.db.insert(appPresentations).values({
      ...key,
      recipientUserId: ids.recipient,
      verifierOrganizationId: ids.verifierOrg,
      scope: 'full',
      tokenHash: token.tokenHash,
    })
  })

  it('upgrades without altering existing hosted payload bytes', async () => {
    const rows =
      await database.sql`SELECT content FROM hosted_payloads WHERE locator = ${'1'.repeat(20)}`
    expect(rows[0]?.content).toBe('{"test":true}')
  })

  it('also creates the complete model on an empty database', async () => {
    const name = `xcs_app_test_${randomUUID().replaceAll('-', '')}`
    await administrator.sql`CREATE DATABASE ${administrator.sql(name)} TEMPLATE template0`
    const url = new URL(adminUrl!)
    url.pathname = `/${name}`
    const fresh = createDatabaseClient(url.toString())
    try {
      await migrate(fresh.db, { migrationsFolder })
      const [row] = await fresh.sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND left(table_name, 4) = 'app_'
      `
      expect(row?.count).toBe(21)
      expect(await fresh.db.select().from(appUsers)).toEqual([])
    } finally {
      await fresh.close()
      await administrator.sql`DROP DATABASE ${administrator.sql(name)} WITH (FORCE)`
    }
  })

  it.each([null, ids.outsider, ids.admin])(
    'exposes only public fields to non-owners including admin %s',
    async (user) => {
      const result = await access(user, presentationToken)
      expect(result?.scope).toBe('public')
      expect(filterCredentialClaims(privateClaims, result!)).toEqual({ course: 'XRPL basics' })
    },
  )

  it.each([ids.issuer, ids.recipient])(
    'allows the owner without a presentation %s',
    async (user) => {
      const result = await access(user)
      expect(result?.scope).toBe('full')
      expect(filterCredentialClaims(privateClaims, result!)).toEqual(privateClaims)
    },
  )

  it('requires the designated verifier AND its grant, without an automatic expiry', async () => {
    expect((await access(ids.verifier))?.scope).toBe('public')
    expect((await access(ids.verifier, 'invalid'))?.scope).toBe('public')
    await database.db.update(appPresentations).set({ createdAt: new Date('2000-01-01T00:00:00Z') })
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('full')
    expect((await access(ids.outsider, presentationToken))?.scope).toBe('public')
  })

  it('rechecks grant revocation and organization approval on subsequent reads', async () => {
    await database.db.update(appPresentations).set({ revokedAt: sql`CURRENT_TIMESTAMP` })
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('public')
    await database.db.update(appPresentations).set({ revokedAt: null })
    await database.db
      .update(appOrganizationApplications)
      .set({ status: 'suspended', reviewReason: 'Test suspension' })
      .where(eq(appOrganizationApplications.organizationId, ids.verifierOrg))
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('public')
  })

  it('rejects suspended accounts/organizations and public-only grants for private access', async () => {
    await database.db
      .update(appUsers)
      .set({ status: 'suspended' })
      .where(eq(appUsers.id, ids.verifier))
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('public')
    await database.db
      .update(appUsers)
      .set({ status: 'active' })
      .where(eq(appUsers.id, ids.verifier))
    await database.db
      .update(appOrganizations)
      .set({ status: 'suspended' })
      .where(eq(appOrganizations.id, ids.verifierOrg))
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('public')
    await database.db
      .update(appOrganizations)
      .set({ status: 'active' })
      .where(eq(appOrganizations.id, ids.verifierOrg))
    await database.db.update(appPresentations).set({ scope: 'public' })
    expect((await access(ids.verifier, presentationToken))?.scope).toBe('public')
  })

  it('does not reuse a grant for another generation or network profile', async () => {
    expect(
      await access(ids.verifier, presentationToken, { ...key, profileId: 'another-network' }),
    ).toBeNull()
    const [original] = await database.db.select().from(appCredentialMetadata)
    const another = { ...key, generationId: 'f'.repeat(64) }
    await database.db.insert(appCredentialMetadata).values({ ...original!, ...another })
    expect((await access(ids.verifier, presentationToken, another))?.scope).toBe('public')
    const anotherProfile = { ...key, profileId: 'another-network' }
    const [schema] = await database.db.select().from(appSchemaMetadata)
    await database.db
      .insert(appSchemaMetadata)
      .values({ ...schema!, profileId: anotherProfile.profileId })
    await database.db.insert(appCredentialMetadata).values({ ...original!, ...anotherProfile })
    expect((await access(ids.verifier, presentationToken, anotherProfile))?.scope).toBe('public')
  })

  it('returns all public credential claims even anonymously', async () => {
    await database.db.update(appCredentialMetadata).set({ visibility: 'public' })
    expect((await access(null))?.scope).toBe('full')
  })

  it('lets a different-email account claim the link without verifying that email', async () => {
    const { token } = await invitation()
    expect((await claimInvitation(database.db, { token, userId: ids.recipient }))?.claimedBy).toBe(
      ids.recipient,
    )
    const [user] = await database.db.select().from(appUsers).where(eq(appUsers.id, ids.recipient))
    expect(user?.email).toBe('recipient@example.invalid')
    expect(user?.emailVerifiedAt).toBeNull()
    expect(await claimInvitation(database.db, { token, userId: ids.outsider })).toBeNull()
  })

  it('allows only one concurrent claimant', async () => {
    const { token } = await invitation()
    const results = await Promise.all(
      [ids.recipient, ids.outsider].map((userId) =>
        claimInvitation(database.db, { token, userId }),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const [row] = await database.db.select().from(appInvites)
    expect(row?.claimedBy).toBe(results.find(Boolean)?.claimedBy)
  })

  it('checks invitation expiry at the claim statement, not at transaction start', async () => {
    const { token, invite } = await invitation()
    await database.db.transaction(async (transaction) => {
      await transaction
        .update(appInvites)
        .set({ expiresAt: sql`CURRENT_TIMESTAMP + interval '50 milliseconds'` })
        .where(eq(appInvites.id, invite.id))
      await transaction.execute(sql`SELECT pg_sleep(0.1)`)
      expect(await claimInvitation(transaction, { token, userId: ids.recipient })).toBeNull()
    })
  })

  it('refuses expired, revoked, malformed invitations and suspended claimants', async () => {
    const expired = await invitation({
      createdAt: new Date(Date.now() - 7200_000),
      expiresAt: new Date(Date.now() - 3600_000),
    })
    const revoked = await invitation({ revokedAt: new Date() })
    for (const token of [expired.token, revoked.token, 'invalid']) {
      expect(await claimInvitation(database.db, { token, userId: ids.recipient })).toBeNull()
    }
    const valid = await invitation()
    await database.db
      .update(appUsers)
      .set({ status: 'suspended' })
      .where(eq(appUsers.id, ids.recipient))
    expect(
      await claimInvitation(database.db, { token: valid.token, userId: ids.recipient }),
    ).toBeNull()
  })

  it('enforces the invitation claimant and presentation recipient in SQL', async () => {
    const { token, invite } = await invitation()
    await claimInvitation(database.db, { token, userId: ids.outsider })
    await expect(
      database.db.update(appCredentialMetadata).set({ inviteId: invite.id }),
    ).rejects.toThrow()
    await expect(
      database.db.update(appPresentations).set({ recipientUserId: ids.outsider }),
    ).rejects.toThrow()
    await expect(
      database.db.update(appPresentations).set({ verifierOrganizationId: null }),
    ).rejects.toThrow()
  })

  it('enforces wallet uniqueness, organization ownership and structured public-field lists', async () => {
    const wallet = { userId: ids.recipient, networkId: 1, address, verifiedAt: new Date() }
    await database.db.insert(appWallets).values(wallet)
    await expect(
      database.db.insert(appWallets).values({ ...wallet, userId: ids.outsider }),
    ).rejects.toThrow()
    await database.db.insert(appWallets).values({ ...wallet, networkId: 0 })
    await expect(
      database.db.update(appCredentialMetadata).set({ issuerOrganizationId: ids.otherOrg }),
    ).rejects.toThrow()
    await expect(
      database.sql`UPDATE app_credential_metadata SET public_fields = '[1]'::jsonb`,
    ).rejects.toThrow()
    await expect(
      database.sql`UPDATE app_credential_metadata SET visibility = 'unexpected'`,
    ).rejects.toThrow()
  })

  it('keeps PII removable without cascading deletion into credential ownership', async () => {
    const [document] = await database.db
      .insert(appDocuments)
      .values({
        organizationId: ids.issuerOrg,
        applicationRole: 'issuer',
        storageKey: 'review/test-object',
        mimeType: 'application/pdf',
        byteLength: 10,
        sha256: 'a'.repeat(64),
        uploadedBy: ids.issuer,
      })
      .returning()
    await database.db.delete(appDocuments).where(eq(appDocuments.id, document!.id))
    await expect(
      database.db.delete(appUsers).where(eq(appUsers.id, ids.recipient)),
    ).rejects.toThrow()
    await database.db
      .update(appUsers)
      .set({
        status: 'deleted',
        identityIssuer: null,
        identitySubject: null,
        email: null,
        emailVerifiedAt: null,
        displayName: null,
        deletedAt: new Date(),
      })
      .where(eq(appUsers.id, ids.recipient))
    expect((await access(ids.recipient))?.scope).toBe('public')
    expect(await database.db.select().from(appCredentialMetadata)).toHaveLength(1)
  })

  it('can look up the presentation only by its hash, never a raw token column', async () => {
    const [presentation] = await database.db.select().from(appPresentations)
    expect(presentation?.tokenHash).toBe(hashAppToken(presentationToken))
    expect(Object.values(presentation!)).not.toContain(presentationToken)
  })
})
