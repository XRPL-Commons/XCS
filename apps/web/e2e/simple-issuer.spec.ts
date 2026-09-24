import { expect, test, type Page } from '@playwright/test'
import { createHttpsPayloadUri, payloadDigest } from '../app/lib/xcs/core/index.js'

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
async function setup(page: Page, invitations: () => unknown[] = () => []) {
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
          wallets: [],
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

test('template creation starts with readable formats and keeps JSON an explicit advanced choice', async ({
  page,
}) => {
  await setup(page)
  await enter(page, `/issuer/schemas/new?organizationId=${organizationId}`)
  await expect(
    page.getByRole('heading', { name: 'Create an attestation template', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Template name', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit JSON', exact: true })).not.toBeVisible()
  const visible = await page.locator('main').innerText()
  expect(visible).not.toMatch(/UTF-8|canonical|\buint\b|\bbool\b/)
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit JSON', exact: true }).click()
  await expect(page.locator('#schema-json')).toBeVisible()
  await page.getByRole('button', { name: 'Edit the form', exact: true }).click()
  await expect(page.locator('#schema-name')).toHaveValue('Course Completion')
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
  await page.getByText('Verified account details', { exact: true }).click()
  await expect(page.getByText(subject, { exact: true })).toBeVisible()
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

test('an unsupported template version keeps its exact diagnostic in optional details', async ({
  page,
}) => {
  await setup(page)
  await enter(page, `/issuer/schemas/new?organizationId=${organizationId}`)
  await page.getByText('Advanced options', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit JSON', exact: true }).click()
  await page.locator('#schema-json').fill(
    JSON.stringify({
      xcsVersion: '0.2',
      name: 'Course',
      description: 'Course completed',
      fields: { course: { type: 'string' } },
    }),
  )
  await page.getByRole('button', { name: 'Edit the form', exact: true }).click()
  const error = page.getByRole('alert')
  await expect(error).toContainText(
    'This template could not be read. Check its format in the advanced editor.',
  )
  expect(await error.innerText()).not.toContain('INVALID_SCHEMA')
  expect(await error.innerText()).not.toContain('Each name must be unique')
  await error.getByText('Technical details', { exact: true }).click()
  await expect(error).toContainText('INVALID_SCHEMA ($.xcsVersion): Unsupported XCS schema version')
  await expect(page.getByTestId('transaction-preview')).toHaveCount(0)
})

test('publication recovery hides technical references and preserves retry, download and removal actions after failure', async ({
  page,
}) => {
  await setup(page)
  const canonicalPayload = '{"claims":{"course":"Synthetic course"}}'
  const locator = payloadDigest(canonicalPayload).slice(0, 18)
  const fetchUrl = `https://x.test/p/${locator}`
  const transactionHash = 'ab'.repeat(32)
  const job = {
    id: '00000000-0000-4000-8000-000000000094',
    createdAt: '2026-09-25T10:00:00Z',
    payload: {
      network: profileId,
      locator,
      canonicalPayload,
      credentialUri: createHttpsPayloadUri(fetchUrl, canonicalPayload),
      transactionHash,
      signedTransactionBlob: '00',
    },
  }
  const key = `xcs-hosted-publication-v1:${job.id}`
  // This isolated context contains only a synthetic public recovery copy.
  await page.addInitScript(
    ({ key, job }) => {
      localStorage.setItem(key, JSON.stringify(job))
    },
    { key, job },
  )
  let attempts = 0
  await page.route(`**/v1/payloads/${locator}`, (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toMatchObject({
      network: profileId,
      payloadBase64: Buffer.from(canonicalPayload).toString('base64'),
      signedTransactionBlob: '00',
    })
    attempts += 1
    return route.fulfill({ status: 503, json: { error: 'PAYLOAD_SERVICE_UNAVAILABLE' } })
  })
  await enter(page, '/issuer/schemas')
  const recovery = page.getByTestId('publication-recovery')
  await expect(recovery).toBeVisible()
  const details = recovery.getByTestId('publication-technical-details')
  await expect(details).not.toHaveAttribute('open', '')
  expect(await recovery.innerText()).not.toContain(fetchUrl)
  expect(await recovery.innerText()).not.toContain(transactionHash)
  const retry = recovery.getByRole('button', { name: 'Finish publication', exact: true })
  const remove = recovery.getByRole('button', { name: 'Remove recovery copy', exact: true })
  const download = recovery.getByRole('button', { name: 'Download saved content', exact: true })
  await expect(retry).toBeVisible()
  await expect(remove).toBeVisible()
  await expect(download).toBeVisible()
  await details.locator('summary').click()
  await expect(details).toContainText(fetchUrl)
  await expect(details).toContainText(transactionHash)
  await details.locator('summary').click()

  await retry.click()
  const error = recovery.getByRole('alert')
  await expect(error).toContainText(
    'Publication could not be completed. The recovery copy is retained.',
  )
  expect(await error.innerText()).not.toContain('PAYLOAD_SERVICE_UNAVAILABLE')
  await error.locator('details > summary').click()
  await expect(error).toContainText('PAYLOAD_SERVICE_UNAVAILABLE')
  expect(attempts).toBe(1)
  await expect(retry).toBeEnabled()
  await expect(remove).toBeVisible()
  await expect(download).toBeVisible()
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual(job)

  const downloadEvent = page.waitForEvent('download')
  await download.click()
  const stream = await (await downloadEvent).createReadStream()
  if (!stream) throw new Error('Recovery download unavailable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString('utf8')).toBe(canonicalPayload)
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key)).toEqual(job)
})
