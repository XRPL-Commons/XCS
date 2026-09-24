import { createXrplConnect } from '@xrpl-commons/xrpl-connect-vue'
import { Client } from 'xrpl'
import type { WalletAdapter } from 'xrpl-connect'
import { resolveBrowserE2eClientMode } from '~/utils/browserE2eMode'
import { createXrplConnectAdapters } from '~/utils/walletAdapters'

export default defineNuxtPlugin(async (nuxtApp) => {
  const config = useRuntimeConfig()
  const browserE2e = resolveBrowserE2eClientMode(config.public.browserE2eMode, import.meta.dev)
  let adapters: WalletAdapter[]
  if (import.meta.dev && browserE2e) {
    const { createBrowserE2eLedgerClient, createBrowserE2eWalletAdapters } =
      await import('~/utils/browserE2eHarness')
    adapters = createBrowserE2eWalletAdapters()
    nuxtApp.vueApp.use(
      createXrplConnect({
        adapters,
        network: 'testnet',
        autoConnect: false,
        logger: { level: 'error' },
      }),
    )
    return {
      provide: {
        xrplClientFactory: () => createBrowserE2eLedgerClient(),
      },
    }
  }

  adapters = createXrplConnectAdapters({
    xamanApiKey: config.public.xamanApiKey,
    walletConnectProjectId: config.public.walletConnectProjectId,
  })
  nuxtApp.vueApp.use(
    createXrplConnect({
      adapters,
      network: 'testnet',
      autoConnect: false,
      logger: { level: import.meta.dev ? 'warn' : 'error' },
    }),
  )

  return {
    provide: {
      xrplClientFactory: (rpcUrl: string) => new Client(rpcUrl),
    },
  }
})
