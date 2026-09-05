import { expect, test, type Page } from '@playwright/test'
import {
  canonicalJson,
  computeSchemaUid,
  type JsonValue,
  type SchemaDefinition,
} from '@xcs-protocol/core'

const API_PREFIX = '/__e2e-api'
const PROFILE_ID = 'xrpl-testnet-xcs-browser-e2e'
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const GENERATION_ID = '34'.repeat(32)
const NO_URI_GENERATION_ID = '9a'.repeat(32)
const HISTORICAL_GENERATION_ID = '56'.repeat(32)
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
  schema: SCHEMA,
  networkId: 1,
  ledgerHash: LEDGER_HASH,
  ledgerIndex: 100_001,
  transactionIndex: 1,
  publisher: ISSUER,
})
const PAYLOAD = canonicalJson({
  xcsVersion: '0.1',
  issuer: ISSUER,
  subject: SUBJECT,
  schema: SCHEMA_UID,
  claims: {
    programId: 'xcs-protocol-engineering-2026',
    programName: 'Protocol Engineering',
    awardedAt: '2026-08-25T10:00:00Z',
    diplomaId: 'DIP-2026-0042',
    prenom: 'Personne Test',
    honors: 'with distinction',
  },
} as JsonValue)

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

test('runs the privacy-explicit exact-generation quickstart and shows four dimensions', async ({
  page,
}) => {
  const apiPaths: string[] = []
  const verifyBodies: Record<string, unknown>[] = []
  let issuerHostRequests = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname === 'issuer.xcs.invalid') issuerHostRequests += 1
    if (!url.pathname.startsWith(`${API_PREFIX}/v1/`)) return
    apiPaths.push(url.pathname.slice(API_PREFIX.length))
    if (request.method() === 'POST' && url.pathname === `${API_PREFIX}/v1/verify`) {
      verifyBodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })

  await page.goto('/en/developers')
  await page.locator('[data-client-ready="true"]').waitFor()
  await expect(page.getByTestId('developer-api-base')).toContainText(API_PREFIX)
  await expect(page.getByTestId('developer-profile-id')).toHaveText(PROFILE_ID)

  await page.getByTestId('developer-generation-input').fill(GENERATION_ID)
  await page.getByTestId('developer-load-generation').click()
  await expect(page.getByTestId('developer-evidence')).toContainText(GENERATION_ID)
  await expect(page.getByTestId('developer-evidence')).toContainText('not_checked')

  await page.getByTestId('developer-payload-input').fill(PAYLOAD)
  await page.getByTestId('developer-verify-payload').click()
  await expect(page.getByTestId('developer-dimensions')).toBeVisible()
  await expect(page.getByTestId('developer-dimension-on-chain')).toContainText('active')
  await expect(page.getByTestId('developer-dimension-schema')).toContainText('valid')
  await expect(page.getByTestId('developer-dimension-payload')).toContainText('valid')
  await expect(page.getByTestId('developer-dimension-trust')).toContainText('unknown')

  await page.getByTestId('developer-payload-input').fill(`${PAYLOAD} `)
  await expect(page.getByTestId('developer-dimensions')).toHaveCount(0)

  expect(verifyBodies).toHaveLength(3)
  for (const body of verifyBodies.slice(0, 2)) {
    expect(body).toMatchObject({
      network: PROFILE_ID,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: SCHEMA_UID,
      resolvePayload: false,
    })
    expect(Object.hasOwn(body, 'payload')).toBe(false)
  }
  expect(verifyBodies[2]).toEqual({
    network: PROFILE_ID,
    issuer: ISSUER,
    subject: SUBJECT,
    schemaUid: SCHEMA_UID,
    payload: JSON.parse(PAYLOAD),
  })
  expect(Object.hasOwn(verifyBodies[2]!, 'resolvePayload')).toBe(false)
  expect(apiPaths.filter((path) => path.includes('/credential-generations/'))).toHaveLength(2)
  expect(apiPaths.some((path) => path.includes(`/credentials/${ISSUER}`))).toBe(false)
  expect(issuerHostRequests).toBe(0)

  await expect(page.getByText('const GENERATION_ID = "3434', { exact: false })).toBeVisible()
  await expect(page.getByText('type Signer', { exact: false })).toBeVisible()
})

test('never restores a stale report when the payload changes during verification', async ({
  page,
}) => {
  let signalRequestStarted!: () => void
  let releaseResponse!: () => void
  const requestStarted = new Promise<void>((resolve) => {
    signalRequestStarted = resolve
  })
  const responseReleased = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })

  await page.route(`**${API_PREFIX}/v1/verify`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    if (Object.hasOwn(body, 'payload')) {
      signalRequestStarted()
      await responseReleased
    }
    await route.continue()
  })

  await page.goto('/en/developers')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.getByTestId('developer-generation-input').fill(GENERATION_ID)
  await page.getByTestId('developer-load-generation').click()
  await expect(page.getByTestId('developer-evidence')).toBeVisible()
  await page.getByTestId('developer-payload-input').fill(PAYLOAD)
  await page.getByTestId('developer-verify-payload').click()
  await requestStarted

  await page.getByTestId('developer-payload-input').evaluate((textarea) => {
    const input = textarea as HTMLTextAreaElement
    input.value = `${input.value} `
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  releaseResponse()

  await expect(page.getByTestId('developer-error')).toContainText('DEVELOPER_FLOW_CHANGED')
  await expect(page.getByTestId('developer-dimensions')).toHaveCount(0)
})

test('keeps a generation without a URI metadata-only', async ({ page }) => {
  const verifyBodies: Record<string, unknown>[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === `${API_PREFIX}/v1/verify`) {
      verifyBodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })

  await page.goto('/en/developers')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.getByTestId('developer-generation-input').fill(NO_URI_GENERATION_ID)
  await page.getByTestId('developer-load-generation').click()

  await expect(page.getByTestId('developer-evidence')).toContainText('not_checked')
  await expect(page.getByTestId('developer-no-payload-uri')).toBeVisible()
  await expect(page.getByTestId('developer-payload-input')).toHaveCount(0)
  await expect(page.getByText('credentialHexToUri', { exact: false })).toHaveCount(0)
  expect(verifyBodies).toHaveLength(1)
  expect(verifyBodies[0]).toMatchObject({ resolvePayload: false, subject: ISSUER })
  expect(Object.hasOwn(verifyBodies[0]!, 'payload')).toBe(false)
})

test('fails closed before payload input when an exact generation was replaced', async ({
  page,
}) => {
  const verifyBodies: Record<string, unknown>[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname === `${API_PREFIX}/v1/verify`) {
      verifyBodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })

  await page.goto('/en/developers')
  await page.locator('[data-client-ready="true"]').waitFor()
  await page.getByTestId('developer-generation-input').fill(HISTORICAL_GENERATION_ID)
  await page.getByTestId('developer-load-generation').click()

  await expect(page.getByTestId('developer-error')).toContainText('DEVELOPER_GENERATION_REPLACED')
  await expect(page.getByTestId('developer-evidence')).toHaveCount(0)
  await expect(page.getByTestId('developer-payload-input')).toHaveCount(0)
  expect(verifyBodies).toHaveLength(1)
  expect(verifyBodies[0]).toMatchObject({ resolvePayload: false })
  expect(Object.hasOwn(verifyBodies[0]!, 'payload')).toBe(false)
})
