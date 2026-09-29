import { XamanAdapter, WalletErrorCode } from 'xrpl-connect'
import { describe, expect, it } from 'vitest'

describe('Xaman public connection guards', () => {
  it('requires application configuration before opening an approval', async () => {
    const adapter = new XamanAdapter()
    await expect(adapter.connect({ network: 'testnet' })).rejects.toMatchObject({
      code: WalletErrorCode.CONFIGURATION_REQUIRED,
    })
    await expect(adapter.getAccount()).resolves.toBeNull()
  })

  it('rejects contradictory network identifiers before opening an approval', async () => {
    const adapter = new XamanAdapter({ apiKey: '00000000-0000-0000-0000-000000000000' })
    await expect(
      adapter.connect({
        network: {
          id: 'testnet',
          name: 'Testnet',
          wss: 'wss://s.altnet.rippletest.net:51233',
          walletConnectId: 'xrpl:0',
        },
      }),
    ).rejects.toMatchObject({ code: WalletErrorCode.NETWORK_MISMATCH })
    await expect(adapter.getAccount()).resolves.toBeNull()
  })
})
