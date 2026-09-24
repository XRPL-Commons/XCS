import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet } from 'xrpl'
import en from '../i18n/locales/en.json'
import { expect as browserExpect, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { canonicalJson, encodeHexUtf8 } from '#xcs/core/index.js'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import { SESSION_COOKIE } from '../server/xcs/auth/http'
import { startAdminRuntime } from './helpers/adminRuntime'

const enabled = process.env.XCS_ISSUER_RUNTIME_TEST === '1'
const databaseUrl = process.env.XCS_TEST_DATABASE_URL?.trim()
const smtpPort = Number(process.env.XCS_ISSUER_RUNTIME_SMTP_PORT ?? '5531')
const mailpitOrigin = process.env.XCS_ISSUER_RUNTIME_MAILPIT_ORIGIN ?? 'http://127.0.0.1:8031'
if (enabled && !databaseUrl) throw new Error('XCS_TEST_DATABASE_URL is required')

/** Actual browser fetches: browser-owned Secure cookies, Origin and shared CSRF contract. */
async function request(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const auth = await fetch('/api/auth/session').then((response) => response.json())
      const response = await fetch(
        path,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-xcs-csrf': auth.csrfToken ?? '' },
              body: JSON.stringify(body),
            },
      )
      return {
        status: response.status,
        body: await response.json(),
        cache: response.headers.get('cache-control'),
      }
    },
    { path, body },
  )
}

describe.skipIf(!enabled)(
  'compiled issuer portal with PostgreSQL, Chromium and actual Mailpit SMTP',
  () => {
    it('uploads a private application, mails an invitation, claims it and filters an indexed private credential', async () => {
      await access(fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url)))
      const smtpUi = new URL(mailpitOrigin)
      if (
        smtpUi.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(smtpUi.hostname) ||
        smtpUi.username ||
        smtpUi.password
      )
        throw new Error('Runtime tests require local Mailpit')
      const testId = randomUUID().replaceAll('-', '')
      const databaseName = 'xcs_issuer_runtime_' + testId
      const base = fileURLToPath(new URL('../../../.data/issuer-runtime/', import.meta.url))
      await mkdir(base, { recursive: true })
      const directory = await mkdtemp(join(base, 'run-'))
      let operator: DatabaseClient | undefined,
        database: DatabaseClient | undefined,
        authDatabase: DatabaseClient | undefined
      let runtime: Awaited<ReturnType<typeof startAdminRuntime>> | undefined
      try {
        operator = createDatabaseClient(databaseUrl!, { onNotice: () => undefined })
        await operator.sql`CREATE DATABASE ${operator.sql(databaseName)} TEMPLATE template0`
        const url = new URL(databaseUrl!)
        url.pathname = '/' + databaseName
        database = createDatabaseClient(url.toString(), { onNotice: () => undefined })
        const passwords = {
          clusterScope: 'dedicated' as const,
          administratorPassword: databasePasswordFromUrl(databaseUrl!),
          indexerPassword: randomBytes(32).toString('hex'),
          apiPassword: randomBytes(32).toString('hex'),
          payloadWriterPassword: randomBytes(32).toString('hex'),
          monitorPassword: randomBytes(32).toString('hex'),
          applicationPassword: randomBytes(32).toString('hex'),
          adminApplicationPassword: randomBytes(32).toString('hex'),
          issuerPassword: randomBytes(32).toString('hex'),
        }
        await bootstrapDatabase(database, passwords)
        const roleUrl = (role: string, password: string) => {
          const value = new URL(url)
          value.username = role
          value.password = password
          return value.toString()
        }
        authDatabase = createDatabaseClient(roleUrl('xcs_app', passwords.applicationPassword), {
          onNotice: () => undefined,
        })
        const auth = new PostgresAuthRepository(authDatabase)
        const login = async (subject: string) => {
          const input = {
            ...createAppToken(),
            csrfToken: createAppToken().token,
            idleSeconds: 1800,
            absoluteSeconds: 28800,
          }
          await auth.createSession(
            {
              issuer: 'https://identity.test',
              subject,
              email: `${subject}-${testId}@example.test`,
              emailVerified: true,
              displayName: `Synthetic ${subject}`,
            },
            input,
          )
          return { ...input, userId: (await auth.session(input.tokenHash))!.userId }
        }
        const issuer = await login('issuer'),
          recipient = await login('recipient')
        const issuerAddress = Wallet.generate().address,
          subjectAddress = Wallet.generate().address
        const profileId = 'issuer-runtime',
          schemaUid = 'a'.repeat(64),
          registrationHash = 'b'.repeat(64),
          generationId = 'c'.repeat(64),
          ledgerHash = 'd'.repeat(64)
        const definition = {
          xcsVersion: '0.1',
          name: 'Synthetic runtime schema',
          description: 'Fixture-only validated projection',
          fields: { course: { type: 'string' }, secret: { type: 'string' } },
        }
        // Synthetic authoritative projection fixtures replace XRPL submission only; all issuer
        // HTTP handlers, role grants, storage, SMTP and rendering execute in the built application.
        await database.sql`INSERT INTO network_profiles(profile_id,xcs_version,network_id,required_amendment,registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash) VALUES (${profileId},'0.1',1,${ledgerHash},${issuerAddress},1,1,${ledgerHash})`
        await database.sql`INSERT INTO schema_events(profile_id,transaction_hash,ledger_index,ledger_hash,transaction_index,publisher,status,schema_uid,memo_json) VALUES (${profileId},${registrationHash},1,${ledgerHash},0,${issuerAddress},'accepted',${schemaUid},${JSON.stringify(definition)}::jsonb)`
        await database.sql`INSERT INTO schemas(profile_id,schema_uid,publisher,name,description,definition,resolved_definition,registration_transaction_hash,ledger_index,transaction_index) VALUES (${profileId},${schemaUid},${issuerAddress},${definition.name},${definition.description},${JSON.stringify(definition)}::jsonb,${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,${registrationHash},1,0)`
        await database.sql`INSERT INTO app_wallets(user_id,network_id,address,verified_at) VALUES (${issuer.userId},1,${issuerAddress},now()),(${recipient.userId},1,${subjectAddress},now())`
        runtime = await startAdminRuntime(
          directory,
          {
            api: roleUrl('xcs_api', passwords.apiPassword),
            auth: roleUrl('xcs_app', passwords.applicationPassword),
            admin: roleUrl('xcs_admin_app', passwords.adminApplicationPassword),
          },
          { issuerDatabaseUrl: roleUrl('xcs_issuer', passwords.issuerPassword), smtpPort },
        )
        const context = runtime.context
        const signIn = async (value: typeof issuer) => {
          await context.clearCookies()
          await context.addCookies([
            {
              name: SESSION_COOKIE,
              value: value.token,
              url: runtime!.origin,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax',
            },
          ])
        }
        await signIn(issuer)
        const page = await context.newPage()
        await page.goto(runtime.origin + '/issuer/apply')
        // Wait for hydration before filling SSR-rendered controls.
        await browserExpect(page.locator('[data-client-ready]')).toHaveAttribute(
          'data-client-ready',
          'true',
        )
        await page
          .getByLabel(en.simpleIssuer.applicationFields.name, { exact: true })
          .fill('Synthetic runtime school')
        await page
          .getByLabel(en.simpleIssuer.applicationFields.website, { exact: true })
          .fill('https://school.example.test')
        await page
          .getByLabel(en.simpleIssuer.applicationFields.contact, { exact: true })
          .fill('responsible@example.test')
        await page
          .getByLabel(en.simpleIssuer.applicationFields.jurisdiction, { exact: true })
          .fill('France')
        await page
          .getByLabel(en.simpleIssuer.applicationFields.description, { exact: true })
          .fill('Synthetic application for runtime verification')
        await page
          .getByLabel(en.simpleIssuer.applicationFields.purpose, { exact: true })
          .fill('Issue synthetic completion records')
        const proof = Buffer.from('%PDF-1.4\nSynthetic private evidence\n%%EOF')
        await page
          .locator('input[type=file]')
          .setInputFiles({ name: 'proof.pdf', mimeType: 'application/pdf', buffer: proof })
        await page.getByRole('button', { name: en.simpleIssuer.applySubmit, exact: true }).click()
        await browserExpect(page).toHaveURL(/\/issuer\/application\?organizationId=/)
        const organizationId = new URL(page.url()).searchParams.get('organizationId')!
        await browserExpect(
          page.getByRole('heading', { name: 'Synthetic runtime school', exact: true }),
        ).toBeVisible()
        const [document] =
          await database.sql`SELECT storage_key FROM app_documents WHERE organization_id=${organizationId}`
        expect(await readFile(join(directory, document!.storage_key))).toEqual(proof)
        expect(
          (
            await request(page, '/api/issuer/schemas', {
              organizationId,
              profileId,
              transactionHash: registrationHash,
            })
          ).status,
        ).toBe(403)
        await database.sql`UPDATE app_organization_applications SET status='approved',reviewed_by=${issuer.userId},reviewed_at=now(),revision=1 WHERE organization_id=${organizationId}`
        expect(
          (
            await request(page, '/api/issuer/schemas', {
              organizationId,
              profileId,
              transactionHash: registrationHash,
              displayName: 'Runtime course',
            })
          ).status,
        ).toBe(200)
        const email = `invited-${testId}@example.test`
        const sent = await request(page, '/api/issuer/invites', {
          organizationId,
          profileId,
          schemaUid,
          email,
          message: 'Synthetic invitation only',
        })
        expect(sent.status).toBe(200)
        expect(sent.body.deliveryStatus).toBe('sent')
        const inviteId = sent.body.id as string
        // Mailpit's documented rendered-text endpoint is filtered by our unique synthetic recipient.
        const textUrl = new URL('/view/latest.txt', mailpitOrigin)
        textUrl.searchParams.set('query', 'to:' + email)
        let message = ''
        await browserExpect
          .poll(async () => {
            const response = await fetch(textUrl)
            message = response.ok ? await response.text() : ''
            return message.includes('/recipient/invitations#')
          })
          .toBe(true)
        const link = message.match(
          /https:\/\/[^\s]+\/recipient\/invitations#[A-Za-z0-9_-]{43}/,
        )?.[0]
        expect(Boolean(link)).toBe(true)
        expect(message).not.toContain('Synthetic private evidence')
        await signIn(recipient)
        await page.goto(link!)
        await browserExpect(
          page.getByRole('button', { name: 'Claim with this account', exact: true }),
        ).toBeVisible()
        expect(new URL(page.url()).hash).toBe('')
        await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
        await browserExpect(
          page.getByText(en.simpleRecipient.invitationReady, { exact: true }),
        ).toBeVisible()
        const [claimed] =
          await database.sql`SELECT claimed_by FROM app_invites WHERE id=${inviteId}`
        expect(claimed!.claimed_by).toBe(recipient.userId)
        await signIn(issuer)
        await page.goto(runtime.origin + '/issuer')
        const canonical = canonicalJson({
          xcsVersion: '0.1',
          issuer: issuerAddress,
          subject: subjectAddress,
          schema: schemaUid,
          claims: { course: 'Public runtime course', secret: 'PRIVATE RUNTIME CLAIM' },
        })
        const draft = await request(page, '/api/issuer/payloads', {
          inviteId,
          canonicalPayload: canonical,
          subjectAddress,
          visibility: 'private',
          publicFields: ['/course'],
        })
        expect(draft.status).toBe(200)
        const uriHex = encodeHexUtf8(draft.body.credentialUri)
        await database.sql`INSERT INTO credential_generations(profile_id,generation_id,ledger_object_id,issuer,subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index) VALUES (${profileId},${generationId},${'e'.repeat(64)},${issuerAddress},${subjectAddress},${schemaUid},${uriHex},false,2,0,2)`
        await database.sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,uri_hex,accepted,snapshot) VALUES (${profileId},${generationId},0,${generationId},${'e'.repeat(64)},2,${ledgerHash},0,'created',${issuerAddress},${subjectAddress},${schemaUid},${uriHex},false,'{}')`
        const recorded = await request(page, '/api/issuer/credentials', {
          inviteId,
          transactionHash: generationId,
          payloadId: draft.body.payloadId,
          visibility: 'private',
          publicFields: ['/course'],
        })
        expect(recorded.status).toBe(200)
        const payloadPath = new URL(draft.body.credentialUri).pathname
        expect((await request(page, payloadPath)).body.claims.secret).toBe('PRIVATE RUNTIME CLAIM')
        await context.clearCookies()
        const publicView = await request(page, payloadPath)
        expect(publicView.status).toBe(200)
        expect(publicView.body).toEqual({ claims: { course: 'Public runtime course' } })
        expect(publicView.cache).toBe('private, no-store')
        expect(
          (await database.sql`SELECT count(*)::int AS count FROM hosted_payloads`)[0]!.count,
        ).toBe(0)
      } finally {
        await runtime?.close()
        await Promise.all([authDatabase?.close(), database?.close()])
        if (operator && /^xcs_issuer_runtime_[a-f0-9]{32}$/.test(databaseName))
          await operator.sql`DROP DATABASE IF EXISTS ${operator.sql(databaseName)} WITH (FORCE)`
        await operator?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 90000)
  },
)
