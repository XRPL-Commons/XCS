import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet } from 'xrpl'
import { installJourneyLedger, installJourneyWallet } from './helpers/roleJourneyWallet'
import en from '../i18n/locales/en.json'
import { expect as browserExpect, type Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { computeSchemaUid } from '#xcs/core/index.js'
import {
  createAppToken,
  createDatabaseClient,
  type DatabaseClient,
} from '../server/lib/db/index.js'
import { bootstrapDatabase, databasePasswordFromUrl } from '../server/lib/db/bootstrap.js'
import { PostgresAuthRepository } from '../server/xcs/auth/repository'
import { SESSION_COOKIE } from '../server/xcs/auth/http'
import { startAdminRuntime } from './helpers/adminRuntime'

const enabled = process.env.XCS_ROLE_JOURNEY_RUNTIME_TEST === '1'
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
  'connected role journey in compiled HTTPS with real PostgreSQL and synthetic XRPL transports',
  () => {
    it('connects approval, invitation, signed wallet linkage, issuance, signed acceptance and verifier presentation', async () => {
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
      const databaseName = 'xcs_role_journey_' + testId
      const base = fileURLToPath(new URL('../../../.data/role-journey-runtime/', import.meta.url))
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
          recipient = await login('recipient'),
          admin = await login('admin'),
          verifier = await login('verifier')
        await database.sql`INSERT INTO app_user_roles(user_id,role) VALUES (${admin.userId},'admin')`
        const issuerWallet = Wallet.generate(),
          recipientWallet = Wallet.generate()
        const issuerAddress = issuerWallet.classicAddress,
          subjectAddress = recipientWallet.classicAddress
        const profileId = 'issuer-runtime',
          registrationHash = 'b'.repeat(64),
          ledgerHash = 'd'.repeat(64)
        let generationId = ''
        const definition = {
          xcsVersion: '0.1' as const,
          name: 'Synthetic runtime schema',
          description: 'Fixture-only validated projection',
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
        // Seed the existing registry and authoritative indexer checkpoint only. Both credential
        // projections are created later in the RPC fixture, after real signed blob submission.
        await database.sql`INSERT INTO network_profiles(profile_id,xcs_version,network_id,required_amendment,registry_address,registration_amount_drops,activation_ledger_index,activation_ledger_hash) VALUES (${profileId},'0.1',1,${ledgerHash},${issuerAddress},1,1,${ledgerHash})`
        await database.sql`INSERT INTO schema_events(profile_id,transaction_hash,ledger_index,ledger_hash,transaction_index,publisher,status,schema_uid,memo_json) VALUES (${profileId},${registrationHash},1,${ledgerHash},0,${issuerAddress},'accepted',${schemaUid},${JSON.stringify(definition)}::jsonb)`
        await database.sql`INSERT INTO schemas(profile_id,schema_uid,publisher,name,description,definition,resolved_definition,registration_transaction_hash,ledger_index,transaction_index) VALUES (${profileId},${schemaUid},${issuerAddress},${definition.name},${definition.description},${JSON.stringify(definition)}::jsonb,${JSON.stringify({ definition, fields: definition.fields, lineage: [] })}::jsonb,${registrationHash},1,0)`
        await database.sql`INSERT INTO ledger_checkpoints(profile_id,ledger_index,ledger_hash,parent_hash,close_time,transaction_count,transaction_root) VALUES (${profileId},10,${ledgerHash},${'e'.repeat(64)},${Math.floor(Date.now() / 1000) - 946684800},2,${'f'.repeat(64)})`
        await database.sql`INSERT INTO indexer_status(profile_id,state,primary_source_tip,secondary_source_tip,last_agreed_ledger_index,last_agreed_ledger_hash,writer_id,writer_epoch,lease_expires_at) VALUES (${profileId},'ready',10,10,10,${ledgerHash},'journey-fixture-writer',1,now()+interval '5 minutes')`
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
        const walletTransport = await installJourneyWallet(context, issuerWallet)
        let acceptedHash: string | undefined
        const ledgerTransport = await installJourneyLedger(context, {
          amendment: ledgerHash,
          ledgerHash,
          project: async (transaction, hash) => {
            if (transaction.TransactionType === 'CredentialCreate') {
              expect(transaction).toMatchObject({
                Account: issuerAddress,
                Subject: subjectAddress,
                CredentialType: schemaUid.toUpperCase(),
              })
              expect(generationId).toBe('')
              generationId = hash
              const uriHex = String(transaction.URI)
              // Explicit indexer fixture only. The actual issuer UI must prepare its private
              // payload, sign this blob and submit it before a created projection can exist.
              await database!
                .sql`INSERT INTO credential_generations(profile_id,generation_id,ledger_object_id,issuer,subject,schema_uid,uri_hex,accepted,created_ledger_index,created_transaction_index,last_ledger_index) VALUES (${profileId},${generationId},${'e'.repeat(64)},${issuerAddress},${subjectAddress},${schemaUid},${uriHex},false,2,0,2)`
              await database!
                .sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,uri_hex,accepted,snapshot) VALUES (${profileId},${generationId},0,${generationId},${'e'.repeat(64)},2,${ledgerHash},0,'created',${issuerAddress},${subjectAddress},${schemaUid},${uriHex},false,'{}')`
              return
            }
            expect(transaction).toMatchObject({
              TransactionType: 'CredentialAccept',
              Account: subjectAddress,
              Issuer: issuerAddress,
              CredentialType: schemaUid.toUpperCase(),
            })
            expect(generationId).toMatch(/^[0-9a-f]{64}$/)
            await database!
              .sql`UPDATE credential_generations SET accepted=true,last_ledger_index=3 WHERE profile_id=${profileId} AND generation_id=${generationId} AND accepted=false`
            await database!
              .sql`INSERT INTO credential_events(profile_id,transaction_hash,node_index,generation_id,ledger_object_id,ledger_index,ledger_hash,transaction_index,event_type,issuer,subject,schema_uid,accepted,snapshot) VALUES (${profileId},${hash},0,${generationId},${'e'.repeat(64)},3,${ledgerHash},0,'accepted',${issuerAddress},${subjectAddress},${schemaUid},true,'{}')`
            acceptedHash = hash
          },
        })
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
          await page.goto(runtime!.origin + '/')
        }
        const page = await context.newPage()
        await signIn(issuer)
        const application = (name: string) => ({
          name,
          website: 'https://school.example.test',
          contact: 'responsible@example.test',
          jurisdiction: 'France',
          description: 'Synthetic connected journey',
          purpose: 'Synthetic credential lifecycle',
          documents: [
            {
              mimeType: 'application/pdf',
              base64: Buffer.from('%PDF-1.4\nSynthetic evidence\n%%EOF').toString('base64'),
            },
          ],
        })
        const applied = await request(
          page,
          '/api/issuer/applications',
          application('Journey school'),
        )
        expect(applied.status).toBe(200)
        const organizationId = applied.body.organizationId as string
        const connectWallet = async (prefix = 'wallet') => {
          await page.getByTestId(`${prefix}-toggle`).click()
          await page.locator('[data-wallet-id="gemwallet"]').last().click()
        }
        const linkWallet = async (wallet: typeof issuerWallet) => {
          walletTransport.select(wallet)
          await page.goto(runtime!.origin + '/account')
          await connectWallet('wallet-link')
          await browserExpect(page.getByTestId('auth-link-wallet')).toBeEnabled()
          await page.getByTestId('auth-link-wallet').click()
          await page.getByText(en.simpleRecipient.manageWallet, { exact: true }).click()
          await browserExpect(page.getByTestId('linked-wallets')).toBeVisible()
          await browserExpect(page.getByTestId('linked-wallets')).toContainText(
            wallet.classicAddress,
          )
        }
        await linkWallet(issuerWallet)
        expect(
          (
            await request(page, '/api/issuer/schemas', {
              organizationId,
              profileId,
              transactionHash: registrationHash,
            })
          ).status,
        ).toBe(403)
        await signIn(admin)
        expect(
          (
            await request(page, `/api/admin/applications/${organizationId}/issuer/decisions`, {
              action: 'approve',
              revision: 0,
              reason: '',
              idempotencyKey: randomUUID(),
            })
          ).status,
        ).toBe(200)
        await signIn(verifier)
        const verifierApplication = await request(
          page,
          '/api/verifier/applications',
          application('Journey verifier'),
        )
        expect(verifierApplication.status).toBe(200)
        const verifierOrg = verifierApplication.body.organizationId as string
        await signIn(admin)
        expect(
          (
            await request(page, `/api/admin/applications/${verifierOrg}/verifier/decisions`, {
              action: 'approve',
              revision: 0,
              reason: '',
              idempotencyKey: randomUUID(),
            })
          ).status,
        ).toBe(200)
        await signIn(issuer)
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
        await browserExpect
          .poll(
            async () =>
              (await database!.sql`SELECT claimed_by FROM app_invites WHERE id=${inviteId}`)[0]
                ?.claimed_by,
          )
          .toBe(recipient.userId)
        await linkWallet(recipientWallet)
        const [claimed] =
          await database.sql`SELECT claimed_by FROM app_invites WHERE id=${inviteId}`
        expect(claimed!.claimed_by).toBe(recipient.userId)
        await signIn(issuer)
        await page.goto(runtime.origin + '/issuer')
        const readiness = await request(page, `/api/issuer/invites/${inviteId}/issuance`)
        expect(readiness.status).toBe(200)
        expect(readiness.body.recipient.wallets).toEqual([
          expect.objectContaining({ address: subjectAddress, networkId: 1 }),
        ])
        expect(readiness.body.issuerWallets).toEqual([
          expect.objectContaining({ address: issuerAddress, networkId: 1 }),
        ])
        walletTransport.select(issuerWallet)
        await page.goto(runtime.origin + `/issuer/issue/${inviteId}`)
        await connectWallet()
        await page.getByText(en.simpleIssuer.advanced, { exact: true }).click()
        await page.getByRole('button', { name: en.simpleIssuer.editJson, exact: true }).click()
        await page
          .locator('#claims')
          .fill(
            JSON.stringify({ course: 'Public runtime course', secret: 'PRIVATE RUNTIME CLAIM' }),
          )
        await page.getByRole('checkbox', { name: 'course', exact: true }).check()
        await page.getByRole('button', { name: en.simpleIssuer.reviewIssue, exact: true }).click()
        await page.getByTestId('transaction-technical-details').locator('summary').click()
        await browserExpect(page.getByTestId('transaction-technical-details')).toHaveAttribute(
          'open',
          '',
        )
        await browserExpect(page.getByTestId('transaction-technical-details')).toContainText(
          'CredentialCreate',
        )
        await page.getByTestId('transaction-technical-details').locator('summary').click()
        await page
          .getByRole('checkbox', { name: en.simpleIssuer.visibilityReviewed, exact: true })
          .check()
        await page.getByTestId('raw-signing-consent').check()
        const recording = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/issuer/credentials' &&
            response.request().method() === 'POST',
        )
        await page.getByTestId('transaction-sign').click()
        await browserExpect(page.getByTestId('xcs-confirmed')).toBeVisible()
        const recorded = await recording
        expect(recorded.status()).toBe(200)
        expect((await recorded.json()).generationId).toBe(generationId)
        expect(ledgerTransport.transactions.size).toBe(1)
        expect(walletTransport.signedMessages).toContainEqual({ hex: true, address: issuerAddress })
        await signIn(recipient)
        walletTransport.select(recipientWallet)
        await page.goto(
          runtime.origin + `/recipient/credentials/${generationId}?profile=${profileId}`,
        )
        await connectWallet()
        await page.getByRole('button', { name: en.accept.review, exact: true }).click()
        await browserExpect(page.getByTestId('credential-subject-review')).toBeVisible()
        await page.getByTestId('payload-consent').check()
        await browserExpect(page.getByTestId('credential-claims')).toContainText(
          'PRIVATE RUNTIME CLAIM',
        )
        await page.getByTestId('issuer-trust-acknowledgement').getByRole('checkbox').check()
        await page.getByTestId('transaction-technical-details').locator('summary').click()
        await browserExpect(page.getByTestId('transaction-technical-details')).toHaveAttribute(
          'open',
          '',
        )
        await browserExpect(page.getByTestId('transaction-technical-details')).toContainText(
          'CredentialAccept',
        )
        await page.getByTestId('transaction-technical-details').locator('summary').click()
        await page.getByTestId('raw-signing-consent').check()
        const reconciliation = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `/api/recipient/credentials/${profileId}/${generationId}/reconcile` &&
            response.request().method() === 'POST',
        )
        await page.getByTestId('transaction-sign').click()
        const reconciled = await reconciliation
        expect(reconciled.status()).toBe(200)
        const accepted = await reconciled.json()
        expect(accepted.status.accepted).toBe(true)
        expect(accepted.status.state).toBe('active')
        // The parent refresh replaces the review/result after reconcile. Assert the durable
        // accepted state and next action, rather than the transient confirmation component.
        await browserExpect(
          page.getByRole('link', { name: en.recipient.present, exact: true }),
        ).toBeVisible()
        expect(acceptedHash).toMatch(/^[0-9a-f]{64}$/)
        expect(ledgerTransport.transactions.size).toBe(2)
        expect(ledgerTransport.errors).toEqual([])
        expect(walletTransport.signedMessages).toEqual(
          expect.arrayContaining([
            { hex: false, address: issuerAddress },
            { hex: false, address: subjectAddress },
            { hex: true, address: subjectAddress },
          ]),
        )
        expect(walletTransport.errors).toEqual([])
        // This separate message signature binds the actual share intent and audience. Drive
        // the production UI and SDK, rather than directly signing the API challenge in the test.
        await page.goto(
          runtime.origin + `/recipient/credentials/${generationId}/present?profile=${profileId}`,
        )
        await connectWallet('presentation-wallet')
        await page.getByRole('radio', { name: en.presentation.full, exact: true }).check()
        await page.getByLabel(en.presentation.verifier).selectOption(verifierOrg)
        const signaturesBeforeShare = walletTransport.signedMessages.length
        const creationResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/recipient/presentations' &&
            response.request().method() === 'POST',
        )
        await page.getByRole('button', { name: en.presentation.create, exact: true }).click()
        const response = await creationResponse
        expect(response.status()).toBe(200)
        const full = { body: (await response.json()) as { id: string; token: string } }
        await browserExpect(page.locator('#presentation-created-link')).toBeVisible()
        // Boolean comparison avoids putting a bearer link in assertion diagnostics.
        expect(
          (await page.locator('#presentation-created-link').inputValue()) ===
            runtime.origin + '/presentations#' + full.body.token,
        ).toBe(true)
        expect(walletTransport.signedMessages.slice(signaturesBeforeShare)).toEqual([
          { hex: false, address: subjectAddress },
        ])
        await context.clearCookies()
        await page.goto(runtime.origin + '/presentations#' + full.body.token)
        const anonymousResolution = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/presentations/resolve' &&
            response.request().method() === 'POST',
        )
        await page.getByRole('button', { name: en.presentation.open, exact: true }).click()
        const anonymousResponse = await anonymousResolution
        expect(anonymousResponse.status()).toBe(200)
        const anonymous = await anonymousResponse.json()
        expect(anonymous.issuerAdmission.status).toBe('approved')
        expect(anonymous.issuerAdmission.organizationId).toBe(organizationId)
        expect(anonymous.credential.subjectAddress).toBe(subjectAddress)
        expect(anonymous.credential.networkId).toBe(1)
        expect(anonymous.credential.status.state).toBe('active')
        expect(anonymous.holderProof.status).toBe('verified')
        expect(anonymous.holderProof.address).toBe(subjectAddress)
        expect(anonymous.holderProof.networkId).toBe(1)
        expect(Number.isFinite(Date.parse(anonymous.holderProof.verifiedAt))).toBe(true)
        await browserExpect(
          page.getByRole('region', { name: en.roleJourney.admissionTitle, exact: true }),
        ).toContainText(en.roleJourney.admissionStatuses.approved)
        const ledgerSection = page.getByRole('region', {
          name: en.roleJourney.ledgerRecipientTitle,
          exact: true,
        })
        await browserExpect(ledgerSection).toContainText(en.roleJourney.ledgerStatuses.active)
        const presentationDetails = page
          .getByTestId('presentation-result')
          .locator('details')
          .filter({
            has: page.locator('summary').filter({ hasText: en.simpleUi.technicalDetails }),
          })
          .first()
        await browserExpect(presentationDetails).not.toHaveAttribute('open', '')
        expect(await page.getByTestId('presentation-result').innerText()).not.toContain(
          subjectAddress,
        )
        await presentationDetails.locator(':scope > summary').click()
        await browserExpect(presentationDetails).toHaveAttribute('open', '')
        await browserExpect(presentationDetails).toContainText(subjectAddress)
        await browserExpect(presentationDetails).toContainText(issuerAddress)
        await presentationDetails.locator(':scope > summary').click()
        const proofDate = await page.evaluate(
          (value) =>
            new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(value),
            ),
          anonymous.holderProof.verifiedAt,
        )
        await browserExpect(
          page.getByRole('region', { name: en.roleJourney.holderProofTitle, exact: true }),
        ).toContainText(en.roleJourney.holderVerifiedAt.replace('{date}', proofDate))
        await browserExpect(page.getByTestId('presentation-result')).toBeVisible()
        await browserExpect(page.getByTestId('presentation-result')).toContainText(
          'Public runtime course',
        )
        await browserExpect(page.getByTestId('presentation-result')).not.toContainText(
          'PRIVATE RUNTIME CLAIM',
        )
        await signIn(verifier)
        await page.goto(runtime.origin + '/presentations#' + full.body.token)
        await page.getByRole('button', { name: en.presentation.open, exact: true }).click()
        await browserExpect(page.getByTestId('presentation-result')).toContainText(
          'PRIVATE RUNTIME CLAIM',
        )
        const history = await request(page, '/api/verifier/workspace')
        expect(history.body.history).toHaveLength(1)
        expect(JSON.stringify(history.body.history)).not.toContain('PRIVATE RUNTIME CLAIM')
        expect(JSON.stringify(history.body.history)).not.toContain(full.body.token)
        await signIn(recipient)
        expect(
          (await request(page, `/api/recipient/presentations/${full.body.id}/revoke`, {})).status,
        ).toBe(200)
        await signIn(verifier)
        expect(
          (
            await request(
              page,
              `/api/verifier/history/${history.body.history[0].id}/presentation`,
              {},
            )
          ).status,
        ).toBe(404)
      } finally {
        await runtime?.close()
        await Promise.all([authDatabase?.close(), database?.close()])
        if (operator && /^xcs_role_journey_[a-f0-9]{32}$/.test(databaseName))
          await operator.sql`DROP DATABASE IF EXISTS ${operator.sql(databaseName)} WITH (FORCE)`
        await operator?.close()
        await rm(directory, { recursive: true, force: true })
      }
    }, 120000)
  },
)
