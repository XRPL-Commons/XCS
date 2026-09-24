import { defineConfig } from '@playwright/test'

// Runs against an already-started production build. The extension transport
// fixture exists only in Playwright's isolated browser, never in the website.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'crossmark.production.spec.ts',
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env.XCS_WALLET_TEST_URL ?? 'https://localhost:3443',
    ignoreHTTPSErrors: false,
    launchOptions: {
      executablePath: process.env.XCS_BROWSER_EXECUTABLE,
      chromiumSandbox: true,
      ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    },
  },
})
