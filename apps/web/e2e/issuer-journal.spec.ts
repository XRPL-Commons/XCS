import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import type { IndexedDbOperationJournal, OperationSeed } from '../app/utils/operationJournal'

// Bundle the actual journal, then exercise native IndexedDB in two independent tabs.
// This test needs no Nuxt build, development server or ledger fixture.
const require = createRequire(import.meta.url)
const viteRequire = createRequire(
  createRequire(require.resolve('vitest/package.json')).resolve('vite'),
)
const { build } = viteRequire('esbuild') as {
  build: (options: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>
}
let bundle = ''
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [resolve('app/utils/operationJournal.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'XcsJournal',
    tsconfigRaw: { compilerOptions: {} },
    alias: {
      '#xcs/core/index.js': resolve('app/lib/xcs/core/index.ts'),
      '#xcs/sdk/index.js': resolve('app/lib/xcs/sdk/index.ts'),
    },
  })
  bundle = result.outputFiles[0]!.text
})

async function openJournal(page: Page) {
  await page.goto('https://journal.test/')
  await page.addScriptTag({ content: bundle })
}
async function create(page: Page, seed: OperationSeed) {
  return page.evaluate(async (input) => {
    const runtime = globalThis as unknown as {
      XcsJournal: { IndexedDbOperationJournal: new () => IndexedDbOperationJournal }
    }
    try {
      await new runtime.XcsJournal.IndexedDbOperationJournal().create(input)
      return 'ready-to-sign'
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }, seed)
}
const first: OperationSeed = {
  operationId: 'first',
  account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  profileId: 'xrpl-testnet',
  networkId: 1,
  transactionType: 'CredentialCreate',
  createdAt: '2026-09-24T00:00:00Z',
  business: {
    action: 'credential-issue',
    issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
    schemaUid: 'a'.repeat(64),
    credentialUri: `https://x.test/q/123456789012345678#xcs-sha256=${'a'.repeat(64)}`,
    payloadDigestHex: 'a'.repeat(64),
    issuerInviteId: '12345678-1234-4234-8234-123456789abc',
  },
}
const second: OperationSeed = {
  ...first,
  operationId: 'second',
  business: {
    ...first.business!,
    action: 'credential-issue',
    issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    subject: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    schemaUid: 'a'.repeat(64),
  },
}

test('one invitation excludes a second wallet before signing across tabs and after reload', async ({
  context,
}) => {
  await context.route('https://journal.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>Journal</title>' }),
  )
  const tab1 = await context.newPage(),
    tab2 = await context.newPage()
  await Promise.all([openJournal(tab1), openJournal(tab2)])
  const outcomes = await Promise.all([create(tab1, first), create(tab2, second)])
  expect(outcomes.sort()).toEqual(['OPERATION_BUSINESS_LOCKED', 'ready-to-sign'])
  const operationId = await tab1.evaluate(async () => {
    const runtime = globalThis as unknown as {
      XcsJournal: { IndexedDbOperationJournal: new () => IndexedDbOperationJournal }
    }
    const journal = new runtime.XcsJournal.IndexedDbOperationJournal()
    const operation = (await journal.list())[0]!
    await journal.persistSigned({
      operationId: operation.operationId,
      txHash: 'a'.repeat(64),
      txBlob: 'AA',
      lastLedgerSequence: 100,
      at: '2026-09-24T00:00:01Z',
    })
    await journal.assertBusinessLockOwned(operation.operationId)
    return operation.operationId
  })
  await tab2.reload()
  await tab2.addScriptTag({ content: bundle })
  expect(await create(tab2, { ...second, operationId: 'after-reload' })).toBe(
    'OPERATION_BUSINESS_LOCKED',
  )
  await tab1.evaluate(async (id) => {
    const runtime = globalThis as unknown as {
      XcsJournal: { IndexedDbOperationJournal: new () => IndexedDbOperationJournal }
    }
    await new runtime.XcsJournal.IndexedDbOperationJournal().append({
      operationId: id,
      stage: 'expired',
      txHash: 'a'.repeat(64),
      lastLedgerSequence: 100,
      at: '2026-09-24T00:00:02Z',
    })
  }, operationId)
  expect(await create(tab2, { ...second, operationId: 'after-proven-expiry' })).toBe(
    'ready-to-sign',
  )
})
