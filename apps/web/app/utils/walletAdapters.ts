import {
  CrossmarkAdapter,
  GemWalletAdapter,
  LedgerAdapter,
  MetaMaskSnapAdapter,
  OtsuAdapter,
  WalletConnectAdapter,
  XamanAdapter,
  XyraAdapter,
  adapterSupports,
  type WalletAdapter,
} from 'xrpl-connect'

export interface XrplConnectAdapterConfig {
  readonly xamanApiKey?: string | undefined
  readonly walletConnectProjectId?: string | undefined
}

function configuredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

/**
 * Build the adapters documented by XRPL Connect. Credentials needed for modal
 * discovery are supplied on the adapter constructors. The pinned Crossmark
 * network-response fix is applied by pnpm; no SDK is mocked at runtime.
 */
export function createXrplConnectAdapters(config: XrplConnectAdapterConfig = {}): WalletAdapter[] {
  const xamanApiKey = configuredValue(config.xamanApiKey)
  const walletConnectProjectId = configuredValue(config.walletConnectProjectId)
  const adapters: WalletAdapter[] = [
    ...(xamanApiKey ? [new XamanAdapter({ apiKey: xamanApiKey })] : []),
    new CrossmarkAdapter(),
    new GemWalletAdapter(),
    ...(walletConnectProjectId
      ? [
          new WalletConnectAdapter({
            projectId: walletConnectProjectId,
            useModal: true,
            modalMode: 'always',
            themeMode: 'light',
          }),
        ]
      : []),
    new LedgerAdapter(),
    new XyraAdapter(),
    new OtsuAdapter(),
    new MetaMaskSnapAdapter(),
  ]

  // XCS validates and journals the signed blob before submitting it itself.
  return adapters.filter((adapter) => adapterSupports(adapter, 'sign'))
}
