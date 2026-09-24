import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect as browserExpect, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { sign } from 'ripple-keypairs'
import {
  computeSchemaUid,
  encodeCredentialPayload,
  encodeHexUtf8,
  payloadDigest,
} from '#xcs/core/index.js'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import { SESSION_COOKIE } from '../server/xcs/auth/http'
import en from '../i18n/locales/en.json'
import { startAdminRuntime } from './helpers/adminRuntime'

const enabled = process.env.XCS_RECIPIENT_RUNTIME_TEST === '1'
const databaseUrl = process.env.XCS_TEST_DATABASE_URL?.trim()
if (enabled && !databaseUrl) throw new Error('XCS_TEST_DATABASE_URL is required')

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
      const text = await response.text()
      return {
        status: response.status,
        body: response.headers.get('content-type')?.includes('application/json')
          ? JSON.parse(text)
          : text,
        cache: response.headers.get('cache-control'),
      }
    },
    { path, body },
  )
}

describe.skipIf(!enabled)('compiled recipient and verifier portals over HTTPS', () => {
  it('filters anonymous and wrong-audience views, rechecks revoked sharing, and protects history after suspension', async () => {
    await access(fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url)))
    const testId = randomUUID().replaceAll('-', ''),
      databaseName = 'xcs_sharing_runtime_' + testId
    const base = fileURLToPath(
      new URL('../../../.data/recipient-verifier-runtime/', import.meta.url),
    )
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
          },
          input,
        )
        return { ...input, userId: (await auth.session(input.tokenHash))!.userId }
      }
      const recipient = await login('recipient'),
        verifier = await login('verifier'),
        outsider = await login('outsider')
      const subjectWallet = Wallet.generate()
      const issuerAddress = Wallet.generate().address,
        subjectAddress = subjectWallet.address
      const profileId = 'sharing-runtime',
        ledgerHash = 'd'.repeat(64),
        generationId = 'c'.repeat(64),
        registrationHash = 'b'.repeat(64)
      const definition = {
        xcsVersion: '0.1' as const,
        name: 'Runtime shared credential',
        description: 'Synthetic authoritative projection',
        fields: { course: { type: 'string' as const }, secret: { type: 'string' as const } },
      }
      const schemaUid = computeSchemaUid({
        schema: definition,
        networkId: 1,
        ledgerHash,
        ledgerIndex: 1,
        transactionIndex: 0,
        publisher: issuerAddress,
      })
      const payload = encodeCredentialPayload(
        { course: 'VISIBLE PUBLIC COURSE', secret: 'PRIVATE AUTHORIZED CLAIM' },
        { issuer: issuerAddress, subject: subjectAddress, schemaUid, fields: definition.fields },
      )
      const digest = payloadDigest(payload.bytes),
        locator = digest.slice(0, 18),
        uri = `https://example.test/q/${locator}#xcs-sha256=${digest}`
      const canonical = new TextDecoder().decode(payload.bytes)
      const issuerOrg = randomUUID(),
        verifierOrg = randomUUID(),
        outsiderOrg = randomUUID(),
        inviteId = randomUUID(),
        payloadId = randomUUID()
      // Only identities and ledger evidence are seeded. Routes, authorization, rendering and
      // PostgreSQL permissions run in the actual compiled application, without dev fixtures.
      await database.sql`INSERT INTO network_profiles(profile_id,xcs_version,network_id,required_amendment,registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash) VALUES (${profileId},'0.1',1,${ledgerHash},${issuerAddress},1,1,${ledgerHash})`
      await database.sql`INSERT INTO ledger_checkpoints(profile_id,ledger_index,ledger_hash,parent_hash,close_time,transaction_count,transaction_root) VALUES (${profileId},10,${ledgerHash},${'e'.repeat(64)},${Math.floor(Date.now() / 1000) - 946684800},2,${'f'.repeat(64)})`
      await database.sql`INSERT INTO indexer_status(profile_id,state,primary_source_tip,secondary_source_tip,last_agreed_ledger_index,last_agreed_ledger_hash,writer_id,writer_epoch,lease_expires_at) VALUES (${profileId},'ready',10,10,10,${ledgerHash},'sharing-runtime-writer',1,now()+interval '5 minutes')`
      await database.sql`INSERT INTO schema_events(profile_id,transaction_hash,ledger_index,ledger_hash,transaction_index,publisher,status,schema_uid,memo_json) VALUES (${profileId},${registrationHash},1,${ledgerHash},0,${issuerAddress},'accepted',${schemaUid},${JSON.stringify(definition)}::jsonb)`
      await database.sql`INSERT INTO schemas(profile_id,schema_uid,publisher,name,description,definition,resolved_definition,registration_transaction_hash,ledger_index,transaction_index) VALUES (${profileId},${schemaUid},${issuerAddress},${definition.name},${definition.description},${JSON.stringify(definition)}::jsonb,${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,${registrationHash},1,0)`
      await database.sql`INSERT INTO credential_generations(profile_id,generation_id,ledger_object_id,issuer,subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index) VALUES (${profileId},${generationId},${'e'.repeat(64)},${issuerAddress},${subjectAddress},${schemaUid},${encodeHexUtf8(uri)},true,2,0,2)`
      await database.sql`INSERT INTO app_organizations(id,responsible_user_id,name) VALUES (${issuerOrg},${recipient.userId},'Runtime issuer'),(${verifierOrg},${verifier.userId},'Runtime designated verifier'),(${outsiderOrg},${outsider.userId},'Runtime other verifier')`
      await database.sql`INSERT INTO app_organization_applications(organization_id,role,status,reviewed_by,reviewed_at) VALUES (${verifierOrg},'verifier','approved',${recipient.userId},now()),(${outsiderOrg},'verifier','approved',${recipient.userId},now())`
      await database.sql`INSERT INTO app_schema_metadata(profile_id,schema_uid,organization_id,registration_transaction_hash) VALUES (${profileId},${schemaUid},${issuerOrg},${registrationHash})`
      await database.sql`INSERT INTO app_invites(id,organization_id,profile_id,schema_uid,created_by,expires_at,claimed_by,claimed_at) VALUES (${inviteId},${issuerOrg},${profileId},${schemaUid},${recipient.userId},now()+interval '7 days',${recipient.userId},now())`
      await database.sql`INSERT INTO app_issuer_payloads(id,locator,invite_id,created_by,subject_address,canonical_payload,payload_digest,credential_uri,visibility,public_fields) VALUES (${payloadId},${locator},${inviteId},${recipient.userId},${subjectAddress},${canonical},${digest},${uri},'private','["/course"]')`
      await database.sql`INSERT INTO app_credential_metadata(profile_id,generation_id,schema_uid,issuer_organization_id,recipient_user_id,invite_id,issuer_address,subject_address,visibility,public_fields,payload_storage_key,payload_digest,creation_transaction_hash,creation_ledger_index) VALUES (${profileId},${generationId},${schemaUid},${issuerOrg},${recipient.userId},${inviteId},${issuerAddress},${subjectAddress},'private','["/course"]',${payloadId},${digest},${generationId},2)`
      runtime = await startAdminRuntime(
        directory,
        {
          api: roleUrl('xcs_api', passwords.apiPassword),
          auth: roleUrl('xcs_app', passwords.applicationPassword),
          admin: roleUrl('xcs_admin_app', passwords.adminApplicationPassword),
        },
        { issuerDatabaseUrl: roleUrl('xcs_issuer', passwords.issuerPassword), smtpPort: 5531 },
      )
      const context = runtime.context,
        page = await context.newPage()
      const signIn = async (user?: typeof recipient) => {
        await context.clearCookies()
        if (user)
          await context.addCookies([
            {
              name: SESSION_COOKIE,
              value: user.token,
              url: runtime!.origin,
              httpOnly: true,
              secure: true,
              sameSite: 'Lax',
            },
          ])
        // The cookie is a login fixture. Navigate as a completed login would, so an old
        // component's identity-change guard does not intentionally cancel the next action.
        await page.goto(runtime!.origin + '/')
      }
      await signIn(recipient)
      await database.sql`INSERT INTO app_wallets(user_id,network_id,address,verified_at) VALUES (${recipient.userId},1,${subjectAddress},statement_timestamp())`
      await page.goto(runtime.origin + '/recipient')
      await browserExpect(page.getByText(definition.name, { exact: true })).toBeVisible()
      const createPresentation = async (input: Record<string, unknown>) => {
        const challenge = await request(page, '/api/recipient/presentation-challenges', input)
        expect(challenge.status).toBe(200)
        expect(challenge.body.address).toBe(subjectAddress)
        return request(page, '/api/recipient/presentations', {
          ...input,
          proof: {
            challengeId: challenge.body.id,
            signature: sign(
              Buffer.from(challenge.body.message, 'utf8').toString('hex'),
              subjectWallet.privateKey,
            ),
            publicKey: subjectWallet.publicKey,
            scheme: 'ripple',
          },
        })
      }
      const full = await createPresentation({
        profileId,
        generationId,
        scope: 'full',
        verifierOrganizationId: verifierOrg,
      })
      expect(full.status, JSON.stringify(full.body)).toBe(200)
      const publicLink = await createPresentation({
        profileId,
        generationId,
        scope: 'public',
      })
      expect(publicLink.status, JSON.stringify(publicLink.body)).toBe(200)
      const paths: string[] = []
      page.on('request', (request) => paths.push(request.url()))
      const openPresentation = async (token: string) => {
        await page.goto(runtime!.origin + '/presentations#' + token)
        await page.getByRole('button', { name: en.presentation.open, exact: true }).click()
        await browserExpect(page.getByTestId('presentation-result')).toBeVisible()
      }
      await signIn()
      await openPresentation(publicLink.body.token)
      await browserExpect(page.getByTestId('presentation-result')).toContainText(
        'VISIBLE PUBLIC COURSE',
      )
      await browserExpect(page.getByTestId('presentation-result')).not.toContainText(
        'PRIVATE AUTHORIZED CLAIM',
      )
      expect(new URL(page.url()).hash).toBe('')
      // A second fragment in the same document must replace the previous link immediately.
      // Keep this transition within one anonymous session, independently of login fixtures.
      await openPresentation(full.body.token)
      await browserExpect(page.getByTestId('presentation-result')).toContainText(
        'VISIBLE PUBLIC COURSE',
      )
      await browserExpect(page.getByTestId('presentation-result')).not.toContainText(
        'PRIVATE AUTHORIZED CLAIM',
      )
      const anonymous = await request(page, '/api/presentations/resolve', {
        token: full.body.token,
      })
      expect(anonymous.body.requiresAuthorization).toBe(true)
      expect(anonymous.body.claims).toEqual({ course: 'VISIBLE PUBLIC COURSE' })
      await signIn(outsider)
      await openPresentation(full.body.token)
      await browserExpect(page.getByTestId('presentation-result')).not.toContainText(
        'PRIVATE AUTHORIZED CLAIM',
      )
      expect((await request(page, '/api/verifier/workspace')).body.history).toEqual([])
      await signIn(verifier)
      await openPresentation(full.body.token)
      await browserExpect(page.getByTestId('presentation-result')).toContainText(
        'PRIVATE AUTHORIZED CLAIM',
      )
      const workspace = await request(page, '/api/verifier/workspace')
      expect(workspace.body.history).toHaveLength(1)
      expect(JSON.stringify(workspace.body)).not.toContain('PRIVATE AUTHORIZED CLAIM')
      expect(JSON.stringify(workspace.body)).not.toContain(full.body.token)
      const historyId = workspace.body.history[0].id
      const withoutCsrf = await page.evaluate(async (id) => {
        const response = await fetch(`/api/verifier/history/${id}/presentation`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        return response.status
      }, historyId)
      expect(withoutCsrf).toBe(403)
      const accidentalGet = await request(page, `/api/verifier/history/${historyId}/presentation`)
      // Nitro's catch-all turns an unmatched nested-router method into an empty 204.
      // It must neither disclose claims nor create a consultation record.
      expect(accidentalGet.status).toBe(204)
      expect(accidentalGet.body).toBe('')
      expect((await request(page, '/api/verifier/workspace')).body.history).toHaveLength(1)
      const csv = await request(page, '/api/verifier/history.csv')
      expect(csv.status).toBe(200)
      expect(csv.body).not.toContain('PRIVATE AUTHORIZED CLAIM')
      expect(csv.cache).toBe('private, no-store')
      await page.goto(runtime.origin + '/verifier')
      await browserExpect(
        page.getByRole('heading', { name: en.verifier.history, exact: true }),
      ).toBeVisible()
      await page.getByRole('button', { name: en.verifier.reopen, exact: true }).click()
      await browserExpect(page.getByTestId('presentation-result')).toContainText(
        'PRIVATE AUTHORIZED CLAIM',
      )
      await signIn(recipient)
      expect(
        (await request(page, `/api/recipient/presentations/${full.body.id}/revoke`, {})).status,
      ).toBe(200)
      await signIn(verifier)
      expect(
        (await request(page, `/api/verifier/history/${historyId}/presentation`, {})).status,
      ).toBe(404)
      expect(
        (await request(page, '/api/presentations/resolve', { token: full.body.token })).status,
      ).toBe(404)
      await database.sql`UPDATE app_organization_applications SET status='suspended',review_reason='Runtime suspension' WHERE organization_id=${verifierOrg}`
      expect((await request(page, '/api/verifier/workspace')).body.history).toEqual([])
      expect((await request(page, '/api/verifier/history.csv')).status).toBe(403)
      await page.goto(runtime.origin + '/verifier')
      await browserExpect(
        page.getByRole('heading', { name: en.verifier.history, exact: true }),
      ).not.toBeVisible()
      expect(
        paths.some(
          (path) => path.includes(full.body.token) || path.includes(publicLink.body.token),
        ),
      ).toBe(false)
    } finally {
      await runtime?.close()
      await Promise.all([authDatabase?.close(), database?.close()])
      if (operator && /^xcs_sharing_runtime_[a-f0-9]{32}$/.test(databaseName))
        await operator.sql`DROP DATABASE IF EXISTS ${operator.sql(databaseName)} WITH (FORCE)`
      await operator?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 90000)
})
