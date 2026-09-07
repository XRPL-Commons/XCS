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
  type AccountInfo,
  type ConnectOptions,
  type SignedTransaction,
  type Transaction,
  type WalletAdapter,
  type XamanAdapterOptions,
  type XamanConnectOptions,
} from 'xrpl-connect'

const XAMAN_OAUTH_ORIGIN = 'https://oauth2.xumm.app'
const XAMAN_OAUTH_PATHS = new Set(['/auth', '/authorize', '/oauth/auth', '/oauth/authorize'])
const XAMAN_SESSION_STORAGE_KEY = 'XummPkceJwt'
const XRPL_TESTNET_NETWORK_ID = 1

interface XamanSessionStorage {
  getItem(key: string): string | null
  removeItem(key: string): void
}

export interface XrplConnectAdapterConfig {
  readonly xamanApiKey?: string | undefined
  readonly xamanRedirectUrl?: string | undefined
  readonly walletConnectProjectId?: string | undefined
}

interface XcsXamanAdapterOptions extends XamanAdapterOptions {
  readonly redirectUrl?: string | undefined
}

function configuredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function canonicalNetworkId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function cachedXamanNetworkId(value: string): number | undefined {
  try {
    const session = JSON.parse(value) as {
      readonly me?: { readonly networkId?: unknown } | undefined
      readonly jwt?: unknown
    }
    const userInfoNetworkId = canonicalNetworkId(session.me?.networkId)
    if (userInfoNetworkId !== undefined) return userInfoNetworkId
    if (typeof session.jwt !== 'string') return undefined

    const payload = session.jwt.split('.')[1]
    if (!payload) return undefined
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const claims = JSON.parse(atob(padded)) as { readonly network_id?: unknown }
    return canonicalNetworkId(claims.network_id)
  } catch {
    return undefined
  }
}

export function clearMismatchedXamanSession(
  storage: XamanSessionStorage,
  expectedNetworkId: number,
): void {
  try {
    const stored = storage.getItem(XAMAN_SESSION_STORAGE_KEY)
    if (stored && cachedXamanNetworkId(stored) !== expectedNetworkId) {
      storage.removeItem(XAMAN_SESSION_STORAGE_KEY)
    }
  } catch {
    // Xaman handles unavailable browser storage itself; forcing the OAuth URL
    // still protects the new session when storage access is denied.
  }
}

export function forceXamanOAuthNetwork(value: string | URL | undefined): string | URL | undefined {
  return configureXamanOAuthRequest(value)
}

export function configureXamanOAuthRequest(
  value: string | URL | undefined,
  redirectUrl?: string,
): string | URL | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (
      url.origin !== XAMAN_OAUTH_ORIGIN ||
      url.username ||
      url.password ||
      !XAMAN_OAUTH_PATHS.has(url.pathname)
    ) {
      return value
    }
    url.searchParams.set('force_network', 'TESTNET')
    if (redirectUrl) url.searchParams.set('redirect_uri', redirectUrl)
    return url.href
  } catch {
    return value
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * Xaman requires the exact OAuth redirect URL to be registered for the public
 * application key. Use one callback per application origin instead of binding
 * authentication to whichever XCS route happened to open the wallet menu.
 */
export function resolveXamanRedirectUrl(
  configuredRedirectUrl: string | undefined,
  applicationLocation: string,
): string {
  let applicationUrl: URL
  try {
    applicationUrl = new URL(applicationLocation)
  } catch {
    throw new Error('Xaman requires a valid browser application URL')
  }

  if (
    !['http:', 'https:'].includes(applicationUrl.protocol) ||
    applicationUrl.username ||
    applicationUrl.password
  ) {
    throw new Error('Xaman requires an HTTP(S) browser application URL without credentials')
  }
  if (applicationUrl.protocol !== 'https:' && !isLoopbackHostname(applicationUrl.hostname)) {
    throw new Error('Xaman requires HTTPS outside local loopback development')
  }

  const configured = configuredValue(configuredRedirectUrl)
  let redirectUrl: URL
  try {
    redirectUrl = configured ? new URL(configured) : new URL('/', applicationUrl.origin)
  } catch {
    throw new Error('NUXT_PUBLIC_XAMAN_REDIRECT_URL must be an absolute HTTP(S) URL')
  }

  if (
    !['http:', 'https:'].includes(redirectUrl.protocol) ||
    redirectUrl.username ||
    redirectUrl.password
  ) {
    throw new Error('NUXT_PUBLIC_XAMAN_REDIRECT_URL must be an HTTP(S) URL without credentials')
  }
  if (redirectUrl.origin !== applicationUrl.origin) {
    throw new Error('NUXT_PUBLIC_XAMAN_REDIRECT_URL must use the current application origin')
  }
  if (redirectUrl.protocol !== 'https:' && !isLoopbackHostname(redirectUrl.hostname)) {
    throw new Error(
      'NUXT_PUBLIC_XAMAN_REDIRECT_URL must use HTTPS outside local loopback development',
    )
  }
  if (redirectUrl.pathname !== '/' || redirectUrl.search || redirectUrl.hash) {
    throw new Error(
      'NUXT_PUBLIC_XAMAN_REDIRECT_URL must be the application origin with a trailing slash',
    )
  }

  return redirectUrl.href
}

/**
 * Xaman opens its sign request in a browser-owned popup or tab. Once the SDK
 * has received the result, close that auxiliary window and return focus to the
 * application that is continuing the submission flow.
 */
export async function withXamanSignWindow<T>(
  browserWindow: Window,
  action: () => Promise<T>,
): Promise<T> {
  const originalOpen = browserWindow.open
  const signWindow: { current: Window | null } = { current: null }
  const interceptedOpen: typeof window.open = (url, target, features) => {
    const opened = originalOpen.call(browserWindow, url, target, features)
    if (opened) signWindow.current = opened
    return opened
  }
  browserWindow.open = interceptedOpen
  try {
    return await action()
  } finally {
    if (browserWindow.open === interceptedOpen) browserWindow.open = originalOpen
    try {
      if (signWindow.current && !signWindow.current.closed) signWindow.current.close()
    } catch {
      // Cross-origin popup policies may deny inspection or close; focus still
      // returns to the opener when the browser permits it.
    }
    try {
      browserWindow.focus()
    } catch {
      // Focus is a UX enhancement and must never mask the signing result.
    }
  }
}

function requestsXrplTestnet(network: ConnectOptions<XamanConnectOptions>['network']): boolean {
  if (network === 'testnet') return true
  if (!network || typeof network !== 'object') return false
  const normalizedId = network.id.toLowerCase().replace(/[\s_-]/g, '')
  return normalizedId === 'testnet' || normalizedId === 'xrpltestnet'
}

class XcsXamanAdapter extends XamanAdapter {
  readonly #redirectUrl: string | undefined

  public constructor(options: XcsXamanAdapterOptions = {}) {
    const { redirectUrl, ...xamanOptions } = options
    super(xamanOptions)
    this.#redirectUrl = redirectUrl
  }

  public override async connect(
    options?: ConnectOptions<XamanConnectOptions>,
  ): Promise<AccountInfo> {
    if (!requestsXrplTestnet(options?.network) || typeof window === 'undefined') {
      return super.connect(options)
    }

    clearMismatchedXamanSession(window.localStorage, XRPL_TESTNET_NETWORK_ID)
    const redirectUrl = resolveXamanRedirectUrl(this.#redirectUrl, window.location.href)
    const originalOpen = window.open
    const interceptedOpen: typeof window.open = (url, target, features) =>
      originalOpen.call(window, configureXamanOAuthRequest(url, redirectUrl), target, features)
    window.open = interceptedOpen
    try {
      return await super.connect(options)
    } finally {
      if (window.open === interceptedOpen) window.open = originalOpen
    }
  }

  public override async sign(transaction: Transaction): Promise<SignedTransaction> {
    if (typeof window === 'undefined') return super.sign(transaction)
    return withXamanSignWindow(window, () => super.sign(transaction))
  }
}

/**
 * The published 1.0.0 RC reports Otsu as available in every browser. Keep the
 * adapter surface intact while applying the same provider marker check already
 * used by its connect path (fixed upstream after the RC).
 */
class XcsOtsuAdapter extends OtsuAdapter {
  public override async isAvailable(): Promise<boolean> {
    const runtime = globalThis as typeof globalThis & {
      xrpl?: { readonly isOtsu?: boolean }
    }
    return runtime.xrpl?.isOtsu === true
  }
}

/**
 * Register every xrpl-connect adapter that can be initialized with the
 * deployment's public configuration. Xaman and WalletConnect need public app
 * identifiers; the other adapters are self-contained and detect availability
 * in the browser.
 */
export function createXrplConnectAdapters(config: XrplConnectAdapterConfig = {}): WalletAdapter[] {
  const xamanApiKey = configuredValue(config.xamanApiKey)
  const walletConnectProjectId = configuredValue(config.walletConnectProjectId)
  const adapters: WalletAdapter[] = [
    ...(xamanApiKey
      ? [new XcsXamanAdapter({ apiKey: xamanApiKey, redirectUrl: config.xamanRedirectUrl })]
      : []),
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
    new XcsOtsuAdapter(),
    new MetaMaskSnapAdapter(),
  ]

  // XCS never falls back to signAndSubmit: the application must validate and
  // persist the signed transaction before it owns the only submission effect.
  return adapters.filter((adapter) => adapterSupports(adapter, 'sign'))
}
