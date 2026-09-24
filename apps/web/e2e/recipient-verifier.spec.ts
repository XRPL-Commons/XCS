import { expect, test, type Page } from '@playwright/test'
import { Wallet } from 'xrpl'
import { sign as signMessage, verify as verifyMessage } from 'ripple-keypairs'

const profileId = 'xrpl-testnet-xcs-browser-e2e'
const generationId = 'b'.repeat(64)
const organizationId = '00000000-0000-4000-8000-000000000071'
const presentationId = '00000000-0000-4000-8000-000000000072'
const token = 'r'.repeat(43)
const proofWallet = Wallet.fromEntropy(Uint8Array.from({ length: 16 }, (_, index) => 31 - index))
const credential = {
  profileId,
  generationId,
  schemaUid: 'a'.repeat(64),
  schemaName: 'Synthetic course completion',
  organizationId,
  organizationName: 'Synthetic school',
  issuerAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  subjectAddress: proofWallet.classicAddress,
  networkId: 1,
  visibility: 'private',
  createdAt: '2026-09-24T10:00:00Z',
  creationTransactionHash: 'c'.repeat(64),
  status: {
    state: 'active',
    accepted: true,
    expiration: null,
    deletedLedgerIndex: null,
    deletionCause: null,
  },
  events: [],
  disclosure: { publicFields: ['course'], fields: ['course', 'name'] },
}
const presentation = {
  id: presentationId,
  profileId,
  generationId,
  scope: 'full',
  verifierOrganizationId: organizationId,
  verifierOrganizationName: 'Synthetic verifier',
  createdAt: '2026-09-24T10:00:00Z',
  revokedAt: null,
}
const report = {
  onChain: 'active',
  schema: 'valid',
  payload: 'not_checked',
  issuerTrust: 'unknown',
}
const publicResult = {
  presentation,
  credential,
  scope: 'public',
  claims: { course: 'Synthetic course' },
  verification: report,
  requiresAuthorization: true,
  issuerAdmission: {
    status: 'approved',
    organizationId,
    checkedAt: '2026-09-24T10:00:00Z',
    reviewedAt: '2026-09-23T10:00:00Z',
  },
  holderProof: { status: 'not_provided' },
}

async function prepareProofWallet(page: Page) {
  await page.addInitScript(() => {
    ;(
      globalThis as typeof globalThis & { __xcsBrowserE2eAuthWallet?: boolean }
    ).__xcsBrowserE2eAuthWallet = true
  })
  const challenges: { id: string; message: string }[] = []
  await page.route('**/api/recipient/presentation-challenges', (route) => {
    const input = route.request().postDataJSON()
    const challenge = {
      id: `00000000-0000-4000-8000-${String(challenges.length + 1).padStart(12, '0')}`,
      message: `Synthetic presentation ownership proof ${challenges.length + 1}: ${JSON.stringify(input)}`,
    }
    challenges.push(challenge)
    return route.fulfill({
      json: {
        ...challenge,
        presentationId,
        address: credential.subjectAddress,
        networkId: 1,
        expiresAt: '2099-09-24T10:00:00Z',
      },
    })
  })
  return challenges
}
async function connectProofWallet(page: Page) {
  await page.getByTestId('presentation-wallet-toggle').click()
  await page.getByTestId('presentation-wallet-menu').locator('[data-wallet-id="gemwallet"]').click()
  await expect(page.getByTestId('presentation-wallet-status')).toContainText('Connected')
}

async function session(page: Page, signedIn = true) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        ...(signedIn ? { csrfToken: 'synthetic-recipient-csrf' } : {}),
        user: signedIn
          ? {
              id: '00000000-0000-4000-8000-000000000073',
              displayName: 'Synthetic person',
              email: 'synthetic@example.test',
              roles: ['recipient'],
              organizations: [
                { id: organizationId, name: 'Synthetic verifier', roles: ['verifier'] },
              ],
              wallets: [],
            }
          : null,
      },
    }),
  )
}
async function enter(page: Page, path: string) {
  await page.goto(path.startsWith('/fr/') ? '/fr' : '/')
  await expect(page.locator('[data-client-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(async (path) => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push(path)
  }, path)
}

// Synthetic browser fixtures check visible consent and disclosure, not PostgreSQL authorization or real wallets.
test('requires explicit opening, keeps the bearer out of URLs and reports a public subset as partial on mobile', async ({
  page,
}) => {
  const consoleMessages: string[] = []
  page.on('console', (message) => consoleMessages.push(message.text()))
  await page.setViewportSize({ width: 390, height: 844 })
  await session(page, false)
  let opens = 0
  await page.route('**/api/presentations/resolve', (route) => {
    opens += 1
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({ token })
    expect(route.request().url()).not.toContain(token)
    return route.fulfill({ json: publicResult })
  })
  await enter(page, `/presentations#${token}`)
  await expect(page.getByRole('button', { name: 'Open presentation', exact: true })).toBeVisible()
  expect(opens).toBe(0)
  expect(page.url()).not.toContain(token)
  expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(token)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Partially checked', exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic course', { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic private person')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Who issued it?', exact: true })).toContainText(
    'Issuer organization approved for this portal',
  )
  await expect(
    page.getByRole('region', { name: 'Has it been accepted?', exact: true }),
  ).toContainText('The recipient accepted this attestation with their wallet.')
  await expect(
    page.getByText('No signed wallet proof was provided for this link.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Only the shared information is shown.', { exact: false }),
  ).toBeVisible()
  const limitation = page.getByText('These checks confirm the available records and signatures.', {
    exact: false,
  })
  expect(
    (await limitation.boundingBox())!.y + (await limitation.boundingBox())!.height,
  ).toBeLessThan(844)
  expect(
    await page.evaluate(
      (value) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      token,
    ),
  ).toBe(false)
  expect(consoleMessages.join('\n')).not.toContain(token)
})

test('distinguishes Commons approval, ledger acceptance and a dated wallet signature from technical issuer trust', async ({
  page,
}) => {
  await session(page, false)
  const message = 'Synthetic presentation authorization bound to this recipient and link'
  await page.route('**/api/presentations/resolve', (route) =>
    route.fulfill({
      json: {
        ...publicResult,
        requiresAuthorization: false,
        verification: { ...report, payload: 'valid' },
        holderProof: {
          status: 'verified',
          address: credential.subjectAddress,
          networkId: 1,
          verifiedAt: '2026-09-24T10:00:00Z',
          message,
          signature: signMessage(Buffer.from(message).toString('hex'), proofWallet.privateKey),
          publicKey: proofWallet.publicKey,
          scheme: 'ripple',
          purpose: 'presentation_authorization',
          keyAuthority: 'master_key_address_only',
        },
      },
    }),
  )
  await enter(page, `/presentations#${token}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Issuer trust not established', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Who issued it?', exact: true })).toContainText(
    'Issuer organization approved for this portal',
  )
  const ledger = page.getByRole('region', {
    name: 'Has it been accepted?',
    exact: true,
  })
  await expect(ledger).toContainText('The recipient accepted this attestation with their wallet.')
  await expect(ledger).toContainText('accepted')
  const proof = page.getByRole('region', {
    name: 'Who authorized this link?',
    exact: true,
  })
  await expect(proof).toContainText('Wallet signature verified when this link was authorized')
  await expect(proof).toContainText('2026')
  await expect(proof).not.toContainText('No signed wallet proof')
  await expect(page.getByText(message, { exact: false })).not.toBeVisible()
})

test('clears previously disclosed claims when a presentation is revoked', async ({ page }) => {
  await session(page)
  let opens = 0
  await page.route('**/api/presentations/resolve', (route) => {
    opens += 1
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-recipient-csrf')
    return opens === 1
      ? route.fulfill({
          json: {
            ...publicResult,
            scope: 'full',
            claims: { name: 'Synthetic private person' },
            requiresAuthorization: false,
            verification: { ...report, payload: 'valid' },
          },
        })
      : route.fulfill({ status: 404, json: { statusCode: 404 } })
  })
  await enter(page, `/presentations#${token}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByText('Synthetic private person', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Issuer trust not established', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Check again', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Presentation unavailable', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Synthetic private person', { exact: true })).toHaveCount(0)
})

test('opens successive native and router fragment links in the same component without retaining the previous result', async ({
  page,
}) => {
  await session(page, false)
  const tokens = [token, 's'.repeat(43), 't'.repeat(43)]
  const requested: string[] = []
  const consoleMessages: string[] = []
  page.on('console', (message) => consoleMessages.push(message.text()))
  await page.route('**/api/presentations/resolve', (route) => {
    const currentToken = route.request().postDataJSON().token as string
    requested.push(currentToken)
    return route.fulfill({
      json: {
        ...publicResult,
        claims: { course: `Synthetic course ${tokens.indexOf(currentToken)}` },
      },
    })
  })
  await enter(page, `/presentations#${tokens[0]}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByText('Synthetic course 0', { exact: true })).toBeVisible()
  await page.goto(`/presentations#${tokens[1]}`)
  await expect(page.getByRole('button', { name: 'Open presentation', exact: true })).toBeEnabled()
  await expect(page.getByText('Synthetic course 0', { exact: true })).toHaveCount(0)
  expect(requested).toEqual([tokens[0]])
  expect(new URL(page.url()).hash).toBe('')
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByText('Synthetic course 1', { exact: true })).toBeVisible()
  await page.evaluate(async (path) => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push(path)
  }, `/presentations#${tokens[2]}`)
  await expect(page.getByRole('button', { name: 'Open presentation', exact: true })).toBeEnabled()
  await expect(page.getByText('Synthetic course 1', { exact: true })).toHaveCount(0)
  expect(requested).toEqual(tokens.slice(0, 2))
  expect(new URL(page.url()).hash).toBe('')
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByText('Synthetic course 2', { exact: true })).toBeVisible()
  expect(requested).toEqual(tokens)
  for (const currentToken of tokens)
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(
      currentToken,
    )
  await page.evaluate(async () => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push('/learn')
  })
  await expect(page).toHaveURL(/\/learn$/)
  for (const currentToken of tokens)
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(
      currentToken,
    )
  await page.goBack()
  await expect(page).toHaveURL(/\/presentations$/)
  for (const currentToken of tokens)
    expect(await page.evaluate(() => JSON.stringify(window.history.state))).not.toContain(
      currentToken,
    )
  for (const currentToken of tokens) expect(consoleMessages.join('\n')).not.toContain(currentToken)
})

test('ignores an older link response arriving after a new fragment was opened', async ({
  page,
}) => {
  await session(page, false)
  const nextToken = 's'.repeat(43)
  let release: (() => void) | undefined
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  await page.route('**/api/presentations/resolve', async (route) => {
    if (route.request().postDataJSON().token === token) {
      started = true
      await delayed
      await route.fulfill({ status: 404, json: { error: 'PRESENTATION_NOT_FOUND' } })
    } else
      await route.fulfill({
        json: { ...publicResult, claims: { course: 'Newest synthetic course' } },
      })
  })
  await enter(page, `/presentations#${token}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect.poll(() => started).toBe(true)
  await page.goto(`/presentations#${nextToken}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect(page.getByText('Newest synthetic course', { exact: true })).toBeVisible()
  const oldResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/presentations/resolve') && response.status() === 404,
  )
  release!()
  await oldResponse
  await expect(page.getByText('Newest synthetic course', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Presentation unavailable', exact: true }),
  ).toHaveCount(0)
})

test('does not redisplay private claims when a delayed request finishes after the page was hidden', async ({
  page,
}) => {
  await session(page)
  let release: (() => void) | undefined
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  await page.route('**/api/presentations/resolve', async (route) => {
    started = true
    await delayed
    await route.fulfill({
      json: {
        ...publicResult,
        scope: 'full',
        claims: { name: 'Synthetic private person' },
        requiresAuthorization: false,
        verification: { ...report, payload: 'valid' },
      },
    })
  })
  await enter(page, `/presentations#${token}`)
  await page.getByRole('button', { name: 'Open presentation', exact: true }).click()
  await expect.poll(() => started).toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  release!()
  await expect(page.getByRole('button', { name: 'Open presentation', exact: true })).toBeEnabled()
  await expect(page.getByTestId('presentation-result')).toHaveCount(0)
  await expect(page.getByText('Synthetic private person', { exact: true })).toHaveCount(0)
})

test('defaults to public sharing and requires a named audience before creating a private QR link', async ({
  page,
}) => {
  await session(page)
  const challenges = await prepareProofWallet(page)
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({ json: credential }),
  )
  await page.route('**/api/recipient/verifiers', (route) =>
    route.fulfill({ json: { verifiers: [{ id: organizationId, name: 'Synthetic verifier' }] } }),
  )
  const grants: unknown[] = []
  await page.route('**/api/recipient/presentations**', (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({
        scope: 'full',
        verifierOrganizationId: organizationId,
        profileId,
        generationId,
      })
      const proof = route.request().postDataJSON().proof
      const challenge = challenges.find((item) => item.id === proof.challengeId)!
      expect(
        verifyMessage(
          Buffer.from(challenge.message).toString('hex'),
          proof.signature,
          proof.publicKey,
        ),
      ).toBe(true)
      grants.push(presentation)
      return route.fulfill({ json: { ...presentation, token, url: `/presentations#${token}` } })
    }
    return route.fulfill({ json: { presentations: grants } })
  })
  await enter(page, `/recipient/credentials/${generationId}/present?profile=${profileId}`)
  await connectProofWallet(page)
  await expect(page.getByRole('radio', { name: 'Public fields only', exact: true })).toBeChecked()
  await expect(page.getByRole('img', { name: 'QR code for this sharing link' })).toHaveCount(0)
  await page.getByRole('radio', { name: 'Complete content for one verifier', exact: true }).check()
  await expect(
    page.getByRole('button', { name: 'Create sharing link', exact: true }),
  ).toBeDisabled()
  await page
    .getByRole('combobox', { name: 'Designated verifier organization', exact: true })
    .selectOption(organizationId)
  await page.getByRole('button', { name: 'Create sharing link', exact: true }).click()
  await expect(page.getByRole('img', { name: 'QR code for this sharing link' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Sharing link', exact: true })).toHaveValue(
    new RegExp(`/presentations#${token}$`),
  )
  await expect(page.getByText('Sharing has no automatic expiry.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Create sharing link', exact: true }).click()
  await expect.poll(() => grants.length).toBe(2)
  expect(challenges).toHaveLength(2)
  expect(challenges[0]!.message).not.toBe(challenges[1]!.message)
})

test('shows the French recipient waiting state and notifications without reading payloads', async ({
  page,
}) => {
  await session(page)
  let payloadReads = 0
  await page.route('**/api/recipient/**/payload', (route) => {
    payloadReads += 1
    return route.abort()
  })
  await page.route('**/api/recipient/workspace', (route) =>
    route.fulfill({
      json: {
        credentials: [credential],
        invitations: [
          {
            id: organizationId,
            ...credential,
            claimedAt: '2026-09-24T10:00:00Z',
            expiresAt: '2099-09-24T10:00:00Z',
            revokedAt: null,
            generationId: null,
          },
        ],
        notifications: [
          {
            id: presentationId,
            kind: 'issued',
            profileId,
            generationId,
            organizationName: 'Synthetic school',
            createdAt: credential.createdAt,
          },
        ],
      },
    }),
  )
  await enter(page, '/fr/recipient')
  await expect(page.getByRole('heading', { name: 'Mes attestations', exact: true })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'En attente d’émission', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Acceptées (1)', exact: true })).toBeVisible()
  expect(payloadReads).toBe(0)
})

test('explains the active presentation limit without issuing another link', async ({ page }) => {
  await session(page)
  await prepareProofWallet(page)
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({ json: credential }),
  )
  await page.route('**/api/recipient/verifiers', (route) =>
    route.fulfill({ json: { verifiers: [] } }),
  )
  await page.route('**/api/recipient/presentations**', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { error: 'RECIPIENT_PRESENTATION_LIMIT' },
        })
      : route.fulfill({ json: { presentations: [presentation] } }),
  )
  await enter(page, `/fr/recipient/credentials/${generationId}/present?profile=${profileId}`)
  await page.getByTestId('presentation-wallet-toggle').click()
  await page.getByTestId('presentation-wallet-menu').locator('[data-wallet-id="gemwallet"]').click()
  await page.getByRole('button', { name: 'Créer le lien de partage', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Révoquez une présentation active avant d’en créer une autre (limite : 200).',
  )
  await expect(page.getByRole('img', { name: 'Code QR de ce lien de partage' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Révoquer ce lien', exact: true })).toBeVisible()
})

test('shows exact public fields and permits removal of an accepted private attestation without reading content', async ({
  page,
}) => {
  await session(page)
  let payloadReads = 0
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({ json: credential }),
  )
  await page.route('**/api/recipient/**/payload', (route) => {
    payloadReads += 1
    return route.abort()
  })
  await enter(page, `/recipient/credentials/${generationId}?profile=${profileId}`)
  const publicFields = page.getByRole('region', { name: 'Public fields', exact: true })
  await expect(publicFields.getByRole('listitem')).toHaveText(['course'])
  await expect(page.locator('#subject-action')).toContainText(
    'Remove the accepted active or expired credential',
  )
  expect(payloadReads).toBe(0)
})

test('reopens verifier history through a record reference and removes old claims on failure', async ({
  page,
}) => {
  await session(page)
  await page.route('**/api/verifier/workspace**', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: organizationId,
            name: 'Synthetic verifier',
            status: 'active',
            applicationStatus: 'approved',
            reviewReason: null,
          },
        ],
        selectedOrganizationId: organizationId,
        history: [
          {
            id: presentationId,
            organizationId,
            presentationId,
            profileId,
            generationId,
            scope: 'full',
            checkedAt: credential.createdAt,
            verification: report,
          },
        ],
      },
    }),
  )
  let opens = 0
  await page.route(`**/api/verifier/history/${presentationId}/presentation`, (route) => {
    opens += 1
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({})
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-recipient-csrf')
    expect(route.request().url()).not.toContain(token)
    return opens === 1
      ? route.fulfill({ json: publicResult })
      : route.fulfill({ status: 404, json: {} })
  })
  await enter(page, '/verifier')
  await expect(
    page.getByRole('link', { name: 'Export history as CSV', exact: true }),
  ).toHaveAttribute('href', `/api/verifier/history.csv?organizationId=${organizationId}`)
  await page.getByRole('button', { name: 'Check again', exact: true }).click()
  await expect(page.getByTestId('presentation-result')).toBeVisible()
  await page.getByRole('button', { name: 'Check again', exact: true }).click()
  await expect(page.getByTestId('presentation-result')).toHaveCount(0)
  await expect(page.getByText('This record could not be reopened.', { exact: false })).toBeVisible()
})

for (const locale of ['en', 'fr'] as const) {
  test(`opens a pasted sharing link without identifiers and hides technical evidence (${locale})`, async ({
    page,
  }) => {
    await session(page, false)
    let opens = 0
    await page.route('**/api/presentations/resolve', (route) => {
      opens += 1
      expect(route.request().postDataJSON()).toEqual({ token })
      return route.fulfill({
        json: {
          ...publicResult,
          claims: {
            course: 'Human readable course',
            passed: true,
            modules: ['First module', 'Second module'],
          },
        },
      })
    })
    await enter(page, locale === 'fr' ? '/fr/presentations' : '/presentations')
    const input = page.locator('#received-presentation-link')
    await expect(input).toBeVisible()
    await input.fill('https://foreign.example/presentations#' + token)
    await page
      .getByRole('button', {
        name: locale === 'fr' ? 'Vérifier l’attestation' : 'Verify the attestation',
        exact: true,
      })
      .click()
    await expect(page.getByRole('alert')).toBeVisible()
    expect(opens).toBe(0)
    await input.fill(new URL(`/presentations#${token}`, page.url()).href)
    await page
      .getByRole('button', {
        name: locale === 'fr' ? 'Vérifier l’attestation' : 'Verify the attestation',
        exact: true,
      })
      .click()
    const result = page.getByTestId('presentation-result')
    await expect(result.getByText('Human readable course', { exact: true })).toBeVisible()
    await expect(result.getByText(locale === 'fr' ? 'Oui' : 'Yes', { exact: true })).toBeVisible()
    await expect(result.getByText('First module', { exact: true })).toBeVisible()
    await expect(result.getByText(credential.subjectAddress, { exact: true })).not.toBeVisible()
    await expect(result.getByText(generationId, { exact: true })).not.toBeVisible()
    const details = result.locator('details').first()
    await details.locator('summary').first().click()
    await expect(result.getByText(generationId, { exact: true })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage, history: history.state }),
      ),
    ).not.toContain(token)
    expect(opens).toBe(1)
  })
}
