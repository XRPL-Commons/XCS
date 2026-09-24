import { createApp, toNodeListener } from 'h3'
import inject from 'light-my-request'
import { createAuthHandler, SESSION_COOKIE } from '../server/xcs/auth/http'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')
let admin: DatabaseClient,
  database: DatabaseClient,
  app: DatabaseClient,
  repo: PostgresAuthRepository,
  name: string
const input = () => ({
  ...createAppToken(),
  csrfToken: createAppToken().token,
  idleSeconds: 1800,
  absoluteSeconds: 28800,
})
const identity = {
  issuer: 'https://identity.example',
  subject: 'integration-user',
  email: 'user@example.test',
  emailVerified: false,
}

describe.skipIf(!url)('PostgreSQL auth repository through xcs_app', () => {
  beforeAll(async () => {
    admin = createDatabaseClient(url!, { onNotice: () => undefined })
    name = `xcs_auth_web_${randomUUID().replaceAll('-', '')}`
    await admin.sql`CREATE DATABASE ${admin.sql(name)} TEMPLATE template0`
    const parsed = new URL(url!)
    parsed.pathname = '/' + name
    database = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const applicationPassword = randomBytes(32).toString('base64url')
    await bootstrapDatabase(database, {
      clusterScope: 'dedicated',
      administratorPassword: databasePasswordFromUrl(url!),
      indexerPassword: randomBytes(32).toString('base64url'),
      apiPassword: randomBytes(32).toString('base64url'),
      payloadWriterPassword: randomBytes(32).toString('base64url'),
      monitorPassword: randomBytes(32).toString('base64url'),
      applicationPassword,
    })
    parsed.username = 'xcs_app'
    parsed.password = applicationPassword
    app = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    repo = new PostgresAuthRepository(app)
  }, 30000)
  afterAll(async () => {
    await app?.close()
    await database?.close()
    if (admin && /^xcs_auth_web_[a-f0-9]{32}$/.test(name))
      await admin.sql`DROP DATABASE ${admin.sql(name)} WITH (FORCE)`
    await admin?.close()
  })
  it('consumes a login state atomically and only with its browser binding', async () => {
    const state = createAppToken(),
      browser = createAppToken()
    await repo.saveLogin({
      stateHash: state.tokenHash,
      browserHash: browser.tokenHash,
      nonce: createAppToken().token,
      codeVerifier: createAppToken().token,
      returnTo: '/account',
      expiresAt: new Date(Date.now() + 600000),
    })
    expect(await repo.consumeLogin(state.tokenHash, createAppToken().tokenHash)).toBeNull()
    const results = await Promise.all([
      repo.consumeLogin(state.tokenHash, browser.tokenHash),
      repo.consumeLogin(state.tokenHash, browser.tokenHash),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
  it('creates only a recipient grant and never merges different subjects by email', async () => {
    const first = input(),
      second = input()
    await repo.createSession(identity, first)
    await repo.createSession({ ...identity, subject: 'another-user' }, second)
    const a = await repo.session(first.tokenHash),
      b = await repo.session(second.tokenHash)
    expect(a!.account.roles).toEqual(['recipient'])
    expect(a!.userId).not.toBe(b!.userId)
    const [row] = await database.sql`SELECT email_verified_at FROM app_users WHERE id=${a!.userId}`
    expect(row!.email_verified_at).toBeNull()
    await expect(
      app.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${a!.userId},'admin')`,
    ).rejects.toMatchObject({ code: '42501' })
  })
  it('serializes actual PostgreSQL timestamps through the HTTP boundary', async () => {
    const value = input()
    await repo.createSession({ ...identity, emailVerified: true }, value)
    const handler = createAuthHandler({
      repository: repo,
      origin: 'https://xcs.example',
      idleSeconds: 1800,
      absoluteSeconds: 28800,
      provider: { authorizationUrl: async () => '', exchange: async () => identity },
    })
    const response = await inject(toNodeListener(createApp().use(handler)), {
      url: '/api/auth/session',
      headers: { cookie: `${SESSION_COOKIE}=${value.token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().expiresAt).toMatch(/Z$/)
    expect(response.json().user.roles).toEqual(['recipient'])
  })
  it('rotates session secrets once and reads live account suspension', async () => {
    const first = input(),
      next = input()
    await repo.createSession(identity, first)
    const original = await repo.session(first.tokenHash)
    expect(await repo.refresh(first.tokenHash, next)).toBe(true)
    expect(await repo.refresh(first.tokenHash, input())).toBe(false)
    expect(await repo.session(first.tokenHash)).toBeNull()
    const refreshed = await repo.session(next.tokenHash)
    expect(refreshed!.absoluteExpiresAt).toEqual(original!.absoluteExpiresAt)
    await database.sql`UPDATE app_users SET status='suspended' WHERE id=${refreshed!.userId}`
    expect(await repo.session(next.tokenHash)).toBeNull()
    await expect(repo.createSession(identity, input())).rejects.toThrow('AUTH_ACCOUNT_UNAVAILABLE')
    await database.sql`UPDATE app_users SET status='active' WHERE id=${refreshed!.userId}`
  })
  it('revokes the authenticated session even if a concurrent refresh rotates its bearer', async () => {
    const first = input(),
      next = input()
    await repo.createSession(identity, first)
    const authenticated = (await repo.session(first.tokenHash))!
    expect(await repo.refresh(first.tokenHash, next)).toBe(true)
    await repo.logout(authenticated.id)
    expect(await repo.session(next.tokenHash)).toBeNull()
  })
  it('reflects current organization approval and scope without granting personal issuer role', async () => {
    const value = input()
    await repo.createSession(identity, value)
    const session = (await repo.session(value.tokenHash))!
    const [org] =
      await database.sql`INSERT INTO app_organizations(responsible_user_id,name) VALUES(${session.userId},'Issuer example') RETURNING id`
    await database.sql`INSERT INTO app_organization_applications(organization_id,role,status,reviewed_by,reviewed_at) VALUES(${org!.id},'issuer','approved',${session.userId},statement_timestamp())`
    expect((await repo.session(value.tokenHash))!.account.organizations).toEqual([
      { id: org!.id, name: 'Issuer example', roles: ['issuer'] },
    ])
    await database.sql`UPDATE app_organization_applications SET status='suspended',review_reason='test suspension' WHERE organization_id=${org!.id}`
    expect((await repo.session(value.tokenHash))!.account.organizations).toEqual([])
  })
  it('links a challenge once under concurrency and never reassigns an unlinked wallet', async () => {
    const value = input()
    await repo.createSession(identity, value)
    const session = (await repo.session(value.tokenHash))!
    const challenge = {
      id: randomUUID(),
      sessionId: session.id,
      networkId: 1,
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      message: 'XCS test ownership proof',
      expiresAt: new Date(Date.now() + 300000),
    }
    expect(await repo.saveChallenge(value.tokenHash, challenge)).toBe(true)
    expect(await repo.challenge(value.tokenHash, challenge.id)).toMatchObject(challenge)
    const results = await Promise.all([
      repo.linkWallet(value.tokenHash, challenge.id),
      repo.linkWallet(value.tokenHash, challenge.id),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const linked = (await repo.session(value.tokenHash))!.account.wallets[0]!
    expect(await repo.unlinkWallet(value.tokenHash, linked.id)).toBe(true)
    const other = input()
    await repo.createSession({ ...identity, subject: 'wallet-thief' }, other)
    const otherSession = (await repo.session(other.tokenHash))!
    const next = { ...challenge, id: randomUUID(), sessionId: otherSession.id }
    await repo.saveChallenge(other.tokenHash, next)
    expect(await repo.linkWallet(other.tokenHash, next.id)).toBe(false)
    expect((await repo.session(other.tokenHash))!.account.wallets).toEqual([])
  })
  it('blocks expired challenges and cascades outstanding challenges on logout', async () => {
    const value = input()
    await repo.createSession(identity, value)
    const session = (await repo.session(value.tokenHash))!
    const challenge = {
      id: randomUUID(),
      sessionId: session.id,
      networkId: 1,
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      message: 'XCS test ownership proof',
      expiresAt: new Date(Date.now() + 300000),
    }
    await repo.saveChallenge(value.tokenHash, challenge)
    await database.sql`UPDATE app_wallet_challenges SET created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE id=${challenge.id}`
    expect(await repo.challenge(value.tokenHash, challenge.id)).toBeNull()
    expect(await repo.linkWallet(value.tokenHash, challenge.id)).toBe(false)
    await repo.logout(session.id)
    const rows = await database.sql`SELECT id FROM app_wallet_challenges WHERE id=${challenge.id}`
    expect(rows).toHaveLength(0)
  })
})
