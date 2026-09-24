import { startAdminRuntime } from './helpers/adminRuntime'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, toNodeListener } from 'h3'
import inject from 'light-my-request'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import { requireAuthRole, requireCsrf, SESSION_COOKIE } from '../server/xcs/auth/http'
import type { Session } from '../server/xcs/auth/types'
import { createAdminHandler } from '../server/xcs/admin/http'
import { AdminRepository } from '../server/xcs/admin/repository'
import { PrivateDocuments } from '../server/xcs/admin/documents'
import {
  createLocalSmtpTransport,
  PostgresNotificationRepository,
  processNextNotification,
} from '../server/xcs/admin/notifications'

const url = process.env.XCS_TEST_DATABASE_URL?.trim()
if (process.env.XCS_REQUIRE_POSTGRES_TESTS === '1' && !url)
  throw new Error('XCS_TEST_DATABASE_URL is required')
let operator: DatabaseClient,
  db: DatabaseClient,
  app: DatabaseClient,
  admin: DatabaseClient,
  notifier: DatabaseClient
let auth: PostgresAuthRepository,
  repo: AdminRepository,
  session: Session,
  name: string,
  directory: string
let runtimeUrls: { api: string; auth: string; admin: string }
const origin = 'https://xcs.example',
  adminInput = {
    ...createAppToken(),
    csrfToken: createAppToken().token,
    idleSeconds: 1800,
    absoluteSeconds: 28800,
  }
const subject = randomUUID()
let listener: ReturnType<typeof toNodeListener>
const headers = () => ({
  cookie: `${SESSION_COOKIE}=${adminInput.token}`,
  origin,
  'x-xcs-csrf': adminInput.csrfToken,
  'sec-fetch-site': 'same-origin',
})
async function fixture(verified = true, role = 'verifier') {
  const [user] =
    await db.sql`INSERT INTO app_users(identity_issuer,identity_subject,email,email_verified_at,display_name) VALUES ('https://identity.test',${randomUUID()},'responsible@example.test',${verified ? new Date().toISOString() : null},'Synthetic responsible') RETURNING id`
  const [org] =
    await db.sql`INSERT INTO app_organizations(responsible_user_id,name) VALUES (${user!.id},'Synthetic organization') RETURNING id`
  await db.sql`INSERT INTO app_organization_applications(organization_id,role,description) VALUES (${org!.id},${role},'Synthetic review only')`
  return { id: org!.id as string, userId: user!.id as string, role }
}
const decision = (revision = 0, action = 'approve', reason = '') => ({
  action,
  revision,
  reason,
  idempotencyKey: randomUUID(),
})
const post = (id: string, role: string, payload: unknown) =>
  inject(listener, {
    method: 'POST',
    url: `/api/admin/applications/${id}/${role}/decisions`,
    headers: headers(),
    payload,
  })

describe.skipIf(!url)('admin real PostgreSQL / shared auth / restricted pools', () => {
  beforeAll(async () => {
    operator = createDatabaseClient(url!, { onNotice: () => undefined })
    name = `xcs_admin_web_${randomUUID().replaceAll('-', '')}`
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
      adminApplicationPassword: randomBytes(32).toString('hex'),
      notifierPassword: randomBytes(32).toString('hex'),
    }
    await bootstrapDatabase(db, passwords)
    const connection = (role: string, password: string) => {
      const u = new URL(parsed)
      u.username = role
      u.password = password
      return createDatabaseClient(u.toString(), { onNotice: () => undefined })
    }
    app = connection('xcs_app', passwords.applicationPassword)
    admin = connection('xcs_admin_app', passwords.adminApplicationPassword)
    notifier = connection('xcs_notifier', passwords.notifierPassword)
    const roleUrl = (role: string, password: string) => {
      const u = new URL(parsed)
      u.username = role
      u.password = password
      return u.toString()
    }
    runtimeUrls = {
      api: roleUrl('xcs_api', passwords.apiPassword),
      auth: roleUrl('xcs_app', passwords.applicationPassword),
      admin: roleUrl('xcs_admin_app', passwords.adminApplicationPassword),
    }
    auth = new PostgresAuthRepository(app)
    repo = new AdminRepository(admin)
    await auth.createSession(
      { issuer: 'https://identity.test', subject, emailVerified: false },
      adminInput,
    )
    session = (await auth.session(adminInput.tokenHash))!
    await db.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${session.userId},'admin')`
    session = (await auth.session(adminInput.tokenHash))!
    directory = await mkdtemp(join(tmpdir(), 'xcs-admin-http-'))
    listener = toNodeListener(
      createApp().use(
        createAdminHandler({
          repository: repo,
          documents: new PrivateDocuments(directory, randomBytes(32).toString('hex')),
          authorize: async (event, mutation) => {
            const s = await requireAuthRole(event, auth, 'admin')
            if (mutation) requireCsrf(event, s, origin)
            return s
          },
        }),
      ),
    )
  }, 30000)
  afterAll(async () => {
    await Promise.all([app?.close(), admin?.close(), notifier?.close(), db?.close()])
    if (operator && /^xcs_admin_web_[a-f0-9]{32}$/.test(name))
      await operator.sql`DROP DATABASE ${operator.sql(name)} WITH (FORCE)`
    await operator?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('denies anonymous and non-admin requests and all CSRF variants', async () => {
    for (const path of [
      '/api/admin/applications',
      '/api/admin/verifiers',
      '/api/admin/audit',
      `/api/admin/documents/${randomUUID()}`,
    ])
      expect((await inject(listener, { url: path })).statusCode).toBe(401)
    const token = {
      ...createAppToken(),
      csrfToken: createAppToken().token,
      idleSeconds: 1800,
      absoluteSeconds: 28800,
    }
    await auth.createSession(
      { issuer: 'https://identity.test', subject: randomUUID(), emailVerified: false },
      token,
    )
    expect(
      (
        await inject(listener, {
          url: '/api/admin/applications',
          headers: { cookie: `${SESSION_COOKIE}=${token.token}` },
        })
      ).statusCode,
    ).toBe(403)
    const f = await fixture()
    for (const extra of [
      { origin: 'https://evil.test' },
      { 'x-xcs-csrf': '' },
      { 'sec-fetch-site': 'cross-site' },
    ])
      expect(
        (
          await inject(listener, {
            method: 'POST',
            url: `/api/admin/applications/${f.id}/verifier/decisions`,
            headers: { ...headers(), ...extra },
            payload: decision(),
          })
        ).statusCode,
      ).toBe(403)
    expect(
      (
        await db.sql`SELECT status FROM app_organization_applications WHERE organization_id=${f.id}`
      )[0]!.status,
    ).toBe('pending')
  })
  it('atomically approves once under duplicate requests and rejects key reuse for another body', async () => {
    const f = await fixture(),
      input = decision()
    const results = await Promise.all([post(f.id, f.role, input), post(f.id, f.role, input)])
    expect(results.map((r) => r.statusCode)).toEqual([200, 200])
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true])
    expect(results[0]!.json().decision.id).toBe(results[1]!.json().decision.id)
    expect(
      (await post(f.id, f.role, { ...input, action: 'reject', reason: 'Other' })).statusCode,
    ).toBe(409)
    const [row] =
      await db.sql`SELECT a.revision,(SELECT count(*)::int FROM app_admin_decisions WHERE organization_id=${f.id}) AS decisions,(SELECT count(*)::int FROM app_admin_notifications WHERE decision_id IN(SELECT id FROM app_admin_decisions WHERE organization_id=${f.id})) AS notifications FROM app_organization_applications a WHERE organization_id=${f.id}`
    expect(row).toMatchObject({ revision: 1, decisions: 1, notifications: 1 })
  })
  it('reports the winning decision on a stale concurrent review and supports verifier suspend/restore', async () => {
    const f = await fixture()
    const results = await Promise.all([
      post(f.id, f.role, decision()),
      post(f.id, f.role, decision(0, 'reject', 'Insufficient evidence')),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(results.find((r) => r.statusCode === 409)!.json()).toMatchObject({
      error: 'ADMIN_CONFLICT',
      current: { revision: 1 },
    })
    const approved = await fixture()
    await post(approved.id, approved.role, decision())
    expect((await post(approved.id, approved.role, decision(1, 'suspend', ''))).statusCode).toBe(
      400,
    )
    expect(
      (await post(approved.id, approved.role, decision(1, 'suspend', 'Evidence outdated')))
        .statusCode,
    ).toBe(200)
    expect((await post(approved.id, approved.role, decision(2, 'restore'))).statusCode).toBe(200)
    const issuer = await fixture(true, 'issuer')
    await post(issuer.id, issuer.role, decision())
    expect(
      (await post(issuer.id, issuer.role, decision(1, 'suspend', 'Invalid role'))).statusCode,
    ).toBe(409)
  })
  it('rolls the decision back when insertion into the outbox fails', async () => {
    const f = await fixture()
    await db.sql.unsafe(
      `CREATE FUNCTION test_fail_admin_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER test_admin_failure BEFORE INSERT ON app_admin_notifications FOR EACH ROW EXECUTE FUNCTION test_fail_admin_outbox()`,
    )
    try {
      expect((await post(f.id, f.role, decision())).statusCode).toBe(503)
    } finally {
      await db.sql.unsafe(
        'DROP TRIGGER test_admin_failure ON app_admin_notifications; DROP FUNCTION test_fail_admin_outbox()',
      )
    }
    expect(
      (
        await db.sql`SELECT status,revision FROM app_organization_applications WHERE organization_id=${f.id}`
      )[0],
    ).toMatchObject({ status: 'pending', revision: 0 })
    expect(
      await db.sql`SELECT id FROM app_admin_decisions WHERE organization_id=${f.id}`,
    ).toHaveLength(0)
  })
  it('keeps decisions with blocked unverified email and retries independently', async () => {
    const f = await fixture(false),
      response = await post(f.id, f.role, decision())
    expect(response.statusCode).toBe(200)
    const [notification] =
      await db.sql`SELECT id,status FROM app_admin_notifications WHERE decision_id=${response.json().decision.id}`
    expect(notification!.status).toBe('blocked')
    expect(
      (
        await inject(listener, {
          method: 'POST',
          url: `/api/admin/notifications/${notification!.id}/retry`,
          headers: headers(),
          payload: {},
        })
      ).statusCode,
    ).toBe(409)
    await db.sql`UPDATE app_users SET email_verified_at=statement_timestamp() WHERE id=${f.userId}`
    expect(
      (
        await inject(listener, {
          method: 'POST',
          url: `/api/admin/notifications/${notification!.id}/retry`,
          headers: headers(),
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
    expect(
      await db.sql`SELECT id FROM app_admin_decisions WHERE organization_id=${f.id}`,
    ).toHaveLength(1)
  })
  it('downloads valid private documents only for the issuing current admin session', async () => {
    const f = await fixture(),
      bytes = Buffer.from('%PDF-1.4\nSynthetic proof\n'),
      id = randomUUID()
    await writeFile(join(directory, 'review.pdf'), bytes)
    await db.sql`INSERT INTO app_documents(id,organization_id,application_role,storage_key,mime_type,byte_length,sha256,uploaded_by) VALUES (${id},${f.id},'verifier','review.pdf','application/pdf',${bytes.length},${createHash('sha256').update(bytes).digest('hex')},${f.userId})`
    const link = await inject(listener, {
      method: 'POST',
      url: `/api/admin/documents/${id}/link`,
      headers: headers(),
      payload: {},
    })
    expect(link.statusCode).toBe(200)
    const response = await inject(listener, { url: link.json().url, headers: headers() })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.rawPayload).toEqual(bytes)
    const other = {
      ...createAppToken(),
      csrfToken: createAppToken().token,
      idleSeconds: 1800,
      absoluteSeconds: 28800,
    }
    await auth.createSession(
      { issuer: 'https://identity.test', subject, emailVerified: false },
      other,
    )
    expect(
      (
        await inject(listener, {
          url: link.json().url,
          headers: { cookie: `${SESSION_COOKIE}=${other.token}` },
        })
      ).statusCode,
    ).toBe(403)
    await db.sql`UPDATE app_user_roles SET revoked_at=statement_timestamp() WHERE user_id=${session.userId} AND role='admin'`
    expect((await inject(listener, { url: link.json().url, headers: headers() })).statusCode).toBe(
      403,
    )
    await expect(
      repo.decide(
        session,
        f.id,
        'verifier',
        decision() as Parameters<AdminRepository['decide']>[3],
      ),
    ).rejects.toThrow('ADMIN_ACCESS_REVOKED')
    await db.sql`UPDATE app_user_roles SET revoked_at=NULL WHERE user_id=${session.userId} AND role='admin'`
    await writeFile(join(directory, 'review.pdf'), 'corrupted')
    expect((await inject(listener, { url: link.json().url, headers: headers() })).statusCode).toBe(
      422,
    )
  })
  it('lists metadata without indexer availability or claims and denies private table/audit writes', async () => {
    const response = await inject(listener, {
      url: '/api/admin/applications?page=1',
      headers: headers(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().counts).toHaveProperty('issuer')
    const audit = await inject(listener, { url: '/api/admin/audit', headers: headers() })
    expect(audit.statusCode).toBe(200)
    expect(JSON.stringify(audit.json())).not.toMatch(
      /private_claims|token_hash|identity_subject|storage_key/,
    )
    await expect(admin.sql`SELECT * FROM app_credential_metadata`).rejects.toMatchObject({
      code: '42501',
    })
    await expect(admin.sql`DELETE FROM app_admin_decisions`).rejects.toMatchObject({
      code: '42501',
    })
    await expect(
      notifier.sql`UPDATE app_organization_applications SET status='rejected'`,
    ).rejects.toMatchObject({ code: '42501' })
  })
  it('marks interrupted sending uncertain and never automatically reclaims it', async () => {
    await db.sql`UPDATE app_admin_notifications SET status='blocked' WHERE status='pending'`
    const f = await fixture(),
      r = await post(f.id, f.role, decision())
    await db.sql`UPDATE app_admin_notifications SET status='sending',attempt_id=${randomUUID()},claimed_at=statement_timestamp()-interval '10 minutes' WHERE decision_id=${r.json().decision.id}`
    const worker = new PostgresNotificationRepository(notifier)
    await worker.recoverStale()
    expect(
      (
        await db.sql`SELECT status FROM app_admin_notifications WHERE decision_id=${r.json().decision.id}`
      )[0]!.status,
    ).toBe('uncertain')
    expect(await worker.claim()).toEqual({ kind: 'idle' })
  })
  it.skipIf(!process.env.XCS_TEST_MAILPIT_URL)(
    'delivers to Mailpit, recovers a definite SMTP failure without a new decision',
    async () => {
      const f = await fixture(),
        r = await post(f.id, f.role, decision())
      const worker = new PostgresNotificationRepository(notifier)
      const down = createLocalSmtpTransport({ XCS_SMTP_HOST: '127.0.0.1', XCS_SMTP_PORT: '1' })
      expect(await processNextNotification(worker, down)).toBe('failed')
      down.close()
      const [notification] =
        await db.sql`SELECT id,status FROM app_admin_notifications WHERE decision_id=${r.json().decision.id}`
      expect(notification!.status).toBe('failed')
      await repo.retryNotification(notification!.id)
      const smtp = createLocalSmtpTransport({
        XCS_SMTP_HOST: '127.0.0.1',
        XCS_SMTP_PORT: process.env.XCS_TEST_SMTP_PORT!,
      })
      expect(await processNextNotification(worker, smtp)).toBe('sent')
      smtp.close()
      expect(
        await db.sql`SELECT id FROM app_admin_decisions WHERE organization_id=${f.id}`,
      ).toHaveLength(1)
      const messages = (await fetch(`${process.env.XCS_TEST_MAILPIT_URL}/api/v1/messages`).then(
        (r) => r.json(),
      )) as { messages: { ID: string }[] }
      let found = false
      for (const message of messages.messages) {
        const detail = (await fetch(
          `${process.env.XCS_TEST_MAILPIT_URL}/api/v1/message/${message.ID}`,
        ).then((r) => r.json())) as { Text: string }
        if (detail.Text.includes(r.json().decision.id)) found = true
      }
      expect(found).toBe(true)
    },
  )
  it.skipIf(process.env.XCS_ADMIN_RUNTIME_TEST !== '1')(
    'serves four real authenticated screens and persists a browser decision over HTTPS',
    async () => {
      const f = await fixture()
      await db.sql`UPDATE app_organizations SET name='Runtime browser organization' WHERE id=${f.id}`
      const runtime = await startAdminRuntime(directory, runtimeUrls)
      try {
        await runtime.context.addCookies([
          {
            name: SESSION_COOKIE,
            value: adminInput.token,
            url: runtime.origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ])
        const page = await runtime.context.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(runtime.origin + '/admin')
        await page.getByRole('heading', { name: 'Applications', exact: true }).waitFor()
        await page.goto(`${runtime.origin}/admin/applications/${f.id}/verifier`)
        await page
          .getByRole('heading', { name: 'Runtime browser organization', exact: true })
          .waitFor()
        // SSR headings can appear before Vue has attached the decision button handler.
        await page.locator('[data-client-ready="true"]').waitFor()
        await page.getByRole('button', { name: 'Approve access', exact: true }).click()
        await page.getByTestId('admin-confirm-decision').click()
        await page.waitForURL(/\/admin\?/)
        expect(
          (
            await db.sql`SELECT status FROM app_organization_applications WHERE organization_id=${f.id}`
          )[0]!.status,
        ).toBe('approved')
        await page.goto(runtime.origin + '/admin/verifiers')
        await page
          .getByRole('link', { name: 'Review Runtime browser organization', exact: true })
          .waitFor()
        await page.goto(runtime.origin + '/admin/audit')
        await page
          .getByRole('heading', { name: 'Runtime browser organization', exact: true })
          .waitFor()
        await page.goto(runtime.origin + '/fr/admin')
        await page.getByRole('heading', { name: 'Candidatures', exact: true }).waitFor()
        expect(errors).toEqual([])
        await db.sql`UPDATE app_user_roles SET revoked_at=statement_timestamp() WHERE user_id=${session.userId} AND role='admin'`
        await page.goto(`${runtime.origin}/admin/applications/${f.id}/verifier`)
        await page.waitForURL(/\/auth\/not-authorized$/)
      } finally {
        await runtime.close()
        await db.sql`UPDATE app_user_roles SET revoked_at=NULL WHERE user_id=${session.userId} AND role='admin'`
      }
    },
    60000,
  )
})
