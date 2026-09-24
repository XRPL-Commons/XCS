import type { WalletAdapter, WalletManager } from 'xrpl-connect'

/** Subscribe before taking the snapshot: Crossmark detects injected providers asynchronously. */
export function observeWalletAvailability(options: {
  manager: Pick<WalletManager, 'getAvailableWallets'>
  events: {
    on(event: string, listener: () => void): unknown
    off(event: string, listener: () => void): unknown
  }
  onChange: (wallets: WalletAdapter[]) => void
  onError: (error: unknown) => void
}): () => void {
  let disposed = false
  let reading = false
  let rerun = false
  const refresh = async () => {
    if (disposed) return
    if (reading) {
      rerun = true
      return
    }
    reading = true
    try {
      do {
        rerun = false
        const wallets = await options.manager.getAvailableWallets()
        if (disposed) return
        // Detection during a read makes that snapshot potentially stale.
        if (!rerun) options.onChange(wallets)
      } while (rerun && !disposed)
    } catch (cause) {
      if (!disposed) options.onError(cause)
    } finally {
      reading = false
    }
  }
  const detected = () => void refresh()
  options.events.on('detected', detected)
  void refresh()
  return () => {
    disposed = true
    options.events.off('detected', detected)
  }
}
