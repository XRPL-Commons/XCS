import { adapterSupports } from 'xrpl-connect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createXrplConnectAdapters } from '../app/utils/walletAdapters'

describe('XRPL Connect adapter registration', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('registers every self-contained sign-only adapter without public app identifiers', () => {
    const adapters = createXrplConnectAdapters()
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'crossmark',
      'gemwallet',
      'ledger',
      'xyra',
      'otsu',
      'metamask-snap',
    ])
    expect(adapters.every((adapter) => adapterSupports(adapter, 'sign'))).toBe(true)
  })

  it('registers all eight official adapters when Xaman and WalletConnect are configured', () => {
    const adapters = createXrplConnectAdapters({
      xamanApiKey: '  00000000-0000-0000-0000-000000000000  ',
      walletConnectProjectId: '  ' + '1'.repeat(32) + '  ',
    })
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      'xaman',
      'crossmark',
      'gemwallet',
      'walletconnect',
      'ledger',
      'xyra',
      'otsu',
      'metamask-snap',
    ])
    expect(new Set(adapters.map((adapter) => adapter.id)).size).toBe(adapters.length)
  })

  it('does not instantiate adapters whose required public identifier is blank', () => {
    const adapterIds = createXrplConnectAdapters({
      xamanApiKey: ' ',
      walletConnectProjectId: '\n',
    }).map((adapter) => adapter.id)
    expect(adapterIds).not.toContain('xaman')
    expect(adapterIds).not.toContain('walletconnect')
  })

  it('only reports Otsu as available when its browser provider marker is present', async () => {
    const otsu = createXrplConnectAdapters().find((adapter) => adapter.id === 'otsu')!
    vi.stubGlobal('window', { xrpl: {} })
    await expect(otsu.isAvailable()).resolves.toBe(false)
    vi.stubGlobal('window', { xrpl: { isOtsu: true } })
    await expect(otsu.isAvailable()).resolves.toBe(true)
  })
})
