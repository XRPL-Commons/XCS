import { expect, test, type Page } from '@playwright/test'
import { BROWSER_E2E_WALLET_ID } from '../app/utils/browserE2eHarness'

const linkedWallet = {
  id: '00000000-0000-4000-8000-000000000081',
  address: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
  networkId: 1,
  verifiedAt: '2026-09-24T10:00:00Z',
}
async function mockSession(page: Page, linked = false) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        csrfToken: 'synthetic-wallet-onboarding',
        user: {
          id: '00000000-0000-4000-8000-000000000082',
          displayName: 'Synthetic recipient',
          email: 'synthetic@example.test',
          roles: ['recipient'],
          organizations: [],
          wallets: linked ? [linkedWallet] : [],
        },
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

test('guides a recipient without a wallet and limits the local chooser to supported ownership proofs', async ({
  page,
}) => {
  await mockSession(page)
  await enter(page, '/account?returnTo=%2Frecipient')
  await expect(
    page.getByRole('heading', { name: 'Prepare your recipient wallet', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Never enter them in XCS', { exact: false })).toBeVisible()
  await expect(
    page.getByText('Linking the wallet here sends no transaction', { exact: false }),
  ).toBeVisible()
  await expect(page.getByTestId('wallet-link-continue')).toHaveCount(0)
  await page.getByTestId('wallet-link-toggle').click()
  const choices = await page
    .getByTestId('wallet-link-menu')
    .locator('[data-wallet-choice]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-wallet-choice')),
    )
  expect(choices.length).toBeGreaterThan(0)
  expect(choices.every((id) => ['gemwallet', 'metamask-snap', 'otsu'].includes(id!))).toBe(true)
  await page.keyboard.press('Escape')
  await page.getByTestId('wallet-toggle').click()
  await expect(
    page.getByTestId('wallet-menu').locator(`[data-wallet-choice="${BROWSER_E2E_WALLET_ID}"]`),
  ).toBeVisible()
})

test('offers the French recipient continuation after a verified wallet and rejects an external return destination', async ({
  page,
}) => {
  await mockSession(page, true)
  await enter(page, '/fr/account?returnTo=https%3A%2F%2Foutside.test')
  await expect(page.getByTestId('linked-wallets')).toContainText(linkedWallet.address)
  await expect(page.getByTestId('wallet-link-continue')).toHaveAttribute('href', '/fr/recipient')
  await expect(
    page.getByText('Un wallet Testnet est lié à votre compte.', { exact: false }),
  ).toBeVisible()
})

test('explains wallet readiness before issuer preparation when the recipient has no linked wallet', async ({
  page,
}) => {
  await mockSession(page)
  await page.route('**/api/recipient/workspace', (route) =>
    route.fulfill({
      json: {
        credentials: [],
        notifications: [],
        invitations: [
          {
            id: 'synthetic-invitation',
            organizationName: 'Synthetic school',
            schemaName: 'Synthetic course',
            generationId: null,
            revokedAt: null,
          },
        ],
      },
    }),
  )
  await enter(page, '/recipient')
  await expect(
    page.getByText('Link a wallet before your issuer can issue this attestation.', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('region', { name: 'Waiting for issuance', exact: true })
      .getByRole('link', { name: 'Prepare or manage my wallet', exact: true }),
  ).toHaveAttribute('href', '/account?returnTo=/recipient')
})

test('allows issuance only when the claimed recipient has a verified wallet ready', async ({
  page,
}) => {
  await mockSession(page)
  await page.route('**/api/auth/access?**', (route) => route.fulfill({ json: { allowed: true } }))
  const organizationId = '00000000-0000-4000-8000-000000000083'
  const invite = {
    organizationId,
    profileId: 'xrpl-testnet-xcs-browser-e2e',
    schemaUid: 'a'.repeat(64),
    claimedAt: '2026-09-24T10:00:00Z',
    revokedAt: null,
    expiresAt: '2099-09-24T10:00:00Z',
    deliveryStatus: 'sent',
    recipientDisplayName: 'Synthetic claimant',
  }
  await page.route('**/api/issuer/workspace**', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: organizationId,
            name: 'Synthetic school',
            status: 'active',
            applicationStatus: 'approved',
            reviewReason: null,
          },
        ],
        selectedOrganizationId: organizationId,
        schemas: [],
        credentials: [],
        invites: [
          {
            ...invite,
            id: 'waiting-wallet',
            email: 'waiting@example.test',
            recipientStatus: 'wallet_required',
            recipientWalletVerifiedAt: null,
          },
          {
            ...invite,
            id: 'ready-wallet',
            email: 'ready@example.test',
            recipientStatus: 'ready',
            recipientWalletVerifiedAt: linkedWallet.verifiedAt,
          },
          { ...invite, id: 'legacy-unknown', email: 'unknown@example.test' },
        ],
      },
    }),
  )
  await enter(page, '/issuer/recipients')
  await expect(page.getByText('Recipient must link a wallet', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Recipient ready to receive the attestation', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Prepare the attestation', exact: true }),
  ).toHaveCount(1)
  await expect(
    page.getByRole('link', { name: 'Prepare the attestation', exact: true }),
  ).toHaveAttribute('href', '/issuer/issue/ready-wallet')
})
