import { expect, test, type Page } from '@playwright/test'

const application = {
  organization_id: '00000000-0000-4000-8000-000000000030',
  role: 'verifier',
  status: 'pending',
  revision: 0,
  name: 'Synthetic review organization',
  submitted_at: '2026-09-20T08:00:00Z',
  reviewed_at: null,
  review_reason: null,
  responsible_name: 'Synthetic applicant',
  responsible_email: 'review@example.test',
  description: 'Local browser test fixture',
  jurisdiction: 'FR',
  purpose: 'Review credentials',
}
const audit = {
  id: 'decision-1',
  organization_id: application.organization_id,
  role: 'verifier',
  organization_name: application.name,
  actor_name: 'Synthetic administrator',
  actor_id: '00000000-0000-4000-8000-000000000031',
  action: 'approve',
  before_status: 'pending',
  after_status: 'approved',
  reason: null,
  created_at: '2026-09-23T08:00:00Z',
  notification_id: 'mail-1',
  notification_status: 'failed',
}

async function mockAdmin(page: Page) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        csrfToken: 'synthetic-csrf',
        user: {
          id: 'admin-1',
          displayName: 'Synthetic administrator',
          email: 'admin@example.test',
          roles: ['admin'],
          organizations: [],
          wallets: [],
        },
      },
    }),
  )
  await page.route('**/api/auth/access?**', (route) => route.fulfill({ json: { allowed: true } }))
  await page.route('**/api/admin/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/audit'))
      return route.fulfill({ json: { items: [audit], total: 1, page: 1, pageSize: 20 } })
    if (url.pathname.endsWith('/retry')) return route.fulfill({ json: { status: 'pending' } })
    if (url.pathname.endsWith('/link'))
      return route.fulfill({ status: 404, json: { error: 'ADMIN_DOCUMENT_MISSING' } })
    if (url.pathname.endsWith('/decisions'))
      return route.fulfill({ json: { decision: audit, replayed: false } })
    if (url.pathname.endsWith('/verifier'))
      return route.fulfill({
        json: {
          application,
          wallets: [
            {
              address: 'rSyntheticResponsibleWallet',
              network_id: 1,
              verified_at: '2026-09-20T08:00:00Z',
            },
          ],
          documents: [{ id: 'document-1', mime_type: 'application/pdf', byte_length: 300 }],
          history: [],
        },
      })
    return route.fulfill({
      json: {
        items: [
          {
            ...application,
            ...(url.pathname.endsWith('/verifiers') ? { status: 'approved' } : {}),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
        counts: { issuer: 0, verifier: 1 },
      },
    })
  })
}

// Start on a public page so mocked browser API responses drive client middleware.
// Direct SSR access is tested separately below against the real server boundary.
async function enter(page: Page, path = '/admin') {
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

test('reviews, requires refusal reason, submits CSRF, navigates verifiers and retries only notification', async ({
  page,
}) => {
  await mockAdmin(page)
  const decisions: unknown[] = []
  await page.route('**/decisions', (route) => {
    expect(route.request().headers()['x-xcs-csrf']).toBe('synthetic-csrf')
    decisions.push(route.request().postDataJSON())
    return route.fulfill({ json: { decision: audit, replayed: false } })
  })
  await enter(page)
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible()
  await page.getByRole('link', { name: `Review ${application.name}` }).click()
  await expect(
    page.getByText('These wallets belong to the responsible person.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Prepare secure link' }).click()
  await expect(page.getByText('The document could not be opened.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Decline access', exact: true }).click()
  await page.getByTestId('admin-confirm-decision').click()
  await expect(page.getByText('Enter a reason before confirming.')).toBeVisible()
  expect(decisions).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Reason (required)' }).fill('Insufficient evidence')
  await page.getByTestId('admin-confirm-decision').click()
  await expect(page.getByText('Decision recorded.', { exact: false })).toBeVisible()
  expect(decisions).toHaveLength(1)
  await page
    .getByRole('navigation', { name: 'Administrator navigation' })
    .getByRole('link', { name: 'Verifier access' })
    .click()
  await expect(page.getByRole('heading', { name: 'Verifier access', exact: true })).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Administrator navigation' })
    .getByRole('link', { name: 'Audit history' })
    .click()
  await page.getByRole('button', { name: 'Retry notification' }).click()
  await expect(page.getByText('Notification queued for delivery.', { exact: false })).toBeVisible()
  expect(decisions).toHaveLength(1)
})

test('preserves an ambiguous decision body and displays a concurrent decision', async ({
  page,
}) => {
  await mockAdmin(page)
  const requests: unknown[] = []
  await page.route('**/decisions', (route) => {
    requests.push(route.request().postDataJSON())
    if (requests.length === 1) return route.abort('connectionfailed')
    return route.fulfill({
      status: 409,
      json: {
        error: 'ADMIN_CONFLICT',
        current: {
          status: 'rejected',
          revision: 1,
          review_reason: 'Already reviewed by another administrator',
          reviewed_at: '2026-09-23T08:00:00Z',
        },
      },
    })
  })
  await enter(page, `/admin/applications/${application.organization_id}/verifier`)
  await page.getByRole('button', { name: 'Approve access', exact: true }).click()
  await page.getByTestId('admin-confirm-decision').click()
  await page.getByRole('button', { name: 'Retry the same decision' }).click()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  await expect(page.getByText('Already reviewed by another administrator')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve access', exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Reload and review the current decision' }),
  ).toBeVisible()
})

test('French queue, empty state, unavailable state and uncertain SMTP delivery', async ({
  page,
}) => {
  await mockAdmin(page)
  await page.route('**/api/admin/applications?**', (route) =>
    route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 20, counts: { issuer: 0, verifier: 0 } },
    }),
  )
  await enter(page, '/fr/admin')
  await expect(page.getByRole('heading', { name: 'Candidatures', exact: true })).toBeVisible()
  await expect(page.getByText('Aucune demande à examiner.')).toBeVisible()
  await page.route('**/api/admin/verifiers?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'ADMIN_UNAVAILABLE' } }),
  )
  await page
    .getByRole('navigation', { name: 'Navigation administrateur' })
    .getByRole('link', { name: 'Accès des vérificateurs' })
    .click()
  await expect(
    page.getByText('Le service d’administration est temporairement indisponible.', {
      exact: false,
    }),
  ).toBeVisible()
  await page.route('**/api/admin/audit?**', (route) =>
    route.fulfill({
      json: {
        items: [{ ...audit, notification_status: 'uncertain' }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    }),
  )
  await page
    .getByRole('navigation', { name: 'Navigation administrateur' })
    .getByRole('link', { name: 'Historique des décisions' })
    .click()
  await expect(
    page.getByText('L’envoi a pu aboutir avant une interruption.', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer la notification' })).toHaveCount(0)
})

test('protects direct anonymous navigation and rejects a revoked administrator role', async ({
  page,
}) => {
  await page.goto(`/admin/applications/${application.organization_id}/verifier`)
  await expect(page).toHaveURL(/\/auth\/login$/)
  await mockAdmin(page)
  await page.route('**/api/auth/access?**', (route) =>
    route.fulfill({ status: 403, json: { error: 'AUTH_FORBIDDEN' } }),
  )
  await enter(page)
  await expect(page).toHaveURL(/\/auth\/not-authorized$/)
  await expect(page.getByText(application.name)).toHaveCount(0)
})

test('suspends and restores verifier access with an explicit reason and confirmation', async ({
  page,
}) => {
  await mockAdmin(page)
  let currentStatus = 'approved'
  let revision = 1
  const decisions: { action: string; revision: number; reason: string }[] = []
  await page.route(`**/api/admin/applications/${application.organization_id}/verifier`, (route) =>
    route.fulfill({
      json: {
        application: { ...application, status: currentStatus, revision },
        wallets: [],
        documents: [],
        history: [],
      },
    }),
  )
  await page.route('**/decisions', (route) => {
    const request = route.request().postDataJSON()
    decisions.push(request)
    currentStatus = request.action === 'suspend' ? 'suspended' : 'approved'
    revision++
    return route.fulfill({
      json: { decision: { ...audit, after_status: currentStatus }, replayed: false },
    })
  })
  await enter(page, '/admin/verifiers')
  await page.getByRole('link', { name: `Review ${application.name}` }).click()
  await page.getByRole('button', { name: 'Suspend access', exact: true }).click()
  await page.getByTestId('admin-confirm-decision').click()
  await expect(page.getByText('Enter a reason before confirming.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Reason (required)' }).fill('Evidence expired')
  await page.getByTestId('admin-confirm-decision').click()
  await expect(page).toHaveURL(/\/admin\/verifiers\?/)
  expect(decisions[0]).toMatchObject({ action: 'suspend', reason: 'Evidence expired', revision: 1 })
  await page.getByRole('link', { name: `Review ${application.name}` }).click()
  await page.getByRole('button', { name: 'Restore access', exact: true }).click()
  await page.getByTestId('admin-confirm-decision').click()
  await expect(page).toHaveURL(/\/admin\/verifiers\?/)
  expect(decisions[1]).toMatchObject({ action: 'restore', revision: 2 })
})

test('filters and paginates applications, then handles session expiry without showing records', async ({
  page,
}) => {
  await mockAdmin(page)
  await page.route('**/api/admin/applications?**', (route) => {
    const params = new URL(route.request().url()).searchParams
    if (params.get('page') === '2')
      return route.fulfill({ status: 401, json: { error: 'AUTH_REQUIRED' } })
    return route.fulfill({
      json: {
        items: [application],
        total: 21,
        page: 1,
        pageSize: 20,
        counts: { issuer: 0, verifier: 21 },
      },
    })
  })
  await enter(page)
  await page.getByRole('button', { name: 'Verifier (21)', exact: true }).click()
  await expect(page).toHaveURL(/role=verifier/)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText('Your session has expired.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('admin-applications')).toHaveCount(0)
})

test('shows document access revocation and removes the previously loaded profile', async ({
  page,
}) => {
  await mockAdmin(page)
  await page.route('**/api/admin/documents/*/link', (route) =>
    route.fulfill({ status: 403, json: { error: 'AUTH_FORBIDDEN' } }),
  )
  await enter(page, `/admin/applications/${application.organization_id}/verifier`)
  await page.getByRole('button', { name: 'Prepare secure link' }).click()
  await expect(page.getByText('Access denied.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: application.name })).toHaveCount(0)
})

test('keeps previous-page navigation after the final application is decided and identifies an unnamed actor', async ({
  page,
}) => {
  await mockAdmin(page)
  await page.route('**/api/admin/applications?**', (route) =>
    route.fulfill({
      json: {
        items: [],
        total: 20,
        page: 2,
        pageSize: 20,
        counts: { issuer: 0, verifier: 20 },
      },
    }),
  )
  await enter(page, '/admin?page=2&decided=1')
  await expect(page.getByText('No applications to review.')).toBeVisible()
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(page).toHaveURL(/page=1/)
  await page.route('**/api/admin/audit?**', (route) =>
    route.fulfill({
      json: {
        items: [{ ...audit, actor_name: null }],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    }),
  )
  await page
    .getByRole('navigation', { name: 'Administrator navigation' })
    .getByRole('link', { name: 'Audit history' })
    .click()
  await expect(page.getByText(audit.actor_id, { exact: false })).toBeVisible()
})
