import { expect, test, type Download, type Page } from '@playwright/test'
import {
  canonicalJson,
  computeSchemaUid,
  createHttpsPayloadUri,
  createIpfsPayloadUri,
  encodeUtf8,
  encodeHexUtf8,
  sha256Hex,
  parseSchema,
  type JsonValue,
  type NetworkProfile,
  type SchemaDefinition,
} from '@xcs-protocol/core'
import { hashes, Wallet } from 'xrpl'

const API_PREFIX = '/__e2e-api'
const PROFILE_ID = 'xrpl-testnet-xcs-browser-e2e'
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const ISSUER_WALLET_ID = 'xcs-browser-e2e'
const SUBJECT_WALLET_ID = 'xcs-browser-e2e-subject'
const GEMWALLET_ID = 'gemwallet'
const LEDGER_HASH = 'cd'.repeat(32)
const SCHEMA: SchemaDefinition = {
  xcsVersion: '0.1',
  name: 'Diploma Award',
  description: 'Attests one deterministic browser test diploma award.',
  fields: {
    programId: { type: 'string' },
    programName: { type: 'string' },
    awardedAt: { type: 'string' },
    diplomaId: { type: 'string' },
    prenom: { type: 'string' },
    honors: { type: 'string', optional: true },
  },
}
const SCHEMA_UID = computeSchemaUid({
  schema: parseSchema(SCHEMA),
  networkId: 1,
  ledgerHash: LEDGER_HASH,
  ledgerIndex: 100_001,
  transactionIndex: 1,
  publisher: ISSUER,
})
const CLAIMS = {
  programId: 'xcs-protocol-engineering-2026',
  programName: 'Protocol Engineering',
  awardedAt: '2026-08-25T10:00:00Z',
  diplomaId: 'DIP-2026-0042',
  prenom: 'Personne Test',
  honors: 'with distinction',
}
const PAYLOAD_URL = 'https://issuer.xcs.invalid/diploma.json'
const PERMALINK_GENERATION_ID = '34'.repeat(32)
const PERMALINK_ACCEPTED_TRANSACTION_HASH = '78'.repeat(32)
const HISTORICAL_GENERATION_ID = '56'.repeat(32)
const CANONICAL_PAYLOAD = canonicalJson({
  xcsVersion: '0.1',
  issuer: ISSUER,
  subject: SUBJECT,
  schema: SCHEMA_UID,
  claims: CLAIMS,
} as JsonValue)
const CREDENTIAL_URI = createHttpsPayloadUri(PAYLOAD_URL, CANONICAL_PAYLOAD)
const RECOVERY_OPERATION_ID = 'browser-recovery-after-reload'
const RECOVERY_LAST_LEDGER_SEQUENCE = 100_021
const RECOVERY_SIGNER = Wallet.fromEntropy(
  Uint8Array.from({ length: 16 }, (_, index) => index + 1),
  { masterAddress: ISSUER },
)
const RECOVERY_TX_BLOB = RECOVERY_SIGNER.sign({
  TransactionType: 'Payment',
  Account: ISSUER,
  Destination: SUBJECT,
  Amount: '1',
  Fee: '12',
  Sequence: 1,
  LastLedgerSequence: RECOVERY_LAST_LEDGER_SEQUENCE,
}).tx_blob
const RECOVERY_TX_HASH = hashes.hashSignedTx(RECOVERY_TX_BLOB).toUpperCase()
const PROFILE: NetworkProfile = {
  profileId: PROFILE_ID,
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'ab'.repeat(32).toUpperCase(),
  registryAddress: SUBJECT,
  registrationAmountDrops: '1',
  activationLedgerIndex: 1,
  activationLedgerHash: 'ef'.repeat(32),
}

interface ApiMockOptions {
  readonly schemaDigestHex?: string
  readonly credentialEvidence?: () => 'confirmed' | 'mismatch'
  readonly credentialLifecycle?: BrowserCredentialLifecycle
  readonly credentialUri?: string
  readonly networksUnavailable?: boolean
  readonly pendingCredentialRejection?: boolean
  readonly credentialDeletionCause?: 'issuer_revoked' | 'subject_rejected' | 'subject_removed'
  readonly signingReadiness?: () => 'ready' | 'unavailable' | 'malformed'
}

interface BrowserCredentialLifecycle {
  generationId: string | null
  state: 'pending' | 'active' | 'expired' | 'deleted'
  accepted: boolean
  acceptedTransactionHash: string | null
  removedTransactionHash?: string | null
}

const browserErrors = new WeakMap<Page, string[]>()

test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console:${message.text()}`)
  })
  page.on('requestfailed', (request) => {
    errors.push(`requestfailed:${request.method()} ${request.url()}`)
  })
})

test.afterEach(({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([])
})

function consumeExpectedHttpFailure(page: Page, status: string): void {
  const errors = browserErrors.get(page) ?? []
  expect(errors.length).toBeGreaterThan(0)
  expect(
    errors.every(
      (entry) =>
        entry ===
        `console:Failed to load resource: the server responded with a status of ${status}`,
    ),
  ).toBe(true)
  errors.length = 0
}

async function installApiMock(page: Page, options: ApiMockOptions = {}): Promise<void> {
  await page.route(`**${API_PREFIX}/v1/**`, async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.slice(API_PREFIX.length)
    if (route.request().method() === 'POST' && path === '/v1/verify') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const lifecycle = options.credentialLifecycle
      if (
        lifecycle?.generationId === null ||
        body.network !== PROFILE_ID ||
        body.issuer !== ISSUER ||
        body.subject !== SUBJECT ||
        body.schemaUid !== SCHEMA_UID ||
        body.resolvePayload === true
      ) {
        await route.fulfill({ status: 400, json: { error: 'BROWSER_E2E_VERIFY_INPUT_INVALID' } })
        return
      }
      if (
        Object.hasOwn(body, 'payload') &&
        canonicalJson(body.payload as JsonValue) !== CANONICAL_PAYLOAD
      ) {
        await route.fulfill({ status: 400, json: { error: 'BROWSER_E2E_VERIFY_PAYLOAD_INVALID' } })
        return
      }
      await route.fulfill({
        json: {
          onChain: lifecycle?.state ?? 'pending',
          schema: 'valid',
          payload: Object.hasOwn(body, 'payload') ? 'valid' : 'not_checked',
          issuerTrust: 'unknown',
          ...(lifecycle?.generationId ? { generationId: lifecycle.generationId } : {}),
        },
      })
      return
    }
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'BROWSER_E2E_METHOD_NOT_ALLOWED' } })
      return
    }
    if (path === '/v1/networks') {
      if (options.networksUnavailable) {
        await route.fulfill({
          status: 503,
          json: { error: 'INDEXER_STALE', message: 'Synthetic unavailable projection.' },
        })
        return
      }
      await route.fulfill({ json: { items: [PROFILE] } })
      return
    }
    if (path === `/v1/networks/${PROFILE_ID}/readiness`) {
      const readiness = options.signingReadiness?.() ?? 'ready'
      if (readiness === 'unavailable') {
        await route.fulfill({
          status: 503,
          json: { error: 'INDEXER_STALE', message: 'Synthetic stale indexer.' },
        })
        return
      }
      if (readiness === 'malformed') {
        await route.fulfill({ json: { profileId: 'wrong-profile', status: 'ready' } })
        return
      }
      await route.fulfill({
        json: {
          profileId: PROFILE_ID,
          status: 'ready',
          checkpoint: {
            ledgerIndex: 100_001,
            ledgerHash: LEDGER_HASH,
            closeTime: 838_857_600,
            transactionRoot: 'cd'.repeat(32),
          },
        },
      })
      return
    }
    if (path === `/v1/networks/${PROFILE_ID}/stats`) {
      await route.fulfill({
        json: {
          network: PROFILE_ID,
          schemas: { total: 12, publishers: 4 },
          credentialGenerations: {
            total: 27,
            pending: 3,
            active: 20,
            expired: 2,
            deleted: 2,
          },
          checkpoint: {
            ledgerIndex: 100_001,
            ledgerHash: LEDGER_HASH,
            closeTime: 838_857_600,
            transactionRoot: 'cd'.repeat(32),
          },
        },
      })
      return
    }
    if (path === `/v1/networks/${PROFILE_ID}/search`) {
      await route.fulfill({
        json: {
          items: [
            {
              type: 'schema',
              schemaUid: SCHEMA_UID,
              name: SCHEMA.name,
              description: SCHEMA.description,
              publisher: ISSUER,
              parentUid: null,
              supersedesUid: null,
              registrationTransactionHash: '56'.repeat(32),
              ledgerIndex: 100_001,
              transactionIndex: 1,
            },
          ],
          hasMore: false,
        },
      })
      return
    }
    if (path === `/v1/networks/${PROFILE_ID}/schemas/${SCHEMA_UID}`) {
      await route.fulfill({
        json: {
          schemaUid: SCHEMA_UID,
          name: SCHEMA.name,
          description: SCHEMA.description,
          publisher: ISSUER,
          parentUid: null,
          supersedesUid: null,
          definition: SCHEMA,
          resolvedDefinition: { definition: SCHEMA, fields: SCHEMA.fields, lineage: [] },
          registrationTransactionHash: '56'.repeat(32),
          ledgerIndex: 100_001,
          transactionIndex: 1,
        },
      })
      return
    }
    const generationMatch = path.match(
      new RegExp(`^/v1/networks/${PROFILE_ID}/credential-generations/([0-9a-f]{64})$`, 'u'),
    )
    if (generationMatch) {
      const lifecycle = options.credentialLifecycle
      const requestedGenerationId = generationMatch[1]!
      if (
        !lifecycle?.generationId ||
        requestedGenerationId !== lifecycle.generationId ||
        !options.credentialUri
      ) {
        await route.fulfill({ status: 404, json: { error: 'CREDENTIAL_GENERATION_NOT_FOUND' } })
        return
      }
      const createdEvent = {
        transactionHash: lifecycle.generationId,
        nodeIndex: 0,
        generationId: lifecycle.generationId,
        ledgerIndex: 100_001,
        ledgerHash: LEDGER_HASH,
        transactionIndex: 2,
        eventType: 'created',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: SCHEMA_UID,
        accepted: false,
        deletionCause: null,
      }
      const acceptedEvent = {
        transactionHash: lifecycle.acceptedTransactionHash ?? PERMALINK_ACCEPTED_TRANSACTION_HASH,
        nodeIndex: 0,
        generationId: lifecycle.generationId,
        ledgerIndex: 100_002,
        ledgerHash: 'de'.repeat(32),
        transactionIndex: 1,
        eventType: 'accepted',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: SCHEMA_UID,
        accepted: true,
        deletionCause: null,
      }
      const removedEvent = {
        transactionHash: lifecycle.removedTransactionHash,
        nodeIndex: 0,
        generationId: lifecycle.generationId,
        ledgerIndex: 100_003,
        ledgerHash: 'fa'.repeat(32),
        transactionIndex: 1,
        eventType: 'deleted',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: SCHEMA_UID,
        accepted: lifecycle.accepted,
        deletionCause:
          options.credentialDeletionCause ??
          (lifecycle.accepted ? 'subject_removed' : 'subject_rejected'),
      }
      await route.fulfill({
        json: {
          generation: {
            generationId: lifecycle.generationId,
            ledgerObjectId: '90'.repeat(32),
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: SCHEMA_UID,
            uriHex: encodeHexUtf8(options.credentialUri),
            expiration: null,
            accepted: lifecycle.accepted,
            createdLedgerIndex: 100_001,
            createdTransactionIndex: 2,
            lastLedgerIndex:
              lifecycle.state === 'deleted'
                ? 100_003
                : lifecycle.state === 'active' || lifecycle.state === 'expired'
                  ? 100_002
                  : 100_001,
            deletedLedgerIndex: lifecycle.state === 'deleted' ? 100_003 : null,
            deletionCause:
              lifecycle.state === 'deleted'
                ? (options.credentialDeletionCause ??
                  (lifecycle.accepted ? 'subject_removed' : 'subject_rejected'))
                : null,
          },
          state: lifecycle.state,
          timeline:
            lifecycle.state === 'deleted'
              ? lifecycle.accepted
                ? [createdEvent, acceptedEvent, removedEvent]
                : [createdEvent, removedEvent]
              : lifecycle.state === 'active' || lifecycle.state === 'expired'
                ? [createdEvent, acceptedEvent]
                : [createdEvent],
        },
      })
      return
    }
    const registrationMatch = path.match(
      new RegExp(`^/v1/networks/${PROFILE_ID}/schema-registrations/([0-9a-f]{64})$`, 'u'),
    )
    if (registrationMatch) {
      const txHash = registrationMatch[1]!
      await route.fulfill({
        json: {
          transactionHash: txHash,
          registration: {
            status: 'accepted',
            publisher: ISSUER,
            ledgerIndex: 100_001,
            ledgerHash: LEDGER_HASH,
            transactionIndex: 1,
            schemaUid: SCHEMA_UID,
            schemaDigestHex: options.schemaDigestHex,
            reasonCode: null,
          },
        },
      })
      return
    }
    const credentialPath = `/v1/networks/${PROFILE_ID}/credentials/${ISSUER}/${SUBJECT}/${SCHEMA_UID}`
    if (path === credentialPath) {
      const lifecycle = options.credentialLifecycle
      if (!lifecycle?.generationId || !options.credentialUri) {
        await route.fulfill({ status: 404, json: { error: 'CREDENTIAL_NOT_FOUND' } })
        return
      }
      await route.fulfill({
        json: {
          generationId: lifecycle.generationId,
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          uriHex: encodeHexUtf8(options.credentialUri),
          expiration: null,
          accepted: lifecycle.accepted,
          state: lifecycle.state,
        },
      })
      return
    }
    const credentialEventMatch = path.match(
      new RegExp(
        `^/v1/networks/${PROFILE_ID}/credentials/${ISSUER}/${SUBJECT}/${SCHEMA_UID}/events/([0-9a-f]{64})$`,
        'u',
      ),
    )
    if (credentialEventMatch) {
      const txHash = credentialEventMatch[1]!
      const lifecycle = options.credentialLifecycle
      const lifecycleEvent = Boolean(
        lifecycle !== undefined &&
        lifecycle.generationId !== null &&
        lifecycle.generationId !== txHash,
      )
      const deletionEvent =
        lifecycleEvent &&
        (lifecycle.state !== 'pending' || options.pendingCredentialRejection === true)
      const acceptanceEvent = lifecycleEvent && !deletionEvent
      const evidenceConfirmed = options.credentialEvidence?.() === 'confirmed'
      const generationId = lifecycleEvent
        ? lifecycle.generationId!
        : evidenceConfirmed
          ? txHash
          : '34'.repeat(32)
      if (!lifecycleEvent && evidenceConfirmed && lifecycle) lifecycle.generationId = txHash
      if (acceptanceEvent && lifecycle) {
        lifecycle.state = 'active'
        lifecycle.accepted = true
        lifecycle.acceptedTransactionHash = txHash
      }
      if (deletionEvent && lifecycle) {
        lifecycle.state = 'deleted'
        lifecycle.removedTransactionHash = txHash
      }
      await route.fulfill({
        json: {
          transactionHash: txHash,
          event: {
            transactionHash: txHash,
            nodeIndex: 0,
            issuer: ISSUER,
            subject: SUBJECT,
            schemaUid: SCHEMA_UID,
            generationId,
            ledgerIndex: 100_001,
            ledgerHash: LEDGER_HASH,
            transactionIndex: 2,
            eventType: deletionEvent ? 'deleted' : acceptanceEvent ? 'accepted' : 'created',
            accepted: lifecycle?.accepted ?? false,
            deletionCause: deletionEvent
              ? (options.credentialDeletionCause ??
                (lifecycle?.accepted ? 'subject_removed' : 'subject_rejected'))
              : null,
          },
        },
      })
      return
    }
    await route.fulfill({
      status: 501,
      json: { error: 'UNEXPECTED_BROWSER_E2E_API_REQUEST', path },
    })
  })
}

async function connectSyntheticWallet(
  page: Page,
  actor: 'issuer' | 'subject' | 'gemwallet' = 'issuer',
): Promise<void> {
  const walletId =
    actor === 'subject'
      ? SUBJECT_WALLET_ID
      : actor === 'gemwallet'
        ? GEMWALLET_ID
        : ISSUER_WALLET_ID
  const account = actor === 'subject' ? SUBJECT : ISSUER
  await page.locator('[data-client-ready="true"]').waitFor()
  const trigger = page.getByTestId('wallet-toggle')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await page.locator(`[data-wallet-id="${walletId}"]`).click()
  await expect(page.getByTestId('wallet-toggle')).toContainText(account.slice(0, 6))
}

test('explains GemWallet Credential incompatibility before preview or wallet interaction', async ({
  page,
}) => {
  await installApiMock(page)
  await page.goto('/issue')
  await connectSyntheticWallet(page, 'gemwallet')
  await page.locator('#schema-uid').fill(SCHEMA_UID)
  await page.locator('#subject').fill(SUBJECT)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#claims').fill(JSON.stringify(CLAIMS, null, 2))
  await page.locator('#https-url').fill(PAYLOAD_URL)

  await page.getByRole('button', { name: 'Valider et préparer' }).click()

  const issueError = page.getByTestId('issue-error')
  await expect(issueError).toContainText('GemWallet ne peut pas signer CredentialCreate')
  await expect(issueError).toContainText(
    'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED:gemwallet:CredentialCreate',
  )
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
})

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function browserE2eEffects(page: Page): Promise<{
  walletSignatures: number
  ledgerSubmissions: number
}> {
  return page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __xcsBrowserE2eEffects?: { walletSignatures: number; ledgerSubmissions: number }
    }
    return runtime.__xcsBrowserE2eEffects ?? { walletSignatures: 0, ledgerSubmissions: 0 }
  })
}

async function browserOperationPersistence(page: Page): Promise<
  {
    stage: unknown
    hasTxBlob: boolean
    hasTxHash: boolean
  }[]
> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('xcs-wallet-journal', 1)
        request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_OPEN_FAILED'))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('operations', 'readonly')
          const rows = transaction.objectStore('operations').getAll()
          rows.onerror = () => reject(rows.error ?? new Error('INDEXED_DB_READ_FAILED'))
          rows.onsuccess = () => {
            resolve(
              (rows.result as Record<string, unknown>[]).map((row) => ({
                stage: row.stage,
                hasTxBlob: typeof row.txBlob === 'string' && row.txBlob.length > 0,
                hasTxHash: typeof row.txHash === 'string' && row.txHash.length > 0,
                ...(typeof row.message === 'string' ? { message: row.message } : {}),
              })),
            )
          }
        }
      }),
  )
}

async function seedSignedRecoveryOperation(
  page: Page,
  overrides: { readonly lastLedgerSequence?: number; readonly txHash?: string } = {},
): Promise<void> {
  const lastLedgerSequence = overrides.lastLedgerSequence ?? RECOVERY_LAST_LEDGER_SEQUENCE
  const txHash = overrides.txHash ?? RECOVERY_TX_HASH
  await page.goto('/operations')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.evaluate(
    ({ operationId, txBlob, txHash, lastLedgerSequence, profileId, account }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('xcs-wallet-journal', 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains('operations')) {
            request.result.createObjectStore('operations', { keyPath: 'operationId' })
          }
        }
        request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_OPEN_FAILED'))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('operations', 'readwrite')
          transaction.objectStore('operations').put({
            operationId,
            account,
            profileId,
            networkId: 1,
            transactionType: 'Payment',
            createdAt: '2026-08-30T12:00:00.000Z',
            updatedAt: '2026-08-30T12:00:00.000Z',
            stage: 'signed',
            txBlob,
            txHash,
            lastLedgerSequence,
          })
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('INDEXED_DB_WRITE_FAILED'))
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('INDEXED_DB_WRITE_ABORTED'))
        }
      }),
    {
      operationId: RECOVERY_OPERATION_ID,
      txBlob: RECOVERY_TX_BLOB,
      txHash,
      lastLedgerSequence,
      profileId: PROFILE_ID,
      account: ISSUER,
    },
  )
  await page.reload()
  await page.locator('[data-client-ready="true"]').waitFor()
}

async function browserStoredRecoveryOperation(page: Page): Promise<{
  stage: unknown
  txBlob: unknown
  txHash: unknown
  lastLedgerSequence: unknown
}> {
  return page.evaluate(
    (operationId) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('xcs-wallet-journal', 1)
        request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_OPEN_FAILED'))
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('operations', 'readonly')
          const row = transaction.objectStore('operations').get(operationId)
          row.onerror = () => reject(row.error ?? new Error('INDEXED_DB_READ_FAILED'))
          row.onsuccess = () => {
            const operation = row.result as Record<string, unknown>
            resolve({
              stage: operation.stage,
              txBlob: operation.txBlob,
              txHash: operation.txHash,
              lastLedgerSequence: operation.lastLedgerSequence,
            })
          }
        }
      }),
    RECOVERY_OPERATION_ID,
  )
}

function consumeExpectedReadiness503(page: Page): void {
  const errors = browserErrors.get(page) ?? []
  const expected =
    'console:Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
  const index = errors.indexOf(expected)
  expect(index).toBeGreaterThanOrEqual(0)
  errors.splice(index, 1)
}

test('discovers a schema from aggregate stats and global search', async ({ page }) => {
  await installApiMock(page)

  await page.goto('/')
  const schemaCount = page.getByText('12', { exact: true })
  await expect(schemaCount).toBeVisible()
  await expect(page.getByText(/schémas valides|valid schemas/u)).toBeVisible()

  await page.locator('[data-client-ready="true"]').waitFor()
  const search = page.locator('.explorer-search').filter({ has: page.locator('#explorer-search') })
  await search.getByRole('searchbox').fill('Diploma')
  await expect(search.getByRole('button')).toBeEnabled()
  await search.getByRole('button').click()
  await expect(page).toHaveURL(/\/(?:en\/)?search\?q=Diploma$/u)
  const result = page.locator('.result-card').filter({ hasText: SCHEMA.name })
  await expect(result).toContainText(SCHEMA_UID)
  await result.click()
  await expect(page.getByRole('heading', { level: 1, name: SCHEMA.name })).toBeVisible()
})

test('exposes the simplified create, verify and docs navigation', async ({ page }) => {
  await installApiMock(page)

  await page.goto('/')
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: /L’infrastructure des credentials vérifiables|Credential infrastructure for verifiable data/u,
    }),
  ).toBeVisible()

  const navigation = page.locator('.primary-nav')
  await expect(navigation.getByRole('link', { name: 'Explorer', exact: true })).toHaveAttribute(
    'href',
    /^\/(?:en\/)?schemas$/u,
  )
  await expect(
    navigation.getByRole('link', { name: /Créer|Create/u, exact: true }),
  ).toHaveAttribute('href', /^\/(?:en\/)?studio$/u)
  await expect(
    navigation.getByRole('link', { name: /Vérifier|Verify/u, exact: true }),
  ).toHaveAttribute('href', /^\/(?:en\/)?verify$/u)
  await expect(navigation.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute(
    'href',
    /^\/(?:en\/)?developers$/u,
  )

  await page.getByRole('link', { name: /Commencer à créer|Start building/u }).click()
  await expect(page).toHaveURL(/\/(?:en\/)?studio$/u)
  await expect(page.locator('.create-primary-card[href$="/schemas/register"]')).toBeVisible()
  await expect(page.locator('.create-primary-card[href$="/issue"]')).toBeVisible()
})

test('keeps the complete landing hero inside a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 893 })
  await installApiMock(page)

  await page.goto('/')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.locator('.landing-art img').evaluate(async (image) => {
    await (image as HTMLImageElement).decode()
  })

  const viewport = page.viewportSize()
  const hero = await page.locator('.landing-hero').boundingBox()
  const primaryAction = await page
    .getByRole('link', { name: /Commencer à créer|Start building/u })
    .boundingBox()
  const installCommand = await page.locator('.install-command').boundingBox()

  expect(viewport).not.toBeNull()
  expect(hero).not.toBeNull()
  expect(primaryAction).not.toBeNull()
  expect(installCommand).not.toBeNull()
  expect(hero!.y + hero!.height).toBeLessThanOrEqual(viewport!.height + 1)
  expect(primaryAction!.y + primaryAction!.height).toBeLessThanOrEqual(viewport!.height)
  expect(installCommand!.y + installCommand!.height).toBeLessThanOrEqual(viewport!.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport!.width,
  )
})

test('opens an exact credential verification from its generation ID', async ({ page }) => {
  await installApiMock(page, {
    credentialLifecycle: {
      generationId: PERMALINK_GENERATION_ID,
      state: 'active',
      accepted: true,
      acceptedTransactionHash: PERMALINK_ACCEPTED_TRANSACTION_HASH,
    },
    credentialUri: CREDENTIAL_URI,
  })

  await page.goto('/verify')
  await page.locator('[data-client-ready="true"]').waitFor()
  const generationInput = page.getByLabel(/Identifiant de génération|Credential generation ID/u)
  const openVerification = page.getByRole('button', {
    name: /Ouvrir la vérification|Open verification/u,
  })
  await generationInput.fill('not-a-generation')
  await openVerification.click()
  await expect(page.locator('#verify-generation-error')).toBeVisible()
  await expect(page).toHaveURL(/\/(?:en\/)?verify$/u)

  await generationInput.fill(PERMALINK_GENERATION_ID)
  await openVerification.click()

  await expect(page).toHaveURL(new RegExp(`/(?:en/)?credentials/${PERMALINK_GENERATION_ID}$`, 'u'))
  await expect(page.getByRole('heading', { level: 1, name: SCHEMA.name })).toBeVisible()
  await expect(page.getByTestId('credential-dimension-on-chain')).toContainText('active')
})

test('fails closed when an exact generation permalink targets another network profile', async ({
  page,
}) => {
  await installApiMock(page, {
    credentialLifecycle: {
      generationId: PERMALINK_GENERATION_ID,
      state: 'active',
      accepted: true,
      acceptedTransactionHash: PERMALINK_ACCEPTED_TRANSACTION_HASH,
    },
    credentialUri: CREDENTIAL_URI,
  })

  await page.goto(`/credentials/${PERMALINK_GENERATION_ID}?profile=another-network`)
  await page.locator('[data-client-ready="true"]').waitFor()

  await expect(page.locator('.explorer-error')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: SCHEMA.name })).toHaveCount(0)
})

test('fails closed when an exact credential generation does not exist', async ({ page }) => {
  await installApiMock(page)
  const unknownGenerationId = '99'.repeat(32)

  await page.goto('/verify')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page
    .getByLabel(/Identifiant de génération|Credential generation ID/u)
    .fill(unknownGenerationId)
  await page.getByRole('button', { name: /Ouvrir la vérification|Open verification/u }).click()

  await expect(page).toHaveURL(new RegExp(`/(?:en/)?credentials/${unknownGenerationId}$`, 'u'))
  await expect(page.locator('.explorer-error')).toContainText(
    /ressource XCS est introuvable|XCS resource could not be found/u,
  )
  consumeExpectedHttpFailure(page, '404 (Not Found)')
})

test('fails closed when the exact credential projection is unavailable', async ({ page }) => {
  await installApiMock(page, { networksUnavailable: true })
  const generationId = '98'.repeat(32)

  await page.goto('/verify')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.getByLabel(/Identifiant de génération|Credential generation ID/u).fill(generationId)
  await page.getByRole('button', { name: /Ouvrir la vérification|Open verification/u }).click()

  await expect(page).toHaveURL(new RegExp(`/(?:en/)?credentials/${generationId}$`, 'u'))
  await expect(page.locator('.explorer-error')).toContainText(
    /ne peut pas répondre de façon fiable|cannot answer reliably/u,
  )
  await expect(page.locator('.explorer-error')).toContainText(
    /échoue volontairement en mode fermé|deliberately fails closed/u,
  )
  consumeExpectedHttpFailure(page, '503 (Service Unavailable)')
})

test('registers a schema through XRPL validation and exact indexed XCS finality', async ({
  page,
}) => {
  const validatedSchema = parseSchema(SCHEMA)
  const canonicalSchema = canonicalJson(validatedSchema as unknown as JsonValue)
  const schemaDigestHex = sha256Hex(encodeUtf8(canonicalSchema))
  await installApiMock(page, { schemaDigestHex })

  await page.goto('/schemas/register')
  await connectSyntheticWallet(page)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#schema-json').fill(JSON.stringify(SCHEMA, null, 2))
  await page.getByRole('button', { name: 'Valider et préparer' }).click()

  await expect(page.getByTestId('transaction-preview')).toContainText('Payment')
  await page.getByTestId('transaction-sign').click()

  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Ouvrir le schéma confirmé' })).toHaveAttribute(
    'href',
    `/schemas/${SCHEMA_UID}`,
  )
})

test('does not open the wallet when profile readiness is unavailable', async ({ page }) => {
  let readinessRequests = 0
  await installApiMock(page, {
    signingReadiness: () => {
      readinessRequests += 1
      return 'unavailable'
    },
  })

  await page.goto('/schemas/register')
  await connectSyntheticWallet(page)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#schema-json').fill(JSON.stringify(SCHEMA, null, 2))
  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('transaction-preview')).toContainText('Payment')

  await page.getByTestId('transaction-sign').click()

  await expect(page.locator('.error-box')).toContainText('INDEXER_SIGNING_READINESS_UNAVAILABLE')
  await expect(page.getByTestId('xrpl-finality')).toHaveCount(0)
  consumeExpectedReadiness503(page)
  expect(readinessRequests).toBe(1)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
})

test('retains but does not submit a signature when readiness disappears after signing', async ({
  page,
}) => {
  let readinessRequests = 0
  await installApiMock(page, {
    signingReadiness: () => {
      readinessRequests += 1
      return readinessRequests === 1 ? 'ready' : 'unavailable'
    },
  })

  await page.goto('/schemas/register')
  await connectSyntheticWallet(page)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#schema-json').fill(JSON.stringify(SCHEMA, null, 2))
  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('transaction-preview')).toContainText('Payment')

  await page.getByTestId('transaction-sign').click()

  await expect(page.locator('.error-box')).toContainText('INDEXER_SIGNING_READINESS_UNAVAILABLE')
  await expect(page.getByTestId('xrpl-finality')).toHaveCount(0)
  consumeExpectedReadiness503(page)
  expect(readinessRequests).toBe(2)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 1, ledgerSubmissions: 0 })
  expect(await browserOperationPersistence(page)).toEqual([
    {
      stage: 'signed',
      hasTxBlob: true,
      hasTxHash: true,
      message: 'Final pre-submission validation failed; signed transaction retained for retry.',
    },
  ])
})

test('resumes a signed operation after reload without asking the wallet to sign again', async ({
  page,
}) => {
  let readinessRequests = 0
  await installApiMock(page, {
    signingReadiness: () => {
      readinessRequests += 1
      return 'ready'
    },
  })
  await seedSignedRecoveryOperation(page)

  const operation = page.getByTestId('operation-card').filter({ hasText: RECOVERY_TX_HASH }).first()
  await expect(operation).toContainText('signed')
  await operation.getByRole('button', { name: /Reprendre|Resume/u }).click()

  await expect(operation).toContainText('validated')
  await expect(operation).toContainText('tesSUCCESS')
  expect(readinessRequests).toBe(1)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 1 })
  expect(await browserOperationPersistence(page)).toEqual([
    { stage: 'validated', hasTxBlob: false, hasTxHash: true },
  ])
})

test('keeps a signed recovery operation when readiness is unavailable after reload', async ({
  page,
}) => {
  let readinessRequests = 0
  await installApiMock(page, {
    signingReadiness: () => {
      readinessRequests += 1
      return 'unavailable'
    },
  })
  await seedSignedRecoveryOperation(page)

  const operation = page.getByTestId('operation-card').filter({ hasText: RECOVERY_TX_HASH }).first()
  await expect(operation).toContainText('signed')
  await operation.getByRole('button', { name: /Reprendre|Resume/u }).click()

  await expect(page.locator('.error-box')).toContainText('INDEXER_SIGNING_READINESS_UNAVAILABLE')
  consumeExpectedReadiness503(page)
  expect(readinessRequests).toBe(1)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
  expect(await browserStoredRecoveryOperation(page)).toEqual({
    stage: 'signed',
    txBlob: RECOVERY_TX_BLOB,
    txHash: RECOVERY_TX_HASH,
    lastLedgerSequence: RECOVERY_LAST_LEDGER_SEQUENCE,
  })
})

test('rejects inconsistent signed recovery metadata without losing the blob', async ({ page }) => {
  let readinessRequests = 0
  await installApiMock(page, {
    signingReadiness: () => {
      readinessRequests += 1
      return 'ready'
    },
  })
  await seedSignedRecoveryOperation(page, { lastLedgerSequence: 1 })

  const operation = page.getByTestId('operation-card').filter({ hasText: RECOVERY_TX_HASH }).first()
  await expect(operation).toContainText('signed')
  await operation.getByRole('button', { name: /Reprendre|Resume/u }).click()

  await expect(page.locator('.error-box')).toContainText(
    'OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_MISMATCH',
  )
  expect(readinessRequests).toBe(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
  expect(await browserStoredRecoveryOperation(page)).toEqual({
    stage: 'signed',
    txBlob: RECOVERY_TX_BLOB,
    txHash: RECOVERY_TX_HASH,
    lastLedgerSequence: 1,
  })
})

test('blocks issuance before the wallet when the published payload cannot be fetched', async ({
  page,
}) => {
  await installApiMock(page)
  await page.goto('/issue')
  await expect(page.locator('#https-url')).toHaveValue('')
  await connectSyntheticWallet(page)
  await page.locator('#schema-uid').fill(SCHEMA_UID)
  await page.locator('#subject').fill(SUBJECT)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#claims').fill(JSON.stringify(CLAIMS, null, 2))

  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('issue-error')).toContainText(
    'Indiquez d’abord l’URL HTTPS publique définitive',
  )
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })

  await page.locator('#https-url').fill('https://issuer.example/credentials/replace-me.json')
  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('issue-error')).toContainText(
    'issuer.example est un exemple, pas un hébergement',
  )
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })

  await page.locator('#https-url').fill(PAYLOAD_URL)
  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialCreate')

  await page.evaluate((payloadUrl) => {
    const browserFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const requestUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (requestUrl === payloadUrl) throw new TypeError('Failed to fetch')
      return browserFetch(input, init)
    }
  }, PAYLOAD_URL)

  await page.getByTestId('transaction-sign').click()

  const issueError = page.getByTestId('issue-error')
  await expect(issueError).toContainText('Le navigateur n’a pas pu relire le payload')
  await expect(issueError).toContainText('PAYLOAD_FETCH_FAILED')
  await expect(page.getByTestId('transaction-preview')).toBeVisible()
  await expect(page.getByTestId('transaction-sign')).toBeEnabled()
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
})

test('stores, issues and reviews an IPFS-addressed payload in the local test browser', async ({
  page,
}) => {
  const canonicalPayload = canonicalJson({
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: SCHEMA_UID,
    claims: CLAIMS,
  } as JsonValue)
  const credentialUri = createIpfsPayloadUri(canonicalPayload)
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: null,
    state: 'pending',
    accepted: false,
    acceptedTransactionHash: null,
  }
  await installApiMock(page, {
    credentialEvidence: () => 'confirmed',
    credentialLifecycle,
    credentialUri,
  })

  await page.goto('/issue')
  await connectSyntheticWallet(page)
  await page.locator('#schema-uid').fill(SCHEMA_UID)
  await page.locator('#subject').fill(SUBJECT)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#claims').fill(JSON.stringify(CLAIMS, null, 2))
  await page.locator('#payload-storage-mode').selectOption('local-test')
  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('issue-error')).toContainText(
    'Confirmez l’avertissement du stockage local',
  )
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
  await page
    .getByLabel(/Je confirme que ce payload de test ne contient aucune donnée personnelle/u)
    .check()
  await page.getByRole('button', { name: 'Valider et préparer' }).click()

  await expect(page.getByTestId('local-payload-stored')).toBeVisible()
  await expect(page.getByText(credentialUri, { exact: true })).toBeVisible()
  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialCreate')
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith('xcs:local-test-payload:v1:'))
          .length,
    ),
  ).toBe(1)

  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('xcs:local-test-payload:v1:')) localStorage.removeItem(key)
    }
  })
  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('issue-error')).toContainText(
    'Ce payload local est absent ou expiré',
  )
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })

  await page.getByRole('button', { name: 'Valider et préparer' }).click()
  await expect(page.getByTestId('local-payload-stored')).toBeVisible()
  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 1, ledgerSubmissions: 1 })

  const generationId = credentialLifecycle.generationId
  if (!generationId) throw new Error('BROWSER_E2E_GENERATION_ID_MISSING')
  await expect(page.getByTestId('issue-credential-link')).toHaveAttribute(
    'href',
    `/credentials/${generationId}?profile=${PROFILE_ID}`,
  )

  const acceptHref = await page
    .getByRole('link', { name: /acceptation du sujet|subject acceptance/iu })
    .getAttribute('href')
  expect(acceptHref).not.toBeNull()
  await page.getByTestId('wallet-toggle').click()
  await page.goto(acceptHref!)
  await connectSyntheticWallet(page, 'subject')
  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()
  await expect(page.getByText(/conservé dans ce navigateur/u)).toBeVisible()
  await page.getByTestId('payload-consent').check()
  await page.getByTestId('issuer-trust-acknowledgement').getByRole('checkbox').check()
  await page
    .getByRole('button', { name: /Charger le payload et préparer|Fetch payload and prepare/u })
    .click()
  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialAccept')
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })

  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  expect(credentialLifecycle.state).toBe('active')
  expect(credentialLifecycle.accepted).toBe(true)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 1, ledgerSubmissions: 1 })

  await page.getByTestId('subject-result-permalink').click()
  await expect(page).toHaveURL(`/credentials/${generationId}?profile=${PROFILE_ID}`)
  await page.locator('[data-client-ready="true"]').waitFor()
  await expect(page.getByTestId('credential-consent')).toBeVisible()
  await page.getByTestId('credential-consent').getByRole('checkbox').check()
  await page.getByTestId('credential-consent').getByRole('button').click()
  await expect(page.getByTestId('credential-dimension-payload')).toContainText('valid')
  await expect(page.getByTestId('credential-payload-checked')).toContainText(
    sha256Hex(encodeUtf8(canonicalPayload)),
  )
})

test('does not mislabel an unavailable external IPFS CID as browser-local', async ({ page }) => {
  const canonicalPayload = canonicalJson({
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: SCHEMA_UID,
    claims: CLAIMS,
  } as JsonValue)
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: PERMALINK_GENERATION_ID,
    state: 'pending',
    accepted: false,
    acceptedTransactionHash: null,
  }
  await installApiMock(page, {
    credentialLifecycle,
    credentialUri: createIpfsPayloadUri(canonicalPayload),
  })

  await page.goto(
    `/accept?profile=${PROFILE_ID}&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=${PERMALINK_GENERATION_ID}`,
  )
  await connectSyntheticWallet(page, 'subject')
  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()

  await expect(
    page.getByText(/Ce CID IPFS n’est pas disponible|This IPFS CID is unavailable/u),
  ).toBeVisible()
  await expect(page.getByText(/conservé dans ce navigateur|stored in this browser/u)).toHaveCount(0)
  await expect(page.getByTestId('payload-consent')).toHaveCount(0)
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
})

test('rejects the issuer wallet before looking up a subject-owned credential', async ({ page }) => {
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: PERMALINK_GENERATION_ID,
    state: 'pending',
    accepted: false,
    acceptedTransactionHash: null,
  }
  await installApiMock(page, {
    credentialLifecycle,
    credentialUri: CREDENTIAL_URI,
  })
  let wrongTupleRequests = 0
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.includes(`/credentials/${ISSUER}/${ISSUER}/${SCHEMA_UID}`)
    ) {
      wrongTupleRequests += 1
    }
  })

  await page.goto(
    `/accept?profile=${PROFILE_ID}&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=${PERMALINK_GENERATION_ID}&action=accept`,
  )
  await connectSyntheticWallet(page, 'issuer')
  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()

  await expect(page.getByTestId('accept-error')).toContainText(
    /wallet connecté n’est pas le sujet|connected wallet is not the subject/u,
  )
  expect(wrongTupleRequests).toBe(0)
  expect(await browserE2eEffects(page)).toEqual({ walletSignatures: 0, ledgerSubmissions: 0 })
})

test('issues, reconfirms, then accepts a credential with exact indexed evidence', async ({
  page,
}) => {
  let evidence: 'confirmed' | 'mismatch' = 'mismatch'
  const canonicalPayload = canonicalJson({
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: SCHEMA_UID,
    claims: CLAIMS,
  } as JsonValue)
  const credentialUri = createHttpsPayloadUri(PAYLOAD_URL, canonicalPayload)
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: null,
    state: 'pending',
    accepted: false,
    acceptedTransactionHash: null,
  }
  await installApiMock(page, {
    credentialEvidence: () => evidence,
    credentialLifecycle,
    credentialUri,
  })
  let payloadRequestCount = 0
  await page.route(PAYLOAD_URL, async (route) => {
    payloadRequestCount += 1
    await route.fulfill({
      body: canonicalPayload,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
    })
  })

  await page.goto('/issue')
  await connectSyntheticWallet(page)
  await page.locator('#schema-uid').fill(SCHEMA_UID)
  await page.locator('#subject').fill(SUBJECT)
  await page.getByRole('button', { name: 'Mode JSON' }).click()
  await page.locator('#claims').fill(JSON.stringify(CLAIMS, null, 2))
  await page.locator('#https-url').fill(PAYLOAD_URL)
  await page.getByRole('button', { name: 'Valider et préparer' }).click()

  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialCreate')
  await page.getByTestId('transaction-sign').click()

  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-mismatch')).toBeVisible()

  evidence = 'confirmed'
  await page.goto('/operations')
  const operation = page
    .getByTestId('operation-card')
    .filter({ hasText: 'CredentialCreate' })
    .first()
  await expect(operation.getByTestId('operation-xcs-result')).toContainText('mismatch')
  await operation.getByTestId('operation-reconfirm').click()
  await expect(operation.getByTestId('operation-xcs-result')).toContainText('confirmed')
  await expect(operation).toContainText('Generation ID')
  const payloadRequestsAfterIssuance = payloadRequestCount

  await page.getByTestId('wallet-toggle').click()
  await operation.getByRole('link', { name: /Acceptation du sujet|Subject acceptance/u }).click()
  await expect(page).toHaveURL(
    new RegExp(
      `/accept\\?profile=${PROFILE_ID}&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=[0-9a-f]{64}$`,
      'u',
    ),
  )
  await connectSyntheticWallet(page, 'subject')

  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()
  await expect(
    page.getByRole('heading', {
      name: /Relecture du credential exact|Exact credential review/u,
    }),
  ).toBeVisible()
  expect(payloadRequestCount).toBe(payloadRequestsAfterIssuance)

  const payloadConsent = page.getByLabel(
    /Je consens explicitement au chargement|I explicitly consent to fetching/u,
  )
  const trustAcknowledgement = page
    .getByTestId('issuer-trust-acknowledgement')
    .getByRole('checkbox')
  await expect(payloadConsent).not.toBeChecked()
  await expect(trustAcknowledgement).not.toBeChecked()
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  await payloadConsent.check()
  await page
    .getByRole('button', { name: /Charger le payload et préparer|Fetch payload and prepare/u })
    .click()
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
  await expect(page.getByTestId('transaction-sign')).toHaveCount(0)
  await expect(
    page.getByText(/Confirmez votre propre décision de confiance|Confirm your own trust decision/u),
  ).toBeVisible()
  await trustAcknowledgement.check()
  await page
    .getByRole('button', { name: /Charger le payload et préparer|Fetch payload and prepare/u })
    .click()

  const preview = page.getByTestId('transaction-preview')
  await expect(preview).toContainText('CredentialAccept')
  await expect(preview).toContainText(SUBJECT)
  await expect(preview).toContainText(ISSUER)
  await expect(preview).toContainText(SCHEMA_UID.toUpperCase())
  expect(payloadRequestCount).toBeGreaterThan(payloadRequestsAfterIssuance)
  const payloadRequestsBeforeSign = payloadRequestCount
  await page.getByTestId('transaction-sign').click()

  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  expect(payloadRequestCount).toBe(payloadRequestsBeforeSign + 1)
  expect(credentialLifecycle.state).toBe('active')
  expect(credentialLifecycle.acceptedTransactionHash).toMatch(/^[0-9a-f]{64}$/u)

  await page.goto('/operations')
  const acceptanceOperation = page
    .getByTestId('operation-card')
    .filter({ hasText: 'CredentialAccept' })
    .first()
  await expect(acceptanceOperation.getByTestId('operation-xcs-result')).toContainText('confirmed')
  const downloadPromise = page.waitForEvent('download')
  await page
    .getByRole('button', { name: /Exporter les reçus minimisés|Export sanitized receipts/u })
    .click()
  const exportedReceipts = await downloadText(await downloadPromise)
  expect(exportedReceipts).not.toContain('"claims"')
  expect(exportedReceipts).not.toContain('"txBlob"')
  expect(exportedReceipts).not.toContain('"issuerTrust"')
  expect(exportedReceipts).not.toContain(canonicalPayload)
  const receiptExport = JSON.parse(exportedReceipts) as {
    receipts: Array<Record<string, unknown>>
  }
  const acceptanceReceipt = receiptExport.receipts.find(
    (receipt) => receipt.transactionType === 'CredentialAccept',
  )
  expect(acceptanceReceipt).toMatchObject({
    account: SUBJECT,
    transactionType: 'CredentialAccept',
    businessConfirmation: 'confirmed',
    business: {
      action: 'credential-accept',
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: SCHEMA_UID,
      generationId: credentialLifecycle.generationId,
    },
    businessEvidence: {
      transactionHash: credentialLifecycle.acceptedTransactionHash,
      generationId: credentialLifecycle.generationId,
      eventType: 'accepted',
      accepted: true,
    },
  })

  await acceptanceOperation.getByTestId('operation-credential-link').click()
  await expect(page).toHaveURL(
    `/credentials/${credentialLifecycle.generationId}?profile=${PROFILE_ID}`,
  )
  await page.locator('[data-client-ready="true"]').waitFor()
  const removeLink = page.getByTestId('credential-subject-action')
  await expect(removeLink).toContainText(/Retirer cette génération|Remove this generation/u)
  await expect(removeLink).toHaveAttribute(
    'href',
    `/accept?profile=${PROFILE_ID}&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=${credentialLifecycle.generationId}&action=remove`,
  )

  let subjectMutationVerifyRequests = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === `${API_PREFIX}/v1/verify`) {
      subjectMutationVerifyRequests += 1
    }
  })
  const payloadRequestsBeforeRemoval = payloadRequestCount
  await removeLink.click()
  await expect(page).toHaveURL(/action=remove$/u)
  await connectSyntheticWallet(page, 'subject')
  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()

  const removalPreview = page.getByTestId('transaction-preview')
  await expect(removalPreview).toContainText('CredentialDelete')
  await expect(removalPreview).toContainText(SUBJECT)
  await expect(removalPreview).toContainText(ISSUER)
  await expect(page.getByTestId('issuer-trust-acknowledgement')).toHaveCount(0)
  await expect(page.getByLabel(/consens|consent/iu)).toHaveCount(0)
  expect(subjectMutationVerifyRequests).toBe(0)
  expect(payloadRequestCount).toBe(payloadRequestsBeforeRemoval)

  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('xrpl-finality')).toContainText('tesSUCCESS')
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  await expect(page.getByTestId('business-finality')).toContainText('deleted')
  await expect(page.getByTestId('business-finality')).toContainText('subject_removed')
  expect(subjectMutationVerifyRequests).toBe(0)
  expect(payloadRequestCount).toBe(payloadRequestsBeforeRemoval)
  expect(credentialLifecycle.state).toBe('deleted')
  expect(credentialLifecycle.removedTransactionHash).toMatch(/^[0-9a-f]{64}$/u)

  await page.getByTestId('subject-result-permalink').click()
  await expect(page).toHaveURL(
    `/credentials/${credentialLifecycle.generationId}?profile=${PROFILE_ID}`,
  )
  await expect(page.getByText('deleted', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('subject_removed', { exact: true })).toBeVisible()
  await expect(page.getByTestId('credential-subject-action')).toHaveCount(0)
  expect(payloadRequestCount).toBe(payloadRequestsBeforeRemoval)

  await page.goto('/operations')
  const removalOperation = page
    .getByTestId('operation-card')
    .filter({ hasText: 'credential-remove' })
    .first()
  await expect(removalOperation.getByTestId('operation-xcs-result')).toContainText('confirmed')
  const removalDownloadPromise = page.waitForEvent('download')
  await page
    .getByRole('button', { name: /Exporter les reçus minimisés|Export sanitized receipts/u })
    .click()
  const removalExport = JSON.parse(await downloadText(await removalDownloadPromise)) as {
    receipts: Array<Record<string, unknown>>
  }
  const removalReceipt = removalExport.receipts.find(
    (receipt) =>
      (receipt.business as { action?: string } | undefined)?.action === 'credential-remove',
  )
  expect(removalReceipt).toMatchObject({
    receiptVersion: '0.2',
    account: SUBJECT,
    transactionType: 'CredentialDelete',
    businessConfirmation: 'confirmed',
    business: {
      action: 'credential-remove',
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: SCHEMA_UID,
      generationId: credentialLifecycle.generationId,
    },
    businessEvidence: {
      transactionHash: credentialLifecycle.removedTransactionHash,
      generationId: credentialLifecycle.generationId,
      eventType: 'deleted',
      accepted: true,
      deletionCause: 'subject_removed',
    },
  })
})

test('rejects a pending credential without loading payload or trust', async ({ page }) => {
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: PERMALINK_GENERATION_ID,
    state: 'pending',
    accepted: false,
    acceptedTransactionHash: null,
  }
  await installApiMock(page, {
    credentialLifecycle,
    credentialUri: CREDENTIAL_URI,
    pendingCredentialRejection: true,
  })
  let payloadRequestCount = 0
  let verifyRequestCount = 0
  await page.route(PAYLOAD_URL, async (route) => {
    payloadRequestCount += 1
    await route.abort('blockedbyclient')
  })
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `${API_PREFIX}/v1/verify`
    ) {
      verifyRequestCount += 1
    }
  })

  await page.goto(
    `/accept?profile=${PROFILE_ID}&issuer=${ISSUER}&schema=${SCHEMA_UID}&generation=${PERMALINK_GENERATION_ID}&action=reject`,
  )
  await connectSyntheticWallet(page, 'subject')
  await page
    .getByRole('button', { name: /Charger, relire et préparer|Load, review and prepare/u })
    .click()

  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialDelete')
  await expect(page.getByTestId('issuer-trust-acknowledgement')).toHaveCount(0)
  await expect(page.getByLabel(/consens|consent/iu)).toHaveCount(0)
  expect(payloadRequestCount).toBe(0)
  expect(verifyRequestCount).toBe(0)

  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  await expect(page.getByTestId('business-finality')).toContainText('deleted')
  await expect(page.getByTestId('business-finality')).toContainText('subject_rejected')
  expect(payloadRequestCount).toBe(0)
  expect(verifyRequestCount).toBe(0)
  expect(credentialLifecycle.state).toBe('deleted')
})

test('returns an issuer revocation to the exact deleted generation', async ({ page }) => {
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: PERMALINK_GENERATION_ID,
    state: 'active',
    accepted: true,
    acceptedTransactionHash: PERMALINK_ACCEPTED_TRANSACTION_HASH,
  }
  await installApiMock(page, {
    credentialLifecycle,
    credentialUri: CREDENTIAL_URI,
    credentialDeletionCause: 'issuer_revoked',
  })

  await page.goto(
    `/revoke?profile=${PROFILE_ID}&subject=${SUBJECT}&schema=${SCHEMA_UID}&generation=${PERMALINK_GENERATION_ID}`,
  )
  await connectSyntheticWallet(page)
  await page
    .getByRole('button', { name: /Charger et préparer la révocation|Load and prepare revocation/u })
    .click()
  await expect(page.getByTestId('transaction-preview')).toContainText('CredentialDelete')

  await page.getByTestId('transaction-sign').click()
  await expect(page.getByTestId('xcs-confirmed')).toBeVisible()
  await expect(page.getByTestId('business-finality')).toContainText('issuer_revoked')
  expect(credentialLifecycle.state).toBe('deleted')

  const permalink = page.getByTestId('revoke-result-permalink')
  await expect(permalink).toHaveAttribute(
    'href',
    `/credentials/${PERMALINK_GENERATION_ID}?profile=${PROFILE_ID}`,
  )
  await permalink.click()
  await expect(page).toHaveURL(`/credentials/${PERMALINK_GENERATION_ID}?profile=${PROFILE_ID}`)
  await expect(page.getByText('deleted', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('issuer_revoked', { exact: true })).toBeVisible()
})

test('reveals an exact diploma permalink only after bound payload consent', async ({ page }) => {
  const credentialLifecycle: BrowserCredentialLifecycle = {
    generationId: PERMALINK_GENERATION_ID,
    state: 'active',
    accepted: true,
    acceptedTransactionHash: PERMALINK_ACCEPTED_TRANSACTION_HASH,
  }
  await installApiMock(page, {
    credentialLifecycle,
    credentialUri: CREDENTIAL_URI,
  })

  let payloadRequestCount = 0
  const requestTrace: string[] = []
  const verifyBodies: Record<string, unknown>[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.href === PAYLOAD_URL) {
      requestTrace.push('issuer')
      return
    }
    if (!url.pathname.startsWith(`${API_PREFIX}/v1/`)) return
    const apiPath = url.pathname.slice(API_PREFIX.length)
    if (apiPath === '/v1/networks') requestTrace.push('networks')
    if (apiPath.includes('/credential-generations/')) requestTrace.push('generation')
    if (apiPath.includes('/schemas/')) requestTrace.push('schema')
    if (apiPath === '/v1/verify') {
      const body = request.postDataJSON() as Record<string, unknown>
      verifyBodies.push(body)
      requestTrace.push(Object.hasOwn(body, 'payload') ? 'verify:payload' : 'verify:metadata')
    }
  })
  await page.route(PAYLOAD_URL, async (route) => {
    payloadRequestCount += 1
    await route.fulfill({
      body: CANONICAL_PAYLOAD,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
    })
  })

  await page.goto(`/credentials/${PERMALINK_GENERATION_ID}`)
  await page.locator('[data-client-ready="true"]').waitFor()
  await expect(page.getByRole('heading', { level: 1, name: SCHEMA.name })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow')
  await expect(page.getByTestId('credential-dimension-on-chain')).toContainText('active')
  await expect(page.getByTestId('credential-dimension-schema')).toContainText('valid')
  await expect(page.getByTestId('credential-dimension-payload')).toContainText('not_checked')
  await expect(page.getByTestId('credential-dimension-trust')).toContainText('unknown')
  await expect(page.getByTestId('credential-claims')).toHaveCount(0)
  expect(payloadRequestCount).toBe(0)

  const consent = page
    .getByTestId('credential-consent')
    .getByRole('checkbox', { name: /Je consens au chargement|I consent to fetching/u })
  await expect(consent).not.toBeChecked()
  await consent.check()
  expect(payloadRequestCount).toBe(0)
  const postConsentTraceStart = requestTrace.length
  await page
    .getByRole('button', {
      name: /Charger et vérifier le payload public|Fetch and verify public payload/u,
    })
    .click()

  await expect(page.getByTestId('credential-payload-checked')).toBeVisible()
  await expect(page.getByTestId('credential-claims')).toBeVisible()
  expect(payloadRequestCount).toBe(1)
  const postConsentTrace = requestTrace.slice(postConsentTraceStart)
  const issuerIndex = postConsentTrace.indexOf('issuer')
  expect(issuerIndex).toBeGreaterThan(-1)
  for (const metadataRequest of ['networks', 'generation', 'schema', 'verify:metadata']) {
    const metadataIndex = postConsentTrace.indexOf(metadataRequest)
    expect(metadataIndex, `${metadataRequest} must be re-read before issuer fetch`).toBeGreaterThan(
      -1,
    )
    expect(metadataIndex).toBeLessThan(issuerIndex)
  }
  expect(postConsentTrace.indexOf('verify:payload')).toBeGreaterThan(issuerIndex)
  expect(verifyBodies.some((body) => body.resolvePayload === true)).toBe(false)
  const payloadVerifications = verifyBodies.filter((body) => Object.hasOwn(body, 'payload'))
  expect(payloadVerifications).toHaveLength(1)
  expect(payloadVerifications[0]).toEqual({
    network: PROFILE_ID,
    issuer: ISSUER,
    subject: SUBJECT,
    schemaUid: SCHEMA_UID,
    payload: JSON.parse(CANONICAL_PAYLOAD),
  })

  for (const [name, type, value] of [
    ['programId', 'string', CLAIMS.programId],
    ['programName', 'string', CLAIMS.programName],
    ['awardedAt', 'string', CLAIMS.awardedAt],
    ['diplomaId', 'string', CLAIMS.diplomaId],
    ['prenom', 'string', CLAIMS.prenom],
    ['honors', 'string', CLAIMS.honors],
  ] as const) {
    const row = page.getByTestId(`credential-claim-${name}`)
    await expect(row).toContainText(type)
    await expect(row).toContainText(value)
  }
  await expect(page.getByTestId('credential-dimension-on-chain')).toContainText('active')
  await expect(page.getByTestId('credential-dimension-schema')).toContainText('valid')
  await expect(page.getByTestId('credential-dimension-payload')).toContainText('valid')
  await expect(page.getByTestId('credential-dimension-trust')).toContainText('unknown')
})

test('keeps a replaced historical generation readable without payload consent', async ({
  page,
}) => {
  await installApiMock(page, {
    credentialLifecycle: {
      generationId: PERMALINK_GENERATION_ID,
      state: 'active',
      accepted: true,
      acceptedTransactionHash: PERMALINK_ACCEPTED_TRANSACTION_HASH,
    },
    credentialUri: CREDENTIAL_URI,
  })
  let payloadRequestCount = 0
  await page.route(PAYLOAD_URL, async (route) => {
    payloadRequestCount += 1
    await route.fulfill({
      body: CANONICAL_PAYLOAD,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
    })
  })

  await page.goto(`/credentials/${HISTORICAL_GENERATION_ID}`)
  await page.locator('[data-client-ready="true"]').waitFor()
  await expect(page.getByRole('heading', { level: 1, name: SCHEMA.name })).toBeVisible()
  await expect(
    page.locator('.explorer-metadata').getByText(HISTORICAL_GENERATION_ID, { exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('credential-verification-unavailable')).toBeVisible()
  await expect(page.getByTestId('credential-consent')).toHaveCount(0)
  await expect(page.getByTestId('credential-dimensions')).toHaveCount(0)
  await expect(page.getByTestId('credential-subject-action')).toHaveCount(0)
  await expect(page.getByText('issuer_revoked', { exact: true })).toBeVisible()
  expect(payloadRequestCount).toBe(0)
})
