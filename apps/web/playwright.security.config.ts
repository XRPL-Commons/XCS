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
      NUXT_BROWSER_E2E_MODE: 'disabled',
      NUXT_PUBLIC_BROWSER_E2E_MODE: 'disabled',
      NUXT_PUBLIC_PROFILE_ID: 'commons-testnet-xcs-v0.1-controlled-pilot',
      XCS_BROWSER_E2E: '0',
      XCS_LOCAL_PAYLOAD_STORE: '0',
      // The production build boots the real API context; the address is
      // deliberately unreachable so the read routes answer 503 rather than data.
      XCS_DATABASE_URL: 'postgres://127.0.0.1:1/xcs',
      XCS_ALLOWED_ORIGINS: baseURL,
    },
  },
  projects: [{ name: 'chromium-security-production', use: { ...devices['Desktop Chrome'] } }],
})
