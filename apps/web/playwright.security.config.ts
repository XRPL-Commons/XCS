import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3101'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'security.production.spec.ts',
  outputDir: './test-results/security-production',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm start',
    url: `${baseURL}/learn`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'production',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '3101',
      // Production uses the standalone API config, never the fixture repository.
      XCS_DATABASE_URL: 'postgres://xcs_api@127.0.0.1:1/security-test',
      XCS_ALLOWED_ORIGINS: baseURL,
      NUXT_BROWSER_E2E_MODE: 'disabled',
      NUXT_PUBLIC_BROWSER_E2E_MODE: 'disabled',
      NUXT_PUBLIC_PROFILE_ID: 'commons-testnet-xcs-v0.1-controlled-pilot',
      XCS_BROWSER_E2E: '0',
      XCS_LOCAL_PAYLOAD_STORE: '0',
    },
  },
  projects: [{ name: 'chromium-security-production', use: { ...devices['Desktop Chrome'] } }],
})
