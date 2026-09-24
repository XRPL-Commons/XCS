import { expect, test } from '@playwright/test'

import {
  collectBrowserFailures,
  expectHtmlDefensiveHeaders,
  expectNonHtmlDefensiveHeaders,
  expectStrictReportOnlyPolicy,
} from './securityAssertions'

test('serves a nonce-bound development policy without browser violations', async ({
  page,
  request,
}) => {
  const first = await request.get('/learn')
  expect(first.status()).toBe(200)
  const firstNonce = expectStrictReportOnlyPolicy(first, await first.text(), 'development')
  expectHtmlDefensiveHeaders(first)

  const second = await request.get('/learn')
  expect(second.status()).toBe(200)
  const secondNonce = expectStrictReportOnlyPolicy(second, await second.text(), 'development')
  expect(secondNonce).not.toBe(firstNonce)

  const browserFailures = collectBrowserFailures(page)
  const navigation = await page.goto('/learn')
  expect(navigation?.status()).toBe(200)
  await page.locator('[data-client-ready="true"]').waitFor()
  expect(browserFailures).toEqual([])
})

test('keeps the browser E2E JSON route outside the HTML CSP', async ({ request }) => {
  const e2eApi = await request.get('/v1/networks')
  expect(e2eApi.status()).toBe(200)
  expectNonHtmlDefensiveHeaders(e2eApi)
  await expect(e2eApi.json()).resolves.toMatchObject({ items: expect.any(Array) })
})
