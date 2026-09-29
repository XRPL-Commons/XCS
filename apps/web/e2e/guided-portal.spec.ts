import { expect, test } from '@playwright/test'

test('routes the public navigation to the guided verifier and issuer entries', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('[data-client-ready="true"]')).toBeVisible()

  const navigation = page.getByTestId('primary-nav')
  await expect(navigation.getByRole('link', { name: 'Verify', exact: true })).toHaveAttribute(
    'href',
    '/presentations',
  )
  await expect(page.getByRole('link', { name: 'Start building', exact: true })).toHaveAttribute(
    'href',
    '/issuer',
  )
  await expect(navigation.getByRole('link', { name: 'Create', exact: true })).toHaveCount(0)
})

for (const legacy of [
  ['/studio?schema=discarded#secret', '/'],
  ['/schemas/register?uid=discarded', '/issuer/schemas/new'],
  ['/issue?subject=discarded', '/issuer/recipients'],
  ['/accept?generation=discarded', '/recipient'],
  ['/revoke?generation=discarded', '/issuer/credentials'],
  ['/verify?hash=discarded#secret', '/presentations'],
  ['/operations?profile=discarded', '/account'],
] as const) {
  test(`redirects ${legacy[0].split('?')[0]} without retaining technical input`, async ({
    request,
  }) => {
    const response = await request.get(legacy[0], { maxRedirects: 0 })
    expect(response.status()).toBe(308)
    expect(response.headers().location).toBe(`${legacy[1]}#xcs-legacy-redirect`)
    expect(response.headers().location).not.toContain('discarded')
  })
}

test('replaces and then removes a fragment on a public compatibility redirect', async ({
  page,
}) => {
  await page.goto('/studio?schema=discarded#secret')
  await expect(page).toHaveURL(/\/$/)
  expect(page.url()).not.toContain('discarded')
  expect(new URL(page.url()).hash).toBe('')
})

test('preserves the French locale and fits the verifier entry at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/fr/verify?hash=discarded#secret')
  await expect(page).toHaveURL(/\/fr\/presentations$/)
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR')
  expect(new URL(page.url()).hash).toBe('')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390)
})
