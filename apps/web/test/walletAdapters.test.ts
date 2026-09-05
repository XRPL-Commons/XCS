import { adapterSupports } from 'xrpl-connect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearMismatchedXamanSession,
  createXrplConnectAdapters,
  forceXamanOAuthNetwork,
  withXamanSignWindow,
} from '../app/utils/walletAdapters'

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
      walletConnectProjectId: `  ${'1'.repeat(32)}  `,
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

  it('only reports Otsu as available when its injected provider marker is present', async () => {
    const otsu = createXrplConnectAdapters().find((adapter) => adapter.id === 'otsu')
    expect(otsu).toBeDefined()

    vi.stubGlobal('xrpl', {})
    await expect(otsu?.isAvailable()).resolves.toBe(false)
    vi.stubGlobal('xrpl', { isOtsu: true })
    await expect(otsu?.isAvailable()).resolves.toBe(true)
  })

  it('forces the Xaman OAuth sign-in request onto Testnet', () => {
    expect(
      forceXamanOAuthNetwork(
        'https://oauth2.xumm.app/auth?client_id=public-app-id&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000',
      ),
    ).toBe(
      'https://oauth2.xumm.app/auth?client_id=public-app-id&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000&force_network=TESTNET',
    )
    expect(forceXamanOAuthNetwork('https://example.com/auth?client_id=other')).toBe(
      'https://example.com/auth?client_id=other',
    )
  })

  it('evicts only cached Xaman sessions that cannot prove the required network', () => {
    const removeItem = vi.fn()
    const mainnetStorage = {
      getItem: vi.fn().mockReturnValue(JSON.stringify({ me: { networkId: '0' } })),
      removeItem,
    }

    clearMismatchedXamanSession(mainnetStorage, 1)
    expect(removeItem).toHaveBeenCalledWith('XummPkceJwt')

    removeItem.mockClear()
    const testnetStorage = {
      getItem: vi.fn().mockReturnValue(JSON.stringify({ me: { networkId: '1' } })),
      removeItem,
    }
    clearMismatchedXamanSession(testnetStorage, 1)
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('closes the Xaman sign window and restores focus after the wallet returns', async () => {
    const close = vi.fn()
    const focus = vi.fn()
    const originalOpen = vi.fn(() => ({ closed: false, close }))
    const browserWindow = { open: originalOpen, focus } as unknown as Window

    await expect(
      withXamanSignWindow(browserWindow, async () => {
        browserWindow.open('https://xumm.app/sign/request', 'Xaman Sign')
        return 'signed'
      }),
    ).resolves.toBe('signed')

    expect(close).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    expect(browserWindow.open).toBe(originalOpen)
  })

  it('restores the application window when Xaman signing fails', async () => {
    const close = vi.fn()
    const focus = vi.fn()
    const originalOpen = vi.fn(() => ({ closed: false, close }))
    const browserWindow = { open: originalOpen, focus } as unknown as Window

    await expect(
      withXamanSignWindow(browserWindow, async () => {
        browserWindow.open('https://xumm.app/sign/request', 'Xaman Sign')
        throw new Error('SIGN_FAILED')
      }),
    ).rejects.toThrow('SIGN_FAILED')

    expect(close).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    expect(browserWindow.open).toBe(originalOpen)
  })
})
