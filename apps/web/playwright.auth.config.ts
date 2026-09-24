import { defineConfig, devices } from '@playwright/test'

const port = process.env.XCS_AUTH_E2E_PORT ?? '3127'
const baseURL = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './e2e',
  testMatch: 'auth.spec.ts',
  outputDir: './test-results/auth',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NUXT_IGNORE_LOCK: '1',
      XCS_BROWSER_E2E: '1',
      XCS_AUTH_BROWSER_E2E: '1',
      XCS_AUTH_TEST_ORIGIN: baseURL,
      XCS_AUTH_ENABLED: '0',
      XCS_LOCAL_PAYLOAD_STORE: '0',
      NUXT_PUBLIC_PROFILE_ID: 'xrpl-testnet-xcs-browser-e2e',
      NUXT_PUBLIC_RPC_URL: 'ws://127.0.0.1:1',
    },
  },
})
