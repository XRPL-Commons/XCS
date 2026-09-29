import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      network: {
        label: 'xrp ledger',
        protocol: 'XRPL',
        type: 'testnet',
        wss: 'wss://s.altnet.rippletest.net:51233',
      },
      backgroundNetworkEmpty: false,
      requests: [] as string[],
      responses: [] as string[],
    }
    Object.assign(window, { xrpl: { isCrossmark: true }, __crossmarkTransport: state })
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.origin !== location.origin) return
      const request = event.data
      if (request?.response?.type === 'response' && request?.request?.app === 'crossmark') {
        state.responses.push(request.request.command)
        return
      }
      if (request?.app !== 'crossmark' || request?.type !== 'request') return
      state.requests.push(request.command)
      let data: unknown
      switch (request.command) {
        case 'sign':
          if (request.data?.tx?.TransactionType !== 'SignIn')
            throw new Error('Unexpected transaction request')
          data = { address: state.address, network: { ...state.network } }
          break
        case 'address':
          data = { address: state.address }
          break
        case 'network':
          data = { network: state.backgroundNetworkEmpty ? {} : state.network }
          break
        case 'user':
          data = { user: { username: 'Fixture user' } }
          break
        default:
          return
      }
      // Match Crossmark 0.2.19's content-script message sequence. Do not stub
      // SDK methods: exercise its correlation, session and event handlers too.
      const response = { app: 'crossmark', type: 'response', id: request.id, data }
      window.postMessage(response, location.origin)
      window.postMessage(
        { request, response, createdAt: Date.now(), resolvedAt: Date.now() },
        location.origin,
      )
    })
  })
  await page.goto('/learn')
  await page.locator('[data-client-ready="true"]').waitFor()
  // Let the real SDK finish its one-time detection query before approval.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __crossmarkTransport: { responses: string[] } }
        ).__crossmarkTransport.responses.includes('address'),
      ),
    )
    .toBe(true)
})

async function connectCrossmark(page: Page) {
  await page.getByTestId('wallet-toggle').click()
  await page.locator('button[data-wallet-id="crossmark"]').click()
}

async function expectConnected(page: Page) {
  await connectCrossmark(page)
  await expect(page.getByTestId('wallet-status')).toContainText('Connected')
  await expect(page.getByTestId('wallet-toggle')).toContainText('Crossmark')
}

test('retains approval across duplicate user/network initialization notifications', async ({
  page,
}) => {
  await expectConnected(page)
  await page.evaluate(() => {
    window.postMessage(
      { type: 'event', event: 'user-change', data: { user: { username: 'Fixture user' } } },
      location.origin,
    )
    window.postMessage(
      {
        type: 'event',
        event: 'network-change',
        data: {
          network: {
            label: 'xrp ledger',
            protocol: 'XRPL',
            type: 'testnet',
            wss: 'wss://s.altnet.rippletest.net:51233',
          },
        },
      },
      location.origin,
    )
  })
  // The old handler disconnects instead of requesting authoritative account
  // confirmation. Wait for the full transport roundtrip, not a guessed sleep.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (window as unknown as { __crossmarkTransport: { responses: string[] } })
          .__crossmarkTransport
        return state.responses.filter((command) => command === 'address').length
      }),
    )
    .toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('wallet-status')).toContainText('Connected')
  await expect(page.getByTestId('wallet-toggle')).toContainText('rHb9CJ')
})

test('clears approval when the actual selected account changes', async ({ page }) => {
  await expectConnected(page)
  await page.evaluate(() => {
    const state = (window as unknown as { __crossmarkTransport: { address: string } })
      .__crossmarkTransport
    state.address = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
    window.postMessage(
      { type: 'event', event: 'user-change', data: { user: { username: 'Another fixture user' } } },
      location.origin,
    )
  })
  await expect(page.getByTestId('wallet-status')).toHaveCount(0)
  await expect(page.getByTestId('wallet-toggle')).toHaveText('Connect wallet')
})

test('shows a failed network confirmation without scrolling and allows retry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.evaluate(() => {
    const state = (window as unknown as { __crossmarkTransport: { network: { type: string } } })
      .__crossmarkTransport
    state.network.type = 'mainnet'
  })
  await connectCrossmark(page)
  const error = page.locator('#wallet-menu [role="alert"]')
  await expect(error).toContainText(/network|Testnet/i)
  await expect(error).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('wallet-status')).toHaveCount(0)
  await expect(page.getByTestId('wallet-toggle')).toBeEnabled()

  await page.evaluate(() => {
    const state = (window as unknown as { __crossmarkTransport: { network: { type: string } } })
      .__crossmarkTransport
    state.network.type = 'testnet'
  })
  await page.locator('button[data-wallet-id="crossmark"]').click()
  await expect(page.getByTestId('wallet-status')).toContainText('Connected')
  await expect(page.getByTestId('wallet-toggle')).toContainText('Crossmark')
})

test('uses the approved network when Crossmark background state is not hydrated', async ({
  page,
}) => {
  await page.evaluate(() => {
    const state = (
      window as unknown as { __crossmarkTransport: { backgroundNetworkEmpty: boolean } }
    ).__crossmarkTransport
    state.backgroundNetworkEmpty = true
  })
  await expectConnected(page)
  await expect(page.getByTestId('wallet-status')).toContainText('Testnet')
})

test('prepares a schema against the real API and Testnet with an empty background network', async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(
      window as unknown as { __crossmarkTransport: { backgroundNetworkEmpty: boolean } }
    ).__crossmarkTransport.backgroundNetworkEmpty = true
  })
  await expectConnected(page)
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Create', exact: true })
    .click()
  await page.locator('a[href="/schemas/register"]').click()
  await page.getByRole('button', { name: 'Course completion template', exact: true }).click()
  await page.getByRole('button', { name: 'Review the template', exact: true }).click()
  await expect(page.getByTestId('transaction-sign')).toBeVisible({
    timeout: 30000,
  })
  // Do not sign or submit using the test transport. The preview is read-only.
  await expect(page.getByTestId('wallet-status')).toContainText('Connected')
})
