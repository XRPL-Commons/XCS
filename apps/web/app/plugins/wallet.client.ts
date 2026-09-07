import { Client } from 'xrpl'
import { WalletManager } from 'xrpl-connect'
import { resolveBrowserE2eClientMode } from '~/utils/browserE2eMode'
import { createXrplConnectAdapters } from '~/utils/walletAdapters'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  const browserE2e = resolveBrowserE2eClientMode(config.public.browserE2eMode, import.meta.dev)
  if (import.meta.dev && browserE2e) {
    const { createBrowserE2eLedgerClient, createBrowserE2eWalletManager } =
      await import('~/utils/browserE2eHarness')
    return {
      provide: {
        walletManager: createBrowserE2eWalletManager(),
        xrplClientFactory: () => createBrowserE2eLedgerClient(),
      },
    }
  }

  const adapters = createXrplConnectAdapters({
    xamanApiKey: config.public.xamanApiKey,
    xamanRedirectUrl: config.public.xamanRedirectUrl,
    walletConnectProjectId: config.public.walletConnectProjectId,
  })
  const walletManager = new WalletManager({
    adapters,
    network: 'testnet',
    autoConnect: false,
    logger: { level: import.meta.dev ? 'warn' : 'error' },
  })

  return {
    provide: {
      walletManager,
      xrplClientFactory: (rpcUrl: string) => new Client(rpcUrl),
    },
  }
})
