import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

const port = process.env.XCS_E2E_PORT ?? '3100'
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['security.production.spec.ts', 'crossmark.production.spec.ts', 'auth.spec.ts'],
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NUXT_IGNORE_LOCK: '1',
      XCS_BROWSER_E2E: '1',
      XCS_LOCAL_PAYLOAD_STORE: '1',
      // The browser-visible profile identifier is derived from this file's
      // `profileId`; there is no separate variable for it.
      XCS_NETWORK_PROFILE: fileURLToPath(
        new URL('./test/fixtures/network-profiles/browser-e2e.json', import.meta.url),
      ),
      NUXT_PUBLIC_RPC_URL: 'ws://127.0.0.1:1',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
