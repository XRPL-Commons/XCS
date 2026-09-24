import { createApp } from 'vue'
import { createXrplConnect, useWallet } from '@xrpl-commons/xrpl-connect-vue'
import { CrossmarkAdapter, CrossmarkSDK } from 'xrpl-connect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectWallet, refreshWalletAccount } from '../app/utils/walletConnection'

// Only the extension transport is doubled. Exercise the shipped Crossmark
// adapter, WalletManager and Vue bindings together, not a fake app account.
const signIn = { response: { data: { address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' } } }
const testnet = {
  response: {
    data: {
      network: {
        protocol: 'XRPL',
        label: 'xrp ledger',
        type: 'testnet',
        wss: 'wss://s.altnet.rippletest.net:51233',
      },
    },
  },
}

function setup() {
  vi.spyOn(CrossmarkSDK.default.sync, 'isInstalled').mockReturnValue(true)
  const approval = vi
    .spyOn(CrossmarkSDK.default.methods, 'signInAndWait')
    .mockResolvedValue(signIn as never)
  const network = vi
    .spyOn(CrossmarkSDK.default.api, 'awaitRequest')
    .mockResolvedValue(testnet as never)
  const app = createApp({})
  app.use(
    createXrplConnect({
      adapters: [new CrossmarkAdapter()],
      network: 'testnet',
      autoConnect: false,
      logger: { level: 'silent' },
      storage: {
        get: async () => null,
        set: async () => {},
        remove: async () => {},
        clear: async () => {},
      },
    }),
  )
  return { wallet: app.runWithContext(() => useWallet()), approval, network }
}

afterEach(() => {
  CrossmarkSDK.default.emit('signout')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('bounded account refresh through the official manager and Vue binding', () => {
  async function connected() {
    const state = setup()
    await connectWallet(state.wallet, 'crossmark', new AbortController().signal)
    CrossmarkSDK.default.emit('network-change', testnet.response.data)
    state.network.mockResolvedValue(signIn as never)
    return state
  }

  it('returns a real adapter refresh and releases its deadline', async () => {
    vi.useFakeTimers()
    const { wallet, network } = await connected()
    await expect(refreshWalletAccount(wallet, 100)).resolves.toMatchObject({
      address: signIn.response.data.address,
      network: { id: 'testnet' },
    })
    expect(network).toHaveBeenLastCalledWith({ command: 'address' })
    expect(wallet.connected.value).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await wallet.disconnect()
  })

  it('clears the session on timeout without waiting for stalled extension teardown', async () => {
    vi.useFakeTimers()
    const { wallet, network } = await connected()
    let reply!: (value: never) => void
    network.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
    vi.spyOn(wallet.manager.wallet!, 'disconnect').mockImplementation(() => new Promise(() => {}))
    const result = expect(refreshWalletAccount(wallet, 100)).rejects.toThrow(
      'WALLET_REFRESH_TIMEOUT',
    )
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(wallet.manager.connected).toBe(false)
    expect(wallet.manager.account).toBeNull()
    reply(signIn as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.manager.account).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late response after timeout and reconnection', async () => {
    vi.useFakeTimers()
    const { wallet, network } = await connected()
    let reply!: (value: never) => void
    network.mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)))
    const result = expect(refreshWalletAccount(wallet, 100)).rejects.toThrow(
      'WALLET_REFRESH_TIMEOUT',
    )
    await vi.advanceTimersByTimeAsync(100)
    await result
    network.mockResolvedValue(testnet as never)
    await connectWallet(wallet, 'crossmark', new AbortController().signal)
    reply({ response: { data: { address: 'stale-address' } } } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(wallet.account.value?.address).toBe(signIn.response.data.address)
    await wallet.disconnect()
  })

  it('cancels on disconnect and never times out a replacement session', async () => {
    vi.useFakeTimers()
    const { wallet, network } = await connected()
    network.mockImplementationOnce(() => new Promise(() => {}))
    const result = expect(refreshWalletAccount(wallet, 100)).rejects.toThrow(
      'WALLET_CHANGED_AFTER_PREVIEW',
    )
    await wallet.disconnect()
    await result
    network.mockResolvedValue(testnet as never)
    await connectWallet(wallet, 'crossmark', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(wallet.connected.value).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await wallet.disconnect()
  })
})

describe('Crossmark connection through the official Vue binding', () => {
  it('settles timeout even if the extension never finishes teardown', async () => {
    vi.useFakeTimers()
    const { wallet, network } = setup()
    network.mockImplementation(() => new Promise(() => {}))
    vi.spyOn(wallet.manager.wallets[0]!, 'disconnect').mockImplementation(
      () => new Promise(() => {}),
    )
    const result = expect(
      connectWallet(wallet, 'crossmark', new AbortController().signal, 100),
    ).rejects.toThrow('WALLET_CONNECTION_TIMEOUT')
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(wallet.account.value).toBeNull()
    expect(wallet.connecting.value).toBe(false)
    expect(wallet.manager.connectingWallet).toBeNull()
  })
  it('updates the shared account only after approval and network confirmation; clears it on disconnect', async () => {
    const { wallet } = setup()
    expect(wallet.account.value).toBeNull()
    await connectWallet(wallet, 'crossmark', new AbortController().signal)
    expect(wallet.connected.value).toBe(true)
    expect(wallet.account.value?.address).toBe(signIn.response.data.address)
    expect(wallet.account.value?.network.id).toBe('testnet')
    expect(wallet.connecting.value).toBe(false)
    await wallet.disconnect()
    expect(wallet.account.value).toBeNull()
  })

  it('does not turn a rejected approval into a connected session', async () => {
    const { wallet, approval } = setup()
    approval.mockResolvedValue({ response: { data: { meta: { isRejected: true } } } } as never)
    await expect(connectWallet(wallet, 'crossmark', new AbortController().signal)).rejects.toThrow()
    expect(wallet.account.value).toBeNull()
    expect(wallet.connecting.value).toBe(false)
  })

  it('rejects Mainnet rather than inventing a Testnet connection', async () => {
    const { wallet, network } = setup()
    network.mockResolvedValue({
      response: {
        data: {
          network: {
            ...testnet.response.data.network,
            type: 'mainnet',
            wss: 'wss://s1.ripple.com',
          },
        },
      },
    } as never)
    await expect(connectWallet(wallet, 'crossmark', new AbortController().signal)).rejects.toThrow()
    expect(wallet.account.value).toBeNull()
  })

  it('times out a missing post-approval network response and clears pending state', async () => {
    vi.useFakeTimers()
    const { wallet, network } = setup()
    network.mockImplementation(() => new Promise(() => {}))
    const attempt = connectWallet(wallet, 'crossmark', new AbortController().signal, 100)
    const result = expect(attempt).rejects.toThrow('WALLET_CONNECTION_TIMEOUT')
    await vi.advanceTimersByTimeAsync(50)
    expect(network).toHaveBeenCalled()
    expect(wallet.connecting.value).toBe(true)
    expect(wallet.account.value).toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    await result
    expect(wallet.connecting.value).toBe(false)
    expect(wallet.manager.connectingWallet).toBeNull()
  })

  it('ignores late approval after cancellation, including after a successful retry', async () => {
    const { wallet, network } = setup()
    let reply!: (value: never) => void
    network.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        }),
    )
    const controller = new AbortController()
    const attempt = connectWallet(wallet, 'crossmark', controller.signal)
    const result = expect(attempt).rejects.toThrow('WALLET_CONNECTION_CANCELLED')
    await vi.waitFor(() => expect(network).toHaveBeenCalled())
    controller.abort()
    await result
    expect(wallet.account.value).toBeNull()
    expect(wallet.connecting.value).toBe(false)
    await connectWallet(wallet, 'crossmark', new AbortController().signal)
    reply(testnet as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wallet.connected.value).toBe(true)
    expect(wallet.account.value?.address).toBe(signIn.response.data.address)
    await wallet.disconnect()
  })
})
