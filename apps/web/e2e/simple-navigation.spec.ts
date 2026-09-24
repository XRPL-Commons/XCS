import { expect, test, type Page } from '@playwright/test'

const issuerEnabled = process.env.NUXT_PUBLIC_ISSUER_ENABLED === '1'

async function navigate(page: Page, path: string) {
  await page.evaluate(async (target) => {
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: {
        config: { globalProperties: { $router: { push: (path: string) => Promise<void> } } }
      }
    }
    await root.__vue_app__.config.globalProperties.$router.push(target)
  }, path)
}

// Client fixtures cover navigation only. Real OIDC/permissions have separate runtime tests.
async function enterHome(page: Page, locale: 'en' | 'fr', signedIn: boolean) {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        user: signedIn
          ? {
              id: '00000000-0000-4000-8000-000000000099',
              displayName: 'Synthetic administrator',
              email: 'navigation@example.test',
              roles: ['admin', 'recipient'],
              organizations: [
                {
                  id: '00000000-0000-4000-8000-000000000098',
                  name: 'Synthetic organization',
                  roles: ['issuer', 'verifier'],
                },
              ],
              wallets: [],
            }
          : null,
      },
    }),
  )
  const prefix = locale === 'fr' ? '/fr' : ''
  await page.goto(prefix || '/')
  await page.locator('[data-client-ready="true"]').waitFor()
  // Auth middleware reloads the session through the browser route fixture.
  await navigate(page, `${prefix}/account`)
  await navigate(page, prefix || '/')
}

for (const locale of ['en', 'fr'] as const) {
  for (const signedIn of [false, true]) {
    test(`simple ${locale} homepage for ${signedIn ? 'a multi-role account' : 'a visitor'}`, async ({
      page,
    }) => {
      test.skip(!issuerEnabled, 'Run with NUXT_PUBLIC_ISSUER_ENABLED=1 for portal navigation.')
      await page.setViewportSize({ width: 1440, height: 1000 })
      await enterHome(page, locale, signedIn)
      const home = page.getByTestId('simple-home')
      await expect(home).toBeVisible()
      await expect(home.getByRole('link')).toHaveCount(3)
      const prefix = locale === 'fr' ? '/fr' : ''
      await expect(home.locator(`a[href="${prefix}/recipient"]`)).toBeVisible()
      await expect(home.locator(`a[href="${prefix}/presentations"]`)).toBeVisible()
      await expect(
        home.locator(`a[href="${prefix}${signedIn ? '/issuer' : '/issuer/application'}"]`),
      ).toBeVisible()
      await expect(page.getByTestId('install-command')).toHaveCount(0)
      await expect(page.getByRole('searchbox')).toHaveCount(0)
      await expect(
        page.getByRole('button', { name: /Connect wallet|Connecter un portefeuille/ }),
      ).toHaveCount(0)
      const primary = page.getByTestId('primary-nav')
      await expect(primary.locator('a[href$="/admin"]')).not.toBeVisible()
      await primary
        .getByRole('button', { name: locale === 'fr' ? 'Plus' : 'More', exact: true })
        .click()
      await expect(primary.locator(`a[href="${prefix}/schemas"]`)).toBeVisible()
      await expect(primary.locator(`a[href="${prefix}/developers"]`)).toBeVisible()
      if (signedIn) await expect(primary.locator(`a[href="${prefix}/admin"]`)).toBeVisible()
      else await expect(primary.locator(`a[href="${prefix}/admin"]`)).toHaveCount(0)
    })
  }
}

test('keeps the protocol homepage when issuer portals are disabled', async ({ page }) => {
  test.skip(issuerEnabled, 'Run with NUXT_PUBLIC_ISSUER_ENABLED=0 for protocol compatibility.')
  await enterHome(page, 'en', false)
  await expect(page.getByTestId('landing-hero')).toBeVisible()
  await expect(page.getByTestId('install-command')).toContainText('pnpm install')
  await expect(page.getByTestId('simple-home')).toHaveCount(0)
  await expect(page.getByTestId('primary-nav').locator('a[href="/schemas"]')).toBeVisible()
})
