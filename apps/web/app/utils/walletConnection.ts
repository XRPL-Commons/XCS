import type { AccountInfo, WalletAdapter, WalletManager } from 'xrpl-connect'

type ConnectionManager = Pick<WalletManager, 'connected' | 'connectingWallet' | 'wallets'>

/**
 * Otsu persists a dApp permission by origin and otherwise resolves connect()
 * from that cached address without showing a fresh approval. XCS deliberately
 * requires an explicit wallet approval for each new application connection,
 * so revoke that stale provider permission before handing control back to the
 * official XRPL Connect manager.
 */
export async function prepareExplicitWalletConnection(
  manager: ConnectionManager,
  walletId: string,
): Promise<void> {
  if (manager.connected || manager.connectingWallet) {
    throw new Error('WALLET_CONNECTION_ALREADY_ACTIVE')
  }
  if (walletId !== 'otsu') return

  const adapter: WalletAdapter | undefined = manager.wallets.find(
    (candidate) => candidate.id === walletId,
  )
  if (!adapter) throw new Error('WALLET_ADAPTER_NOT_REGISTERED')
  await adapter.disconnect()
}

export const WALLET_CONNECTION_CANCELLED = 'WALLET_CONNECTION_CANCELLED'
export const WALLET_CONNECTION_TIMEOUT = 'WALLET_CONNECTION_TIMEOUT'

interface WalletConnection {
  readonly manager: ConnectionManager
  connect(walletId: string, options: { network: 'testnet' }): Promise<AccountInfo>
  disconnect(): Promise<void>
}

export const WALLET_REFRESH_TIMEOUT = 'WALLET_REFRESH_TIMEOUT'

/** Invalidate timed-out reads before a late extension reply can update the session. */
export async function refreshWalletAccount(
  wallet: {
    readonly manager: Pick<WalletManager, 'fetchAccount' | 'on' | 'off'>
    disconnect(): Promise<void>
  },
  timeoutMs = 10_000,
): Promise<AccountInfo | null> {
  let stopped: Error | undefined
  let rejectRead!: (error: Error) => void
  const interrupted = new Promise<never>((_, reject) => {
    rejectRead = reject
  })
  const stop = (message: string) => {
    if (stopped) return
    stopped = new Error(message)
    rejectRead(stopped)
  }
  const sessionChanged = () => stop('WALLET_CHANGED_AFTER_PREVIEW')
  wallet.manager.on('connect', sessionChanged)
  wallet.manager.on('disconnecting', sessionChanged)
  wallet.manager.on('disconnect', sessionChanged)
  const timer = setTimeout(() => {
    if (stopped) return
    stop(WALLET_REFRESH_TIMEOUT)
    // The manager invalidates its session generation immediately; extension
    // teardown must not hold the failed read open.
    void wallet.disconnect().catch(() => {
      console.warn('Wallet teardown failed after an account refresh timeout.')
    })
  }, timeoutMs)
  try {
    return await Promise.race([wallet.manager.fetchAccount(), interrupted])
  } catch (cause) {
    throw stopped ?? cause
  } finally {
    clearTimeout(timer)
    wallet.manager.off('connect', sessionChanged)
    wallet.manager.off('disconnecting', sessionChanged)
    wallet.manager.off('disconnect', sessionChanged)
  }
}

/** Bound the SDK wait without letting a late wallet approval create a session. */
export async function connectWallet(
  wallet: WalletConnection,
  walletId: string,
  signal: AbortSignal,
  timeoutMs = 90_000,
  onDisconnectFailure: () => void = () => {
    console.warn('Wallet cleanup failed. Close its pending request before reconnecting.')
  },
): Promise<AccountInfo> {
  if (signal.aborted) throw new Error(WALLET_CONNECTION_CANCELLED)
  let stopped: Error | undefined
  let rejectAttempt: (error: Error) => void = () => undefined
  const interrupted = new Promise<never>((_, reject) => {
    rejectAttempt = reject
  })
  const stop = (code: string) => {
    if (stopped) return
    stopped = new Error(code)
    // The public Vue disconnect API clears its pending state and invalidates
    // the manager's connection generation before a delayed SDK response arrives.
    // Teardown may wait for an extension window indefinitely. Start it to
    // invalidate the attempt, but do not make cancellation depend on it.
    void wallet.disconnect().catch(onDisconnectFailure)
    rejectAttempt(stopped)
  }
  const cancel = () => stop(WALLET_CONNECTION_CANCELLED)
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => stop(WALLET_CONNECTION_TIMEOUT), timeoutMs)
  try {
    const account = await Promise.race([
      (async () => {
        await prepareExplicitWalletConnection(wallet.manager, walletId)
        if (stopped) throw stopped
        return wallet.connect(walletId, { network: 'testnet' })
      })(),
      interrupted,
    ])
    if (stopped) throw stopped
    return account
  } catch (cause) {
    // Disconnect can also reject the SDK request. Keep the actual user action
    // or timeout as the outcome instead of showing a spurious NOT_CONNECTED.
    throw stopped ?? cause
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
