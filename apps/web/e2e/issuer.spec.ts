import { expect, test, type Page } from '@playwright/test'

const organizationId = '00000000-0000-4000-8000-000000000031'
const inviteId = '00000000-0000-4000-8000-000000000032'
const schema = {
  organizationId,
  profileId: 'xrpl-testnet-xcs-browser-e2e',
  schemaUid: 'a'.repeat(64),
  name: 'Synthetic qualification',
  displayName: 'School qualification',
  category: 'Education',
}
const organization = {
  id: organizationId,
  name: 'Synthetic issuer school',
  status: 'active',
  applicationStatus: 'approved',
  reviewReason: null as string | null,
}
const invitation = {
  id: inviteId,
  organizationId,
  profileId: schema.profileId,
  schemaUid: schema.schemaUid,
  email: 'learner@example.test',
  message: null,
  claimedAt: null,
  revokedAt: null,
  expiresAt: '2099-09-23T12:00:00Z',
  deliveryStatus: 'sent',
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    organizations: [organization],
    selectedOrganizationId: organizationId,
    schemas: [schema],
    invites: [],
    credentials: [],
    ...overrides,
  }
}

async function mockIssuer(page: Page, state: () => unknown = () => workspace()) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        csrfToken: 'synthetic-issuer-csrf',
        user: {
          id: '00000000-0000-4000-8000-000000000033',
          displayName: 'Synthetic responsible person',
          email: 'responsible@example.test',
          roles: ['recipient'],
          organizations: [{ id: organizationId, name: organization.name, roles: ['issuer'] }],
          wallets: [],
        },
      },
    }),
  )
  await page.route('**/api/auth/access?**', (route) => route.fulfill({ json: { allowed: true } }))
  await page.route('**/api/issuer/workspace**', (route) => route.fulfill({ json: state() }))
}

// Browser fixtures drive client middleware. These tests do not exercise real OIDC,
// PostgreSQL authorization, mail delivery or wallet/ledger submission.
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

async function fillInvitation(page: Page) {
  await page
    .getByRole('textbox', { name: 'Email address for the invitation', exact: true })
    .fill(invitation.email)
  await page
    .getByRole('combobox', { name: 'Attestation template', exact: true })
    .selectOption({ label: schema.displayName })
  await page
    .getByRole('textbox', { name: 'Optional message', exact: true })
    .fill('Your synthetic qualification is ready.')
}

test('shows organization schemas and invites recipients by named schema without a UID input', async ({
  page,
}) => {
  await mockIssuer(page)
  await enter(page, '/issuer')
  await expect(page).toHaveURL(/\/issuer\/schemas$/)
  await expect(
    page.getByRole('heading', { name: 'Attestation templates', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: schema.displayName, exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Organization', exact: true })).toHaveValue(
    organizationId,
  )
  await page
    .getByRole('navigation', { name: 'Issuer navigation' })
    .getByRole('link', { name: 'Recipients', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Recipients', exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('combobox', { name: 'Attestation template', exact: true })
      .getByRole('option', { name: schema.displayName }),
  ).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: /uid/i })).toHaveCount(0)
  await expect(page.getByText('No invitations yet.', { exact: true })).toBeVisible()
})

test('shows pending and declined application states without exposing an issuing action', async ({
  page,
}) => {
  await mockIssuer(page, () =>
    workspace({
      organizations: [
        { ...organization, applicationStatus: 'pending' },
        {
          ...organization,
          id: '00000000-0000-4000-8000-000000000034',
          name: 'Declined school',
          applicationStatus: 'rejected',
          reviewReason: 'Supporting evidence was incomplete.',
        },
      ],
      schemas: [],
    }),
  )
  await enter(page, '/issuer/application')
  await expect(page.getByText('Pending review', { exact: true })).toBeVisible()
  await expect(page.getByText('Declined', { exact: true })).toBeVisible()
  await expect(page.getByText('Supporting evidence was incomplete.', { exact: true })).toBeVisible()
  await expect(
    page.getByText(
      'An administrator will review your application. Issuance remains unavailable while it is pending.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open issuer workspace', exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByRole('link', { name: 'Apply as an issuer', exact: true })).toBeVisible()
})

test('submits a private application document with CSRF then displays pending review', async ({
  page,
}) => {
  let submitted = false
  const bodies: Record<string, unknown>[] = []
  await mockIssuer(page, () =>
    workspace({
      organizations: submitted ? [{ ...organization, applicationStatus: 'pending' }] : [],
      schemas: [],
    }),
  )
  await page.route('**/api/issuer/applications', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-issuer-csrf')
    bodies.push(route.request().postDataJSON())
    submitted = true
    return route.fulfill({ json: { organizationId } })
  })
  await enter(page, '/issuer/apply')
  await page
    .getByRole('textbox', { name: 'Organization name', exact: true })
    .fill(organization.name)
  await page
    .getByRole('textbox', { name: 'Website', exact: true })
    .fill('https://school.example.test')
  await page
    .getByRole('textbox', { name: 'Contact email', exact: true })
    .fill('responsible@example.test')
  await page
    .getByRole('textbox', { name: 'Country or territory of registration', exact: true })
    .fill('France')
  await page
    .getByRole('textbox', { name: 'What does your organization do?', exact: true })
    .fill('A synthetic school for a browser test.')
  await page
    .getByRole('textbox', { name: 'What attestations would you like to issue?', exact: true })
    .fill('Award training qualifications.')
  const document = Buffer.from('%PDF-1.4\nSynthetic application evidence\n')
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'evidence.pdf', mimeType: 'application/pdf', buffer: document })
  await page.getByRole('button', { name: 'Send for review', exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`/issuer/application\\?organizationId=${organizationId}$`),
  )
  await expect(page.getByText('Pending review', { exact: true })).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({
    name: organization.name,
    documents: [{ mimeType: 'application/pdf', base64: document.toString('base64') }],
  })
})

test('sends an invitation and resends only after explicit link replacement confirmation', async ({
  page,
}) => {
  let sent = false
  const deliveries: { path: string; body: unknown }[] = []
  await mockIssuer(page, () => workspace({ invites: sent ? [invitation] : [] }))
  await page.route('**/api/issuer/invites**', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-issuer-csrf')
    deliveries.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    })
    sent = true
    return route.fulfill({ json: { id: inviteId, deliveryStatus: 'sent' } })
  })
  await enter(page, '/issuer/recipients')
  await fillInvitation(page)
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await expect(page.getByRole('heading', { name: invitation.email, exact: true })).toBeVisible()
  expect(deliveries).toHaveLength(1)
  expect(deliveries[0]).toMatchObject({
    path: '/api/issuer/invites',
    body: {
      organizationId,
      profileId: schema.profileId,
      schemaUid: schema.schemaUid,
      email: invitation.email,
    },
  })
  await page.getByRole('button', { name: 'Replace and resend link', exact: true }).click()
  await expect(
    page.getByText('Replace the previous link and send a new invitation?', { exact: true }),
  ).toBeVisible()
  expect(deliveries).toHaveLength(1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(deliveries).toHaveLength(1)
  await page.getByRole('button', { name: 'Replace and resend link', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByText('Update saved.', { exact: true })).toBeVisible()
  expect(deliveries).toHaveLength(2)
  expect(deliveries[1]).toEqual({ path: `/api/issuer/invites/${inviteId}/resend`, body: {} })
})

test('surfaces a server refusal without reporting a successful invitation', async ({ page }) => {
  await mockIssuer(page)
  let requests = 0
  await page.route('**/api/issuer/invites', (route) => {
    requests++
    return route.fulfill({ status: 403, json: { error: 'ISSUER_FORBIDDEN' } })
  })
  await enter(page, '/issuer/recipients')
  await fillInvitation(page)
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('This action could not be completed.')
  await expect(page.getByText('Update saved.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: invitation.email, exact: true })).toHaveCount(0)
  expect(requests).toBe(1)
})

test('keeps the invitation bearer out of URLs and browser storage and claims only on confirmation', async ({
  page,
}) => {
  const token = 'A'.repeat(43)
  const urls: string[] = []
  const consoleMessages: string[] = []
  const bodies: { path: string; body: unknown }[] = []
  page.on('request', (request) => urls.push(request.url()))
  page.on('console', (message) => consoleMessages.push(message.text()))
  await mockIssuer(page)
  await page.route('**/api/issuer/invitations/**', (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-issuer-csrf')
    const path = new URL(route.request().url()).pathname
    bodies.push({ path, body: route.request().postDataJSON() })
    return route.fulfill({
      json: path.endsWith('/preview')
        ? { organizationName: organization.name, schemaName: schema.displayName }
        : { claimed: true },
    })
  })
  for (const navigation of ['client', 'direct']) {
    bodies.length = 0
    if (navigation === 'client') await enter(page, `/recipient/invitations#${token}`)
    else {
      await page.goto('/')
      await page.goto(`/recipient/invitations#${token}`)
    }
    await expect(page.getByRole('heading', { name: schema.displayName, exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/recipient\/invitations$/)
    expect(bodies).toEqual([{ path: '/api/issuer/invitations/preview', body: { token } }])
    await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
    await expect(
      page.getByText(
        'Invitation claimed. Link your wallet in your account so the issuer can review it before issuing.',
        { exact: true },
      ),
    ).toBeVisible()
    expect(bodies).toEqual([
      { path: '/api/issuer/invitations/preview', body: { token } },
      { path: '/api/issuer/invitations/claim', body: { token } },
    ])
    expect(urls.every((url) => !url.includes(token))).toBe(true)
    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        history: history.state,
      }),
    )
    expect(stored).not.toContain(token)
    expect(consoleMessages.join('\n')).not.toContain(token)
  }
})

test('replaces a claimed invitation with successive native and router links in the same tab', async ({
  page,
}) => {
  const first = 'B'.repeat(43),
    second = 'C'.repeat(43),
    third = 'D'.repeat(43)
  const names = {
    [first]: 'First invitation',
    [second]: 'Second invitation',
    [third]: 'Third invitation',
  }
  const claims: string[] = []
  await mockIssuer(page)
  await page.route('**/api/issuer/invitations/**', (route) => {
    const { token } = route.request().postDataJSON() as { token: string }
    if (route.request().url().endsWith('/claim')) {
      claims.push(token)
      return route.fulfill({ json: { claimed: true } })
    }
    return route.fulfill({
      json: { organizationName: organization.name, schemaName: names[token] },
    })
  })
  await enter(page, `/recipient/invitations#${first}`)
  await expect(page.getByRole('heading', { name: names[first], exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
  await expect(
    page.getByText(
      'Invitation claimed. Link your wallet in your account so the issuer can review it before issuing.',
      { exact: true },
    ),
  ).toBeVisible()
  await page.evaluate((token) => {
    window.location.hash = token
  }, second)
  await expect(page.getByRole('heading', { name: names[second], exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/recipient\/invitations$/)
  expect(claims).toEqual([first])
  await page.evaluate(async (token) => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push(`/recipient/invitations#${token}`)
  }, third)
  await expect(page.getByRole('heading', { name: names[third], exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: names[second], exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/recipient\/invitations$/)
  expect(claims).toEqual([first])
  await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
  await expect.poll(() => claims).toEqual([first, third])
  for (const value of [first, second, third])
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(value)
  await page.evaluate(async () => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push('/')
  })
  for (const value of [first, second, third])
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(value)
})

test('ignores an old claim response after a different invitation arrived in the same tab', async ({
  page,
}) => {
  const first = 'E'.repeat(43),
    second = 'F'.repeat(43)
  const claims: string[] = []
  let claimStarted!: () => void, releaseClaim!: () => Promise<void>
  const started = new Promise<void>((resolve) => {
    claimStarted = resolve
  })
  await mockIssuer(page)
  await page.route('**/api/issuer/invitations/**', (route) => {
    const { token } = route.request().postDataJSON() as { token: string }
    if (route.request().url().endsWith('/claim')) {
      claims.push(token)
      if (token === first) {
        releaseClaim = () => route.fulfill({ json: { claimed: true } })
        claimStarted()
        return
      }
      return route.fulfill({ json: { claimed: true } })
    }
    return route.fulfill({
      json: {
        organizationName: organization.name,
        schemaName: token === first ? 'Delayed claim invitation' : 'Current unclaimed invitation',
      },
    })
  })
  await enter(page, `/recipient/invitations#${first}`)
  await expect(
    page.getByRole('heading', { name: 'Delayed claim invitation', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
  await started
  await page.evaluate((token) => {
    window.location.hash = token
  }, second)
  await expect(
    page.getByRole('heading', { name: 'Current unclaimed invitation', exact: true }),
  ).toBeVisible()
  const response = page.waitForResponse((response) =>
    response.url().endsWith('/api/issuer/invitations/claim'),
  )
  await releaseClaim()
  await (await response).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(
    page.getByRole('heading', { name: 'Current unclaimed invitation', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText(
      'Invitation claimed. Link your wallet in your account so the issuer can review it before issuing.',
      { exact: true },
    ),
  ).toHaveCount(0)
  expect(claims).toEqual([first])
  await expect(
    page.getByRole('button', { name: 'Claim with this account', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Claim with this account', exact: true }).click()
  await expect.poll(() => claims).toEqual([first, second])
  for (const value of [first, second])
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(value)
  await expect(
    page.getByText(
      'Invitation claimed. Link your wallet in your account so the issuer can review it before issuing.',
      { exact: true },
    ),
  ).toBeVisible()
})

test('renders the issuer navigation and unconfirmed delivery guidance in French', async ({
  page,
}) => {
  await mockIssuer(page, () =>
    workspace({ invites: [{ ...invitation, deliveryStatus: 'uncertain' }] }),
  )
  await enter(page, '/fr/issuer/recipients')
  await expect(page.getByRole('heading', { name: 'Destinataires', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Navigation émetteur' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Envoyer l’invitation', exact: true }),
  ).toBeVisible()
  await page.getByText('Détails de l’envoi de l’email', { exact: true }).click()
  await expect(page.getByText('Livraison de l’email: Non confirmé', { exact: true })).toBeVisible()
  await expect(
    page.getByText('La livraison n’a pas pu être confirmée.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Remplacer et renvoyer le lien', exact: true }).click()
  await expect(
    page.getByText('Remplacer le lien précédent et envoyer une nouvelle invitation ?', {
      exact: true,
    }),
  ).toBeVisible()
})
