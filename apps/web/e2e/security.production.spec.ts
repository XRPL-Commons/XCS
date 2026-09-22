import { expect, test } from '@playwright/test'

import {
  collectBrowserFailures,
  expectHtmlDefensiveHeaders,
  expectNonHtmlDefensiveHeaders,
  expectStrictReportOnlyPolicy,
} from './securityAssertions'

function productionAssetPaths(html: string): string[] {
  const paths = [...html.matchAll(/(?:src|href)="([^"#?]*\/_nuxt\/[^"#?]+\.(?:css|js))"/gu)].map(
    (match) => match[1]!,
  )
  return [...new Set(paths)]
}

test('serves the production page and error document with canonical fresh nonces', async ({
  page,
  request,
}) => {
  const first = await request.get('/learn')
  expect(first.status()).toBe(200)
  const firstHtml = await first.text()
  const firstNonce = expectStrictReportOnlyPolicy(first, firstHtml, 'production')
  expectHtmlDefensiveHeaders(first)

  const second = await request.get('/learn')
  expect(second.status()).toBe(200)
  const secondNonce = expectStrictReportOnlyPolicy(second, await second.text(), 'production')
  expect(secondNonce).not.toBe(firstNonce)

  const missing = await request.get('/xcs-security-header-test-not-found', {
    headers: { accept: 'text/html' },
  })
  expect(missing.status()).toBe(404)
  const missingNonce = expectStrictReportOnlyPolicy(missing, await missing.text(), 'production')
  expectHtmlDefensiveHeaders(missing)
  expect(missingNonce).not.toBe(firstNonce)
  expect(missingNonce).not.toBe(secondNonce)

  const browserFailures = collectBrowserFailures(page)
  const navigation = await page.goto('/learn')
  expect(navigation?.status()).toBe(200)
  await page.locator('[data-client-ready="true"]').waitFor()
  await expect(page.getByTestId('testnet-banner')).toHaveCount(0)
  expect(browserFailures).toEqual([])
})

test('serves production assets without applying an HTML CSP to them', async ({ request }) => {
  const pageResponse = await request.get('/learn')
  expect(pageResponse.status()).toBe(200)
  const assetPaths = productionAssetPaths(await pageResponse.text())
  expect(assetPaths.some((path) => path.endsWith('.js'))).toBe(true)
  expect(assetPaths.some((path) => path.endsWith('.css'))).toBe(true)

  for (const assetPath of assetPaths) {
    const asset = await request.get(assetPath)
    expect(asset.status(), assetPath).toBe(200)
    expectNonHtmlDefensiveHeaders(asset)
    expect(asset.headers()['cache-control'], assetPath).toBe('public, max-age=31536000, immutable')
  }
})
