import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import type { Session } from '../server/xcs/auth/types'
import { IssuerRepository } from '../server/xcs/issuer/repository'
import type { ResolvedPresentation } from '../server/xcs/recipient/types'
import { VerifierRepository } from '../server/xcs/verifier/repository'
import { historyCsv } from '../server/xcs/verifier/csv'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')
let operator: DatabaseClient, owner: DatabaseClient, issuer: DatabaseClient, app: DatabaseClient
let repository: VerifierRepository, session: Session, outsider: Session, recipient: Session
let name: string, organizationId: string, outsiderOrganizationId: string
const presentationId = randomUUID(),
  publicPresentationId = randomUUID()
const profileId = '=HYPERLINK("https://example.test")',
  generationId = 'a'.repeat(64),
  schemaUid = 'b'.repeat(64)
const documents = {
  write: vi.fn(async () => ({
    storageKey: randomUUID() + '.pdf',
    mimeType: 'application/pdf',
    byteLength: 5,
    sha256: 'a'.repeat(64),
  })),
  remove: vi.fn(async () => {}),
  release: vi.fn(),
}
const application = {
  name: 'Verifier',
  website: 'https://example.test',
  contact: 'Test',
  jurisdiction: 'FR',
  description: 'Test',
  purpose: 'Test',
  documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
}

function resolved(scope: 'public' | 'full' = 'full'): ResolvedPresentation {
  return {
    presentation: {
      id: scope === 'full' ? presentationId : publicPresentationId,
      profileId,
      generationId,
      scope,
      verifierOrganizationId: scope === 'full' ? organizationId : null,
      verifierOrganizationName: null,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    },
    credential: { profileId, generationId },
    scope,
    claims: { secret: 'NEVER_STORE_PRIVATE_CLAIMS' },
    verification: { onChain: 'active', schema: 'valid', payload: 'valid', issuerTrust: 'unknown' },
    issuerAdmission: {
      status: 'approved',
      organizationId,
      checkedAt: new Date().toISOString(),
      reviewedAt: null,
    },
    holderProof: { status: 'not_provided' },
    requiresAuthorization: false,
  } as ResolvedPresentation
}

describe.skipIf(!url)('verifier history with actual restricted PostgreSQL role', () => {
  beforeAll(async () => {
    operator = createDatabaseClient(url!, { onNotice: () => undefined })
    name = 'xcs_verifier_test_' + randomUUID().replaceAll('-', '')
    await operator.sql`CREATE DATABASE ${operator.sql(name)} TEMPLATE template0`
    const parsed = new URL(url!)
    parsed.pathname = '/' + name
    owner = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const credentials = {
      clusterScope: 'dedicated' as const,
      administratorPassword: databasePasswordFromUrl(url!),
      indexerPassword: randomBytes(32).toString('hex'),
      apiPassword: randomBytes(32).toString('hex'),
      payloadWriterPassword: randomBytes(32).toString('hex'),
      monitorPassword: randomBytes(32).toString('hex'),
      applicationPassword: randomBytes(32).toString('hex'),
      issuerPassword: randomBytes(32).toString('hex'),
    }
    await bootstrapDatabase(owner, credentials)
    parsed.username = 'xcs_app'
    parsed.password = credentials.applicationPassword
    app = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    parsed.username = 'xcs_issuer'
    parsed.password = credentials.issuerPassword
    issuer = createDatabaseClient(parsed.toString(), { onNotice: () => undefined })
    const auth = new PostgresAuthRepository(app)
    const sessions: Session[] = []
    for (const subject of ['verifier', 'outsider', 'recipient']) {
      const token = {
        ...createAppToken(),
        csrfToken: createAppToken().token,
        idleSeconds: 1800,
        absoluteSeconds: 28800,
      }
      await auth.createSession(
        {
          issuer: 'https://identity.test',
          subject,
          emailVerified: true,
          email: subject + '@example.test',
        },
        token,
      )
      sessions.push((await auth.session(token.tokenHash))!)
    }
    ;[session, outsider, recipient] = sessions as [Session, Session, Session]
    const applications = new IssuerRepository(issuer, {
      documents,
      origin: 'https://example.test',
      inviteDays: 7,
      notify: async () => ({ status: 'sent', errorCode: null }),
    })
    repository = new VerifierRepository(issuer, applications)
    organizationId = (await repository.apply(session, application)).organizationId
    outsiderOrganizationId = (await repository.apply(outsider, application)).organizationId
    await owner.sql`INSERT INTO app_schema_metadata(profile_id,schema_uid,organization_id,registration_transaction_hash) VALUES (${profileId},${schemaUid},${organizationId},${'c'.repeat(64)})`
    await owner.sql`INSERT INTO app_credential_metadata(profile_id,generation_id,schema_uid,issuer_organization_id,recipient_user_id,issuer_address,subject_address,visibility,payload_digest,creation_transaction_hash,creation_ledger_index)
      VALUES (${profileId},${generationId},${schemaUid},${organizationId},${recipient.userId},'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh','rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh','private',${'d'.repeat(64)},${'e'.repeat(64)},1)`
    await owner.sql`INSERT INTO app_presentations(id,profile_id,generation_id,recipient_user_id,verifier_organization_id,scope,token_hash)
      VALUES (${presentationId},${profileId},${generationId},${recipient.userId},${organizationId},'full',${createAppToken().tokenHash}),
      (${publicPresentationId},${profileId},${generationId},${recipient.userId},NULL,'public',${createAppToken().tokenHash})`
  }, 30000)
  afterAll(async () => {
    await Promise.all([issuer?.close(), app?.close(), owner?.close()])
    if (operator && /^xcs_verifier_test_[a-f0-9]{32}$/.test(name))
      await operator.sql`DROP DATABASE ${operator.sql(name)} WITH (FORCE)`
    await operator?.close()
  })

  it('creates verifier applications and private documents without granting approval', async () => {
    const workspace = await repository.workspace(session)
    expect(workspace.organizations).toHaveLength(1)
    expect(workspace.organizations[0]?.applicationStatus).toBe('pending')
    expect(workspace.history).toEqual([])
    const [document] =
      await owner.sql`SELECT application_role FROM app_documents WHERE organization_id=${organizationId}`
    expect(document!.application_role).toBe('verifier')
    await expect(repository.history(session)).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      issuer.sql`UPDATE app_organization_applications SET status='approved' WHERE organization_id=${organizationId}`,
    ).rejects.toMatchObject({ code: '42501' })
    await repository.record(issuer.db, session, resolved('public'))
    expect(await owner.sql`SELECT id FROM app_verifier_history`).toHaveLength(0)
    await owner.sql`UPDATE app_organization_applications SET status='approved',reviewed_by=${session.userId},reviewed_at=statement_timestamp(),revision=revision+1 WHERE organization_id IN (${organizationId},${outsiderOrganizationId})`
  })
  it('records four evidence dimensions without retaining private claims, tokens or email', async () => {
    await repository.record(issuer.db, session, resolved())
    const history = await repository.history(session)
    expect(history).toHaveLength(1)
    expect(history[0]?.verification).toEqual(resolved().verification)
    const serialized = JSON.stringify(await owner.sql`SELECT * FROM app_verifier_history`)
    expect(serialized).not.toContain('NEVER_STORE_PRIVATE_CLAIMS')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('email')
    expect(historyCsv(history)).toContain('"\'=HYPERLINK(""https://example.test"")"')
    await expect(
      issuer.sql`UPDATE app_verifier_history SET issuer_trust='trusted'`,
    ).rejects.toMatchObject({ code: '42501' })
  })
  it('isolates history and refuses full-audience bypass even with another approved verifier', async () => {
    await repository.record(issuer.db, outsider, resolved())
    expect(await repository.history(outsider)).toEqual([])
    await expect(repository.workspace(outsider, organizationId)).rejects.toMatchObject({
      statusCode: 404,
    })
    const [entry] = await repository.history(session)
    const resolve = vi.fn(async () => resolved())
    await expect(repository.reopen(outsider, entry!.id, resolve)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(resolve).not.toHaveBeenCalled()
    await repository.reopen(session, entry!.id, resolve)
    expect(resolve).toHaveBeenCalledWith(session, presentationId)
  })
  it('does not record denied full access and allows approved public verification', async () => {
    await repository.record(issuer.db, outsider, {
      ...resolved(),
      scope: 'public',
      requiresAuthorization: true,
    })
    expect(await repository.history(outsider)).toEqual([])
    await repository.record(issuer.db, outsider, resolved('public'))
    expect(await repository.history(outsider)).toHaveLength(1)
  })
  it('checks current approval and active organization before history or CSV access', async () => {
    await owner.sql`UPDATE app_organization_applications SET status='suspended',review_reason='Paused' WHERE organization_id=${organizationId}`
    expect((await repository.workspace(session)).history).toEqual([])
    await expect(repository.history(session)).rejects.toMatchObject({ statusCode: 403 })
    const before = await owner.sql`SELECT count(*)::int AS count FROM app_verifier_history`
    await repository.record(issuer.db, session, resolved())
    expect(await owner.sql`SELECT count(*)::int AS count FROM app_verifier_history`).toEqual(before)
    await owner.sql`UPDATE app_organization_applications SET status='approved',review_reason=NULL WHERE organization_id=${organizationId}`
    await owner.sql`UPDATE app_organizations SET status='suspended' WHERE id=${organizationId}`
    await expect(repository.history(session)).rejects.toMatchObject({ statusCode: 403 })
    await owner.sql`UPDATE app_organizations SET status='active' WHERE id=${organizationId}`
  })
  it('does not copy the previous responsible user history after organization transfer', async () => {
    await owner.sql`UPDATE app_organizations SET responsible_user_id=${outsider.userId} WHERE id=${organizationId}`
    expect(await repository.history(outsider, organizationId)).toEqual([])
    await expect(repository.history(session, organizationId)).rejects.toMatchObject({
      statusCode: 403,
    })
    await owner.sql`UPDATE app_organizations SET responsible_user_id=${session.userId} WHERE id=${organizationId}`
  })
  it('refuses revoked sessions and presentations at recording and access time', async () => {
    await owner.sql`UPDATE app_presentations SET revoked_at=statement_timestamp() WHERE id=${presentationId}`
    const before = await repository.history(session)
    await repository.record(issuer.db, session, resolved())
    expect(await repository.history(session)).toEqual(before)
    await owner.sql`DELETE FROM app_sessions WHERE id=${session.id}`
    await expect(repository.workspace(session)).rejects.toMatchObject({ statusCode: 401 })
    await expect(repository.reopen(session, before[0]!.id, vi.fn())).rejects.toMatchObject({
      statusCode: 401,
    })
    await repository.record(issuer.db, session, resolved('public'))
    expect(
      await owner.sql`SELECT id FROM app_verifier_history WHERE verifier_user_id=${session.userId}`,
    ).toHaveLength(before.length)
  })
})
