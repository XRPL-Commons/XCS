import { expect, test, type Page } from '@playwright/test'

const organizationId = '00000000-0000-4000-8000-000000000091'
const inviteId = '00000000-0000-4000-8000-000000000092'
const profileId = 'xrpl-testnet-xcs-browser-e2e'
const schemaUid = 'a'.repeat(64)
const subject = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const schema = {
  organizationId,
  profileId,
  schemaUid,
  name: 'Course achievement',
  displayName: 'Course achievement',
  category: 'Education',
}

// UI fixtures prove wording and preserved form values, not live authorization or signatures.
async function setup(page: Page, invitations: () => unknown[] = () => [], linked = true) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        csrfToken: 'synthetic-csrf',
        user: {
          id: '00000000-0000-4000-8000-000000000093',
          displayName: 'Issuer',
          email: 'issuer@example.test',
          roles: ['recipient'],
          wallets: linked
            ? [
                {
                  id: '00000000-0000-4000-8000-000000000095',
                  address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
                  networkId: 1,
                  verifiedAt: '2026-09-24T10:00:00Z',
                },
              ]
            : [],
          organizations: [{ id: organizationId, name: 'Learning school', roles: ['issuer'] }],
        },
      },
    }),
  )
  await page.route('**/api/auth/access?**', (route) => route.fulfill({ json: { allowed: true } }))
  await page.route('**/api/issuer/workspace**', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: organizationId,
            name: 'Learning school',
            status: 'active',
            applicationStatus: 'approved',
          },
        ],
        selectedOrganizationId: organizationId,
        schemas: [schema],
        invites: invitations(),
        credentials: [],
      },
    }),
  )
  await page.route('**/v1/networks', (route) =>
    route.fulfill({ json: { items: [{ profileId, networkId: 1 }] } }),
  )
}

async function enter(page: Page, path: string) {
  await page.goto('/')
  await expect(page.locator('[data-client-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(async (destination) => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push(destination)
  }, path)
}

test('inviting from a named template keeps that selection without requesting an identifier', async ({
  page,
}) => {
  await setup(page)
  await enter(page, '/issuer/schemas')
  await expect(
    page.getByRole('heading', { name: 'Attestation templates', exact: true }),
  ).toBeVisible()
  await page.getByRole('link', { name: 'Invite a recipient', exact: true }).click()
  await expect(
    page.getByRole('combobox', { name: 'Attestation template', exact: true }),
  ).toHaveValue(`${profileId}:${schemaUid}`)
  expect(await page.locator('main').innerText()).not.toContain(schemaUid)
  await expect(page.getByRole('textbox', { name: /uid|hash|identifier/i })).toHaveCount(0)
})

test('template creation exposes readable fields without a JSON editor', async ({ page }) => {
  await setup(page)
  await enter(page, `/issuer/schemas/new?organizationId=${organizationId}`)
  await expect(
    page.getByRole('heading', { name: 'Create an attestation template', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Template name', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit JSON', exact: true })).not.toBeVisible()
  const visible = await page.locator('main').innerText()
  expect(visible).not.toMatch(/UTF-8|canonical|\buint\b|\bbool\b/)
  await expect(page.getByText('Advanced options', { exact: true })).toHaveCount(0)
  await expect(page.locator('#schema-json')).toHaveCount(0)
})

test('managed issuance names the recipient and keeps full account references out of the main form', async ({
  page,
}) => {
  await setup(page)
  const definition = {
    xcsVersion: '0.1',
    name: schema.name,
    description: 'Completed training',
    fields: { course: { type: 'string' }, internalNote: { type: 'string' } },
  }
  await page.route(`**/v1/networks/${profileId}/schemas/${schemaUid}`, (route) =>
    route.fulfill({ json: { ...schema, resolvedDefinition: definition, definition } }),
  )
  await page.route(`**/api/issuer/invites/${inviteId}/issuance`, (route) =>
    route.fulfill({
      json: {
        invite: {
          id: inviteId,
          organizationId,
          profileId,
          schemaUid,
          claimedBy: 'recipient-id',
          expiresAt: '2099-01-01T00:00:00Z',
          revokedAt: null,
          deliveryEmail: 'contact@example.test',
        },
        schema: { ...schema, definition, resolvedDefinition: definition, publisher: subject },
        recipient: {
          id: 'recipient-id',
          displayName: 'Camille Martin',
          wallets: [{ address: subject, networkId: 1, verifiedAt: '2026-09-24T10:00:00Z' }],
        },
        organization: { id: organizationId, name: 'Learning school' },
        issuerWallets: [],
      },
    }),
  )
  await enter(page, `/issuer/issue/${inviteId}`)
  await expect(
    page.getByRole('heading', { name: 'Prepare an attestation', exact: true }),
  ).toBeVisible()
  await expect(page.locator('main')).toContainText('Camille Martin')
  await expect(page.locator('#claim-course')).toBeVisible()
  await page.locator('#claim-course').fill('First aid')
  await page.locator('#claim-internalNote').fill('Private review note')
  expect(await page.locator('main').innerText()).not.toContain(subject)
  expect(await page.locator('main').innerText()).not.toContain(schemaUid)
  await expect(
    page.getByRole('button', { name: 'Review before sending', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Verified account details', { exact: true })).toHaveCount(0)
  await expect(page.getByText(subject, { exact: true })).toHaveCount(0)
})

for (const deliveryStatus of ['failed', 'uncertain', 'sent'] as const) {
  test(`invitation creation reports ${deliveryStatus} delivery without implying unconfirmed success`, async ({
    page,
  }) => {
    let created = false
    await setup(page, () =>
      created
        ? [
            {
              id: inviteId,
              organizationId,
              profileId,
              schemaUid,
              email: 'recipient@example.test',
              deliveryStatus,
              expiresAt: '2099-01-01T00:00:00Z',
              claimedAt: null,
              revokedAt: null,
              recipientStatus: 'invited',
            },
          ]
        : [],
    )
    await page.route('**/api/issuer/invites', (route) => {
      expect(route.request().method()).toBe('POST')
      created = true
      return route.fulfill({ json: { id: inviteId, deliveryStatus } })
    })
    await enter(page, '/issuer/recipients')
    await page
      .getByRole('textbox', { name: 'Email address for the invitation', exact: true })
      .fill('recipient@example.test')
    await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'recipient@example.test', exact: true }),
    ).toBeVisible()
    const sentNotice = page.getByText('Invitation sent. Follow the recipient’s response below.', {
      exact: true,
    })
    if (deliveryStatus === 'sent') {
      await expect(sentNotice).toBeVisible()
    } else {
      await expect(sentNotice).toHaveCount(0)
      await expect(
        page.getByText('Invitation created. Email delivery has not been confirmed.', {
          exact: true,
        }),
      ).toBeVisible()
      const warning =
        deliveryStatus === 'failed'
          ? 'The invitation email could not be sent. Check the address before trying again.'
          : 'Delivery could not be confirmed. Check the mailbox before resending; a resend replaces the previous claim link.'
      await expect(page.getByText(warning, { exact: true })).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Replace and resend link', exact: true }),
      ).toBeVisible()
    }
    await expect(
      page
        .locator('details')
        .filter({ has: page.getByText('Email delivery details', { exact: true }) }),
    ).not.toHaveAttribute('open', '')
  })
}

test('template creation requires a linked issuer wallet before showing the form', async ({
  page,
}) => {
  await setup(page, () => [], false)
  await enter(page, `/issuer/schemas/new?organizationId=${organizationId}`)
  await expect(
    page.getByText('Link an issuer wallet before continuing.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Prepare the issuer wallet', exact: true }),
  ).toHaveAttribute('href', '/account?returnTo=/issuer/schemas/new')
  await expect(page.getByRole('textbox', { name: 'Template name', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit JSON', exact: true })).toHaveCount(0)
})
