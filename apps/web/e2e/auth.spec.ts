import { expect, test, type Route } from '@playwright/test'

test('signs in through OIDC, persists a session, denies issuer access, links and unlinks a wallet, then signs out', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    ;(
      globalThis as typeof globalThis & { __xcsBrowserE2eAuthWallet?: boolean }
    ).__xcsBrowserE2eAuthWallet = true
  })
  await page.goto('/auth/login')
  await page.getByTestId('auth-signin').click()
  await expect(page).toHaveURL(/\/account$/)
  await expect(page.getByRole('heading', { name: 'My XCS account', exact: true })).toBeVisible()
  await expect(page.getByText('Test recipient', { exact: true })).toBeVisible()
  const sessionCookie = (await context.cookies()).find((c) => c.name === '__Host-xcs-session')!
  expect(sessionCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' })
  expect(await page.evaluate(() => localStorage.getItem('access_token'))).toBeNull()
  await page.reload()
  await expect(page.getByText('Test recipient', { exact: true })).toBeVisible()
  await page.goto('/issuer')
  await expect(page).toHaveURL(/\/auth\/not-authorized/)
  await page.goto('/account')
  await page.getByTestId('wallet-toggle').click()
  await page.locator('[data-wallet-id="gemwallet"]').click()
  await expect(page.getByTestId('auth-link-wallet')).toBeEnabled()
  await page.getByTestId('auth-link-wallet').click()
  await expect(page.getByTestId('linked-wallets').locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('wallet-link-continue')).toHaveAttribute('href', '/recipient')
  await expect(page).toHaveURL(/\/account$/)
  // Hold hydration deterministically: SSR mutation buttons must remain disabled
  // until their click listeners are attached, even when the account is visible.
  let releaseScripts!: () => void
  const scriptsReady = new Promise<void>((resolve) => {
    releaseScripts = resolve
  })
  const holdScripts = async (route: Route) => {
    if (route.request().resourceType() === 'script') await scriptsReady
    await route.continue()
  }
  await page.route('**/*', holdScripts)
  try {
    await page.reload({ waitUntil: 'commit' })
    await expect(page.getByTestId('linked-wallets').locator('tbody tr')).toHaveCount(1)
    await expect(
      page.getByTestId('linked-wallets').getByRole('button', { includeHidden: true }),
    ).toBeDisabled()
    await expect(page.getByTestId('auth-logout')).toBeDisabled()
  } finally {
    releaseScripts()
    await page.unrouteAll({ behavior: 'wait' })
  }
  await page.locator('summary').filter({ hasText: 'Manage my wallet' }).click()
  await page.getByTestId('linked-wallets').getByRole('button').click()
  await expect(page.getByTestId('linked-wallets')).toHaveCount(0)
  await expect(page.getByTestId('wallet-link-continue')).toHaveCount(0)
  await page.getByTestId('auth-logout').click()
  await expect(page).toHaveURL(/\/auth\/login$/)
  await page.goto('/account')
  await expect(page).toHaveURL(/\/auth\/login$/)
  await page.goto('/schemas')
  await expect(page).toHaveURL(/\/schemas$/)
})

test('offers French sign-in and account copy', async ({ page }) => {
  await page.goto('/fr/auth/login')
  await page.getByTestId('auth-signin').click()
  await expect(page).toHaveURL(/\/fr\/account$/)
  await expect(page.getByRole('heading', { name: 'Mon compte XCS', exact: true })).toBeVisible()
  await expect(page.getByTestId('auth-logout')).toHaveText('Se déconnecter de XCS')
})
