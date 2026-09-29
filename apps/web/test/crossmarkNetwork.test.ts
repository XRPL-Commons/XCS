import { CrossmarkAdapter, CrossmarkSDK } from 'xrpl-connect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const address = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const testnet = {
  label: 'xrp ledger',
  protocol: 'xrpl',
  type: 'testnet',
  wss: 'wss://s.altnet.rippletest.net:51233',
  rpc: 'https://s.altnet.rippletest.net:51234',
}

function setup(network: unknown = testnet) {
  vi.spyOn(CrossmarkSDK.default.sync, 'isInstalled').mockReturnValue(true)
  vi.spyOn(CrossmarkSDK.default.methods, 'signInAndWait').mockImplementation(async () => {
    const response = { request: { id: 'approval' }, response: { data: { address, network } } }
    CrossmarkSDK.default.emit('response', response)
    return response as never
  })
  const live = vi.spyOn(CrossmarkSDK.default.api, 'awaitRequest').mockResolvedValue({
    response: { data: { network: {} } },
  } as never)
  return { adapter: new CrossmarkAdapter(), live }
}

afterEach(() => {
  CrossmarkSDK.default.emit('signout')
  vi.restoreAllMocks()
})

describe('Crossmark approved network', () => {
  it('uses the node returned with approval, not the unhydrated background replica', async () => {
    const { adapter, live } = setup()
    await expect(adapter.connect({ network: 'testnet' })).resolves.toMatchObject({
      address,
      network: { id: 'testnet', wss: testnet.wss, rpc: testnet.rpc },
    })
    expect(live).not.toHaveBeenCalled()
  })

  it('rejects Mainnet approval even if the background replica reports Testnet', async () => {
    const { adapter, live } = setup({ ...testnet, type: 'mainnet', wss: 'wss://s1.ripple.com' })
    live.mockResolvedValue({ response: { data: { network: testnet } } } as never)
    await expect(adapter.connect({ network: 'testnet' })).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
    })
    expect(live).not.toHaveBeenCalled()
    await expect(adapter.getAccount()).resolves.toBeNull()
  })

  it.each([null, {}, { ...testnet, wss: '' }, { ...testnet, type: 1 }])(
    'rejects malformed approval network %j without inventing a replacement',
    async (network) => {
      const { adapter, live } = setup(network)
      live.mockResolvedValue({ response: { data: { network: testnet } } } as never)
      await expect(adapter.connect({ network: 'testnet' })).rejects.toThrow(
        'Crossmark returned incomplete network information',
      )
      expect(live).not.toHaveBeenCalled()
      await expect(adapter.getAccount()).resolves.toBeNull()
    },
  )

  it.each([{}, { ...testnet, type: 'mainnet', wss: 'wss://s1.ripple.com' }])(
    'rejects signing when SDK session network is unavailable or changed',
    async (network) => {
      const { adapter, live } = setup()
      const sign = vi.spyOn(CrossmarkSDK.default.methods, 'signAndWait')
      await adapter.connect({ network: 'testnet' })
      live.mockResolvedValue({ response: { data: { network } } } as never)
      CrossmarkSDK.default.emit('network-change', { network })
      await expect(
        adapter.sign({
          TransactionType: 'Payment',
          Account: address,
          Destination: address,
          Amount: '1',
        }),
      ).rejects.toThrow()
      expect(sign).not.toHaveBeenCalled()
    },
  )

  it('refreshes the account using the SDK session even when the background network is empty', async () => {
    const { adapter, live } = setup()
    await adapter.connect({ network: 'testnet' })
    live.mockResolvedValueOnce({ response: { data: { address } } } as never)
    await expect(adapter.fetchAccount()).resolves.toMatchObject({
      address,
      network: { id: 'testnet', wss: testnet.wss },
    })
    expect(live).toHaveBeenNthCalledWith(1, { command: 'address' })
    expect(live).toHaveBeenCalledTimes(1)
  })

  it('reaches the actual SDK signing method with the reviewed transaction', async () => {
    const { adapter, live } = setup()
    const transaction = {
      TransactionType: 'Payment' as const,
      Account: address,
      Destination: address,
      Amount: '1',
    }
    const sign = vi.spyOn(CrossmarkSDK.default.methods, 'signAndWait').mockResolvedValue({
      response: { data: { txBlob: 'test-only-opaque-result' } },
    } as never)
    await adapter.connect({ network: 'testnet' })
    await expect(adapter.sign(transaction)).resolves.toMatchObject({
      tx_blob: 'test-only-opaque-result',
    })
    expect(sign).toHaveBeenCalledWith(transaction)
    expect(live).not.toHaveBeenCalled()
  })

  it('rejects an empty session overwritten by a late background response, without a cached fallback', async () => {
    const { adapter, live } = setup()
    await adapter.connect({ network: 'testnet' })
    CrossmarkSDK.default.emit('response', {
      request: { id: 'late-network' },
      response: { data: { network: {} } },
    })
    live.mockResolvedValueOnce({ response: { data: { address } } } as never)
    await expect(adapter.fetchAccount()).rejects.toThrow(
      'Crossmark returned incomplete network information',
    )
  })
})
