import { randomBytes, randomUUID } from 'node:crypto'
import { createApp, toNodeListener } from 'h3'
import inject from 'light-my-request'
import { Wallet } from 'xrpl'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { canonicalJson, encodeHexUtf8 } from '#xcs/core/index.js'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { IssuerRepository } from '../server/xcs/issuer/repository'
import { createIssuerHandler } from '../server/xcs/issuer/http'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import {
  requireAuthSession,
  readAuthSession,
  requireCsrf,
  SESSION_COOKIE,
} from '../server/xcs/auth/http'
import type { Session } from '../server/xcs/auth/types'
import type { IssuerNotification } from '../server/xcs/issuer/notifications'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')
let operator: DatabaseClient,
  db: DatabaseClient,
  issuer: DatabaseClient,
  app: DatabaseClient,
  name: string
let repo: IssuerRepository,
  auth: PostgresAuthRepository,
  session: Session,
  recipient: Session,
  outsider: Session
let listener: ReturnType<typeof toNodeListener>,
  organizationId: string,
  inviteId: string,
  payloadId: string,
  canonical: string
const origin = 'https://xcs.test',
  profileId = 'issuer-testnet',
  schemaUid = 'a'.repeat(64),
  schemaTx = 'b'.repeat(64),
  generation = 'c'.repeat(64),
  ledgerHash = 'd'.repeat(64)
const publisher = Wallet.generate().address,
  subject = Wallet.generate().address
const messages: IssuerNotification[] = []
const token = {
  ...createAppToken(),
  csrfToken: createAppToken().token,
  idleSeconds: 1800,
  absoluteSeconds: 28800,
}
const documents = {
  write: vi.fn(async () => ({
    storageKey: randomUUID() + '.pdf',
    mimeType: 'application/pdf',
    byteLength: 5,
    sha256: 'f'.repeat(64),
  })),
  remove: vi.fn(async () => {}),
  release: vi.fn(),
}
const definition = {
  xcsVersion: '0.1',
  name: 'Synthetic',
  description: 'Test',
  fields: { course: { type: 'string' }, secret: { type: 'string' } },
}
const headers = () => ({
  cookie: `${SESSION_COOKIE}=${token.token}`,
  origin,
  'x-xcs-csrf': token.csrfToken,
})
async function approve(id: string) {
  await db.sql`UPDATE app_organization_applications SET status='approved',reviewed_by=${session.userId},reviewed_at=statement_timestamp(),revision=revision+1 WHERE organization_id=${id}`
}

describe.skipIf(!url)('issuer actual PostgreSQL restricted role and authentication', () => {
  beforeAll(async () => {
    operator = createDatabaseClient(url!, { onNotice: () => undefined })
    name = 'xcs_issuer_test_' + randomUUID().replaceAll('-', '')
    await operator.sql`CREATE DATABASE ${operator.sql(name)} TEMPLATE template0`
    const parsed = new URL(url!)
    parsed.pathname = '/' + name
    db = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const passwords = {
      clusterScope: 'dedicated' as const,
      administratorPassword: databasePasswordFromUrl(url!),
      indexerPassword: randomBytes(32).toString('hex'),
      apiPassword: randomBytes(32).toString('hex'),
      payloadWriterPassword: randomBytes(32).toString('hex'),
      monitorPassword: randomBytes(32).toString('hex'),
      applicationPassword: randomBytes(32).toString('hex'),
      issuerPassword: randomBytes(32).toString('hex'),
    }
    await bootstrapDatabase(db, passwords)
    parsed.username = 'xcs_app'
    parsed.password = passwords.applicationPassword
    app = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    parsed.username = 'xcs_issuer'
    parsed.password = passwords.issuerPassword
    issuer = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    auth = new PostgresAuthRepository(app)
    await auth.createSession(
      {
        issuer: 'https://identity.test',
        subject: 'issuer',
        emailVerified: true,
        email: 'issuer@example.test',
      },
      token,
    )
    session = (await auth.session(token.tokenHash))!
    for (const who of ['recipient', 'outsider']) {
      const credential = {
        ...createAppToken(),
        csrfToken: createAppToken().token,
        idleSeconds: 1800,
        absoluteSeconds: 28800,
      }
      await auth.createSession(
        {
          issuer: 'https://identity.test',
          subject: who,
          emailVerified: true,
          email: `${who}@example.test`,
        },
        credential,
      )
      if (who === 'recipient') recipient = (await auth.session(credential.tokenHash))!
      else outsider = (await auth.session(credential.tokenHash))!
    }
    repo = new IssuerRepository(issuer, {
      origin,
      inviteDays: 7,
      documents,
      notify: async (message) => {
        messages.push(message)
        return { status: 'sent', errorCode: null }
      },
    })
    listener = toNodeListener(
      createApp().use(
        createIssuerHandler({
          repository: repo,
          authorize: async (event, mutation) => {
            const session = await requireAuthSession(event, auth)
            if (mutation) requireCsrf(event, session, origin)
            return session
          },
          readSession: (event) => readAuthSession(event, auth),
        }),
      ),
    )
    await db.sql`INSERT INTO network_profiles(profile_id,xcs_version,network_id,required_amendment,registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash) VALUES (${profileId},'0.1',1,${ledgerHash},${publisher},1,1,${ledgerHash})`
    await db.sql`INSERT INTO schema_events(profile_id,transaction_hash,ledger_index,ledger_hash,transaction_index,publisher,status,schema_uid,memo_json) VALUES (${profileId},${schemaTx},1,${ledgerHash},0,${publisher},'accepted',${schemaUid},${JSON.stringify(definition)}::jsonb)`
    await db.sql`INSERT INTO schemas(profile_id,schema_uid,publisher,name,description,definition,resolved_definition,registration_transaction_hash,ledger_index,transaction_index) VALUES (${profileId},${schemaUid},${publisher},'Synthetic','Test',${JSON.stringify(definition)}::jsonb,${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,${schemaTx},1,0)`
    await db.sql`INSERT INTO app_wallets(user_id,network_id,address,verified_at) VALUES (${session.userId},1,${publisher},now()),(${recipient.userId},1,${subject},now())`
  }, 30000)
  afterAll(async () => {
    await Promise.all([issuer?.close(), app?.close(), db?.close()])
    if (operator && /^xcs_issuer_test_[a-f0-9]{32}$/.test(name))
      await operator.sql`DROP DATABASE ${operator.sql(name)} WITH (FORCE)`
    await operator?.close()
  })
  it('rejects unsigned and cross-origin mutations and arbitrary document fields', async () => {
    expect(
      (await inject(listener, { method: 'GET', url: '/api/issuer/workspace' })).statusCode,
    ).toBe(401)
    expect(
      (
        await inject(listener, {
          method: 'POST',
          url: '/api/issuer/applications',
          payload: {},
          headers: { ...headers(), origin: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await inject(listener, {
          method: 'POST',
          url: '/api/issuer/applications',
          payload: { admin: true },
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400)
  })
  it('creates pending organization with private documents and refuses self-approval', async () => {
    const response = await inject(listener, {
      method: 'POST',
      url: '/api/issuer/applications',
      headers: headers(),
      payload: {
        name: 'Synthetic issuer',
        website: 'https://issuer.test',
        contact: 'Responsible',
        jurisdiction: 'France',
        description: 'Synthetic only',
        purpose: 'Test',
        documents: [
          { mimeType: 'application/pdf', base64: Buffer.from('%PDF-').toString('base64') },
        ],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    organizationId = response.json().organizationId
    expect((await repo.workspace(session)).organizations[0]?.applicationStatus).toBe('pending')
    await expect(
      repo.registerSchema(session, {
        organizationId,
        profileId,
        transactionHash: schemaTx,
        displayName: 'Course',
        category: '',
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      issuer.sql`UPDATE app_organization_applications SET status='approved' WHERE organization_id=${organizationId}`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      issuer.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${session.userId},'admin')`,
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      issuer.sql`UPDATE schemas SET name='fake' WHERE profile_id=${profileId}`,
    ).rejects.toMatchObject({ code: '42501' })
    await approve(organizationId)
  })
  it('accepts only indexed registration belonging to a linked publisher and forbids metadata takeover', async () => {
    await expect(
      repo.registerSchema(session, {
        organizationId,
        profileId,
        transactionHash: 'e'.repeat(64),
        displayName: '',
        category: '',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      repo.registerSchema(outsider, {
        organizationId,
        profileId,
        transactionHash: schemaTx,
        displayName: '',
        category: '',
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    const registered = await repo.registerSchema(session, {
      organizationId,
      profileId,
      transactionHash: schemaTx,
      displayName: 'Course',
      category: '',
    })
    expect(registered.schemaUid).toBe(schemaUid)
    await db.sql`UPDATE app_wallets SET revoked_at=now() WHERE user_id=${session.userId}`
    await expect(
      repo.registerSchema(session, {
        organizationId,
        profileId,
        transactionHash: schemaTx,
        displayName: '',
        category: '',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
    await db.sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${session.userId}`
    const second = await repo.apply(session, {
      name: 'Second organization',
      website: 'https://second.test',
      contact: 'Responsible',
      jurisdiction: 'France',
      description: 'Other',
      purpose: 'Test',
      documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
    })
    await approve(second.organizationId)
    await expect(
      repo.registerSchema(session, {
        organizationId: second.organizationId,
        profileId,
        transactionHash: schemaTx,
        displayName: '',
        category: '',
      }),
    ).rejects.toMatchObject({ code: 'ISSUER_SCHEMA_OWNED' })
  })
  it('rotates a secret on resend, persists hashes only and claims atomically for the logged-in account', async () => {
    const invite = await repo.invite(session, {
      organizationId,
      profileId,
      schemaUid,
      email: 'different-address@example.test',
      message: 'Welcome',
    })
    inviteId = invite.id
    const first = new URL(messages.at(-1)!.claimUrl!).hash.slice(1)
    const [row] = await db.sql`SELECT token_hash FROM app_invites WHERE id=${inviteId}`
    expect(row!.token_hash).not.toBe(first)
    expect(JSON.stringify(await repo.workspace(session))).not.toContain(first)
    await repo.changeInvite(session, inviteId, 'resend')
    const second = new URL(messages.at(-1)!.claimUrl!).hash.slice(1)
    expect(second).not.toBe(first)
    await expect(repo.invitation(recipient, first, true)).rejects.toMatchObject({ statusCode: 404 })
    expect((await repo.invitation(recipient, second, false)).claimed).toBe(false)
    const claimed = await Promise.allSettled([
      repo.invitation(recipient, second, true),
      repo.invitation(outsider, second, true),
    ])
    expect(claimed.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const [winner] = await db.sql`SELECT claimed_by FROM app_invites WHERE id=${inviteId}`
    // Keep later tests deterministic while still asserting the two-account race above.
    await db.sql`UPDATE app_invites SET claimed_by=${recipient.userId} WHERE id=${inviteId}`
    expect([recipient.userId, outsider.userId]).toContain(winner!.claimed_by)
    await expect(repo.changeInvite(session, inviteId, 'revoke')).rejects.toMatchObject({
      statusCode: 409,
    })
  })
  it('prepares exact private bytes without public publication, validates schema and linked subject', async () => {
    canonical = canonicalJson({
      xcsVersion: '0.1',
      issuer: publisher,
      subject,
      schema: schemaUid,
      claims: { course: 'Public course', secret: 'PRIVATE SYNTHETIC' },
    })
    const input = {
      inviteId,
      canonicalPayload: canonical,
      subjectAddress: subject,
      visibility: 'private' as const,
      publicFields: ['/course'],
    }
    await expect(
      repo.preparePayload(session, { ...input, canonicalPayload: canonical + ' ' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      repo.preparePayload(session, { ...input, subjectAddress: publisher }),
    ).rejects.toMatchObject({ statusCode: 409 })
    const draft = await repo.preparePayload(session, input)
    payloadId = draft.payloadId
    expect(Buffer.byteLength(draft.credentialUri)).toBeLessThanOrEqual(128)
    expect((await repo.payload(session, payloadId)).content).toBe(canonical)
    await expect(repo.payload(null, payloadId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(repo.payload(outsider, payloadId)).rejects.toMatchObject({ statusCode: 404 })
    expect((await db.sql`SELECT count(*)::int AS count FROM hosted_payloads`)[0]!.count).toBe(0)
    const uriHex = encodeHexUtf8(draft.credentialUri)
    await db.sql`INSERT INTO credential_generations(profile_id,generation_id,ledger_object_id,issuer,subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index) VALUES (${profileId},${generation},${'e'.repeat(64)},${publisher},${subject},${schemaUid},${uriHex},false,2,0,2)`
    await db.sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,uri_hex,accepted,snapshot) VALUES (${profileId},${generation},0,${generation},${'e'.repeat(64)},2,${ledgerHash},0,'created',${publisher},${subject},${schemaUid},${uriHex},false,'{}')`
  })
  it('rejects expired or revoked invitation tokens, including preview, without identifying the recipient', async () => {
    const expired = await repo.invite(session, {
      organizationId,
      profileId,
      schemaUid,
      email: 'expires@example.test',
      message: '',
    })
    const expiredToken = new URL(messages.at(-1)!.claimUrl!).hash.slice(1)
    await db.sql`UPDATE app_invites SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=${expired.id}`
    await expect(repo.invitation(recipient, expiredToken, true)).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(repo.invitation(recipient, expiredToken, false)).rejects.toMatchObject({
      statusCode: 404,
    })
    const revoked = await repo.invite(session, {
      organizationId,
      profileId,
      schemaUid,
      email: 'revoked@example.test',
      message: '',
    })
    const revokedToken = new URL(messages.at(-1)!.claimUrl!).hash.slice(1)
    await repo.changeInvite(session, revoked.id, 'revoke')
    await expect(repo.invitation(recipient, revokedToken, true)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(
      (
        await inject(listener, {
          method: 'POST',
          url: '/api/issuer/invitations/preview',
          payload: { token: revokedToken },
        })
      ).statusCode,
    ).toBe(401)
  })
  it('bounds drafts and rechecks both wallets, account activity and committed bytes at the final recording boundary', async () => {
    const draftInput = {
      inviteId,
      canonicalPayload: canonical,
      subjectAddress: subject,
      visibility: 'private' as const,
      publicFields: ['/course'],
    }
    const recordInput = {
      inviteId,
      transactionHash: generation,
      payloadId,
      visibility: 'private' as const,
      publicFields: ['/course'],
    }
    await db.sql`UPDATE app_wallets SET revoked_at=now() WHERE user_id=${session.userId}`
    await expect(repo.preparePayload(session, draftInput)).rejects.toMatchObject({
      code: 'ISSUER_PAYLOAD_INVALID',
    })
    await expect(repo.recordCredential(session, recordInput)).rejects.toMatchObject({
      code: 'ISSUER_CREDENTIAL_MISMATCH',
    })
    await db.sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${session.userId}`
    await db.sql`UPDATE app_wallets SET revoked_at=now() WHERE user_id=${recipient.userId}`
    await expect(repo.preparePayload(session, draftInput)).rejects.toMatchObject({
      code: 'ISSUER_SUBJECT_WALLET_REQUIRED',
    })
    await expect(repo.recordCredential(session, recordInput)).rejects.toMatchObject({
      code: 'ISSUER_CREDENTIAL_MISMATCH',
    })
    await db.sql`UPDATE app_wallets SET revoked_at=NULL WHERE user_id=${recipient.userId}`
    await db.sql`UPDATE app_users SET status='suspended' WHERE id=${session.userId}`
    await expect(repo.preparePayload(session, draftInput)).rejects.toMatchObject({
      statusCode: 401,
    })
    await db.sql`UPDATE app_users SET status='active' WHERE id=${session.userId}`
    await expect(
      repo.recordCredential(session, { ...recordInput, publicFields: ['/secret'] }),
    ).rejects.toMatchObject({ code: 'ISSUER_PAYLOAD_MISMATCH' })
    const [row] =
      await db.sql`SELECT uri_hex FROM credential_events WHERE transaction_hash=${generation}`
    await db.sql`UPDATE credential_events SET uri_hex=${encodeHexUtf8('https://other.test/#xcs-sha256=' + 'a'.repeat(64))} WHERE transaction_hash=${generation}`
    await expect(repo.recordCredential(session, recordInput)).rejects.toMatchObject({
      code: 'ISSUER_CREDENTIAL_MISMATCH',
    })
    await db.sql`UPDATE credential_events SET uri_hex=${row!.uri_hex} WHERE transaction_hash=${generation}`
    await db.sql`INSERT INTO app_issuer_payloads(id,locator,invite_id,created_by,subject_address,canonical_payload,payload_digest,credential_uri,visibility,public_fields)
      SELECT gen_random_uuid(),left(replace(gen_random_uuid()::text,'-',''),18),invite_id,created_by,subject_address,canonical_payload,payload_digest,credential_uri,visibility,public_fields
      FROM app_issuer_payloads CROSS JOIN generate_series(1,19) WHERE id=${payloadId}`
    await expect(repo.preparePayload(session, draftInput)).rejects.toMatchObject({
      code: 'ISSUER_DRAFT_LIMIT',
    })
    await db.sql`DELETE FROM app_issuer_payloads WHERE invite_id=${inviteId} AND id<>${payloadId}`
  })
  it('records only the exact indexed generation and sends once to verified claimant, never original delivery email', async () => {
    const input = {
      inviteId,
      transactionHash: generation,
      payloadId,
      visibility: 'private' as const,
      publicFields: ['/course'],
    }
    await expect(
      repo.recordCredential(session, { ...input, transactionHash: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ statusCode: 409 })
    await expect(
      repo.recordCredential(session, { ...input, visibility: 'public' }),
    ).rejects.toMatchObject({ statusCode: 409 })
    const [record] = await Promise.all([
      repo.recordCredential(session, input),
      repo.recordCredential(session, input),
    ])
    expect(record.generationId).toBe(generation)
    await repo.recordCredential(session, input)
    expect(messages.filter((message) => message.kind === 'issued')).toHaveLength(1)
    expect(messages.find((message) => message.kind === 'issued')!.recipientEmail).toBe(
      'recipient@example.test',
    )
    expect((await repo.issuance(session, inviteId)).recipient.id).toBe(recipient.userId)
    expect((await repo.issuance(session, inviteId)).existingCredential).toEqual({
      profileId,
      generationId: generation,
    })
    await expect(
      repo.preparePayload(session, {
        inviteId,
        canonicalPayload: canonical,
        subjectAddress: subject,
        visibility: 'private',
        publicFields: ['/course'],
      }),
    ).rejects.toMatchObject({ code: 'ISSUER_INVITE_ALREADY_ISSUED' })
  })
  it('delivers canonical full owner/recipient payloads and only selected claims anonymously or to other accounts', async () => {
    expect((await repo.payload(session, payloadId)).content).toBe(canonical)
    expect((await repo.payload(recipient, payloadId)).content).toBe(canonical)
    for (const viewer of [null, outsider])
      expect(JSON.parse((await repo.payload(viewer, payloadId)).content)).toEqual({
        claims: { course: 'Public course' },
      })
    await db.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${outsider.userId},'admin')`
    expect(JSON.parse((await repo.payload(outsider, payloadId)).content)).toEqual({
      claims: { course: 'Public course' },
    })
    await expect(app.sql`SELECT canonical_payload FROM app_issuer_payloads`).rejects.toMatchObject({
      code: '42501',
    })
    const [locator] = await db.sql`SELECT locator FROM app_issuer_payloads WHERE id=${payloadId}`
    const alias = await inject(listener, { method: 'GET', url: '/q/' + locator!.locator })
    expect(alias.json()).toEqual({ claims: { course: 'Public course' } })
    const response = await inject(listener, {
      method: 'GET',
      url: '/api/issuer/payloads/' + payloadId,
    })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.body).not.toContain('PRIVATE SYNTHETIC')
    expect(response.headers['x-xcs-claim-scope']).toBe('public')
    expect(JSON.stringify(await repo.workspace(session))).not.toContain('PRIVATE SYNTHETIC')
  })
  it('records verified revocation notification once, and stale approvals/sessions prevent further writes', async () => {
    const revokeTx = 'f'.repeat(64)
    await expect(
      repo.refreshCredential(session, profileId, generation, revokeTx),
    ).rejects.toMatchObject({ statusCode: 409 })
    await db.sql`UPDATE credential_generations SET deleted_ledger_index=3,last_ledger_index=3,deletion_cause='issuer_revoked' WHERE generation_id=${generation}`
    await db.sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,accepted,deletion_cause,snapshot) VALUES (${profileId},${revokeTx},0,${generation},${'e'.repeat(64)},3,${ledgerHash},0,'deleted',${publisher},${subject},${schemaUid},false,'issuer_revoked','{}')`
    await repo.refreshCredential(session, profileId, generation, revokeTx)
    await repo.refreshCredential(session, profileId, generation, revokeTx)
    expect(messages.filter((message) => message.kind === 'revoked')).toHaveLength(1)
    await db.sql`UPDATE app_organizations SET status='suspended' WHERE id=${organizationId}`
    await expect(repo.issuance(session, inviteId)).rejects.toMatchObject({ statusCode: 403 })
    await db.sql`UPDATE app_organizations SET status='active' WHERE id=${organizationId}`
    await auth.logout(session.id)
    await expect(
      repo.registerSchema(session, {
        organizationId,
        profileId,
        transactionHash: schemaTx,
        displayName: '',
        category: '',
      }),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})
