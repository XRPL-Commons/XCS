import { expect, test, type Page } from '@playwright/test'

const profileId = 'xrpl-testnet-xcs-browser-e2e'
const generationId = 'd'.repeat(64)
const subjectAddress = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const credential = {
  profileId,
  generationId,
  schemaUid: 'e'.repeat(64),
  schemaName: 'Synthetic first aid certificate',
  organizationId: '00000000-0000-4000-8000-000000000181',
  organizationName: 'Synthetic academy',
  issuerAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  subjectAddress,
  networkId: 1,
  visibility: 'private',
  createdAt: '2026-09-24T10:00:00Z',
  creationTransactionHash: 'f'.repeat(64),
  status: {
    state: 'active',
    accepted: true,
    expiration: null,
    deletedLedgerIndex: null,
    deletionCause: null,
  },
  events: [],
  disclosure: { publicFields: ['course'], fields: ['course', 'result'] },
}

async function session(page: Page, linked = true) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        csrfToken: 'synthetic-simple-recipient',
        user: {
          id: '00000000-0000-4000-8000-000000000182',
          email: 'synthetic@example.test',
          displayName: 'Synthetic recipient',
          roles: ['recipient'],
          organizations: [],
          wallets: linked
            ? [
                {
                  id: '00000000-0000-4000-8000-000000000183',
                  address: subjectAddress,
                  networkId: 1,
                  verifiedAt: '2026-09-24T10:00:00Z',
                },
              ]
            : [],
        },
      },
    }),
  )
}

async function enter(page: Page, path: string) {
  await page.goto('/')
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

test('continues a claimed invitation directly when a wallet is already linked', async ({
  page,
}) => {
  await session(page)
  let claims = 0
  await page.route('**/api/issuer/invitations/preview', (route) =>
    route.fulfill({
      json: { organizationName: 'Synthetic academy', schemaName: 'Synthetic course' },
    }),
  )
  await page.route('**/api/issuer/invitations/claim', (route) => {
    claims += 1
    return route.fulfill({ json: { ok: true } })
  })
  await enter(page, `/recipient/invitations#${'s'.repeat(43)}`)
  await expect(
    page.getByRole('button', { name: 'Claim with this account', exact: true }),
  ).toBeVisible()
  expect(claims).toBe(0)
  await expect(page).toHaveURL(/\/recipient\/invitations$/)
  await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
  await expect(page.getByText('Your wallet is already linked', { exact: false })).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Continue to my attestations', exact: true }),
  ).toHaveAttribute('href', '/recipient')
  await expect(
    page.getByRole('link', { name: 'Prepare or manage my wallet', exact: true }),
  ).toHaveCount(0)
  expect(claims).toBe(1)
})

test('puts continuation before optional setup and wallet references for a returning recipient', async ({
  page,
}) => {
  await session(page)
  await enter(page, '/account?returnTo=%2Frecipient')
  await expect(page.getByTestId('wallet-link-continue')).toBeVisible()
  await expect(page.getByTestId('wallet-link-continue')).toHaveAttribute('href', '/recipient')
  await expect(page.getByTestId('linked-wallets')).not.toBeVisible()
  await expect(page.getByText(subjectAddress, { exact: true })).not.toBeVisible()
  await page.getByText('Manage my wallet', { exact: true }).click()
  await expect(page.getByTestId('linked-wallets')).toBeVisible()
  await expect(page.getByTestId('linked-wallets')).toContainText(subjectAddress)
})

test('reads nested attestation content only on request and keeps references secondary', async ({
  page,
}) => {
  await session(page)
  let payloadReads = 0
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({ json: credential }),
  )
  await page.route('**/api/recipient/**/payload', (route) => {
    payloadReads += 1
    return route.fulfill({
      json: {
        scope: 'full',
        claims: { course: 'Synthetic first aid', result: { grade: 'Synthetic distinction' } },
        verification: {
          onChain: 'active',
          schema: 'valid',
          payload: 'match',
          issuerTrust: 'unknown',
        },
      },
    })
  })
  await enter(page, `/recipient/credentials/${generationId}?profile=${profileId}`)
  await expect(
    page.getByRole('link', { name: 'Share this attestation', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(generationId, { exact: true })).not.toBeVisible()
  await expect(page.locator('#subject-action')).toContainText('Remove the accepted')
  await expect(
    page.getByRole('button', {
      name: 'Remove the accepted active or expired credential',
      exact: true,
    }),
  ).not.toBeVisible()
  expect(payloadReads).toBe(0)
  await page.getByRole('button', { name: 'Read attestation content', exact: true }).click()
  await expect(page.getByText('Synthetic distinction', { exact: true })).toBeVisible()
  await expect(page.locator('main pre')).toHaveCount(0)
  await expect(page.getByText(generationId, { exact: true })).not.toBeVisible()
  expect(payloadReads).toBe(1)
})

test('updates the available action after the same page receives an accepted credential', async ({
  page,
}) => {
  await session(page)
  let accepted = false
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({
      json: {
        ...credential,
        status: { ...credential.status, accepted, state: accepted ? 'active' : 'pending' },
      },
    }),
  )
  await enter(page, `/recipient/credentials/${generationId}?profile=${profileId}`)
  await expect(page.getByRole('button', { name: 'Review credential', exact: true })).toBeVisible()
  await expect(page.locator('#subject-action')).toContainText('Reject the unaccepted')
  accepted = true
  await page.evaluate(async () => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $nuxt: { callHook: (hook: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$nuxt.callHook('app:data:refresh')
  })
  await expect(
    page.getByRole('link', { name: 'Share this attestation', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review credential', exact: true })).toHaveCount(0)
  await expect(page.locator('#subject-action')).toContainText('Remove the accepted')
  await expect(page.locator('#subject-action')).not.toContainText('Reject the unaccepted')
})

test('chooses disclosure before the wallet proof and never requests a signature without an audience', async ({
  page,
}) => {
  await session(page)
  let challenges = 0
  await page.route(`**/api/recipient/credentials/${profileId}/${generationId}`, (route) =>
    route.fulfill({ json: credential }),
  )
  await page.route('**/api/recipient/verifiers', (route) =>
    route.fulfill({ json: { verifiers: [] } }),
  )
  await page.route('**/api/recipient/presentations?**', (route) =>
    route.fulfill({ json: { presentations: [] } }),
  )
  await page.route('**/api/recipient/presentation-challenges', (route) => {
    challenges += 1
    return route.abort()
  })
  await enter(page, `/recipient/credentials/${generationId}/present?profile=${profileId}`)
  await expect(page.getByRole('radio', { name: 'Public fields only', exact: true })).toBeChecked()
  await expect(page.getByText(subjectAddress, { exact: true })).not.toBeVisible()
  const scope = page.getByRole('group', { name: 'Disclosure scope', exact: true })
  const proof = page.getByRole('region', {
    name: 'Authorize this link with your wallet',
    exact: true,
  })
  await expect(scope).toBeVisible()
  expect(
    await scope.evaluate((element) =>
      Boolean(
        element.compareDocumentPosition(
          document.querySelector('[aria-label="Authorize this link with your wallet"]')!,
        ) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true)
  await expect(proof).toBeVisible()
  await page.getByRole('radio', { name: 'Complete content for one verifier', exact: true }).check()
  await expect(
    page.getByRole('button', { name: 'Create sharing link', exact: true }),
  ).toBeDisabled()
  expect(challenges).toBe(0)
})
