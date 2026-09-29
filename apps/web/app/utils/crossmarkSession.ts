import { supportsFetchAccount, type AccountInfo, type WalletManager } from 'xrpl-connect'

const CHANGE_EVENTS = ['user-change', 'network-change'] as const
const REFRESH_TIMEOUT_MS = 10_000
type Refresh = { rerun: boolean; cancel?: () => void }

function sameIdentity(left: AccountInfo, right: AccountInfo | null): boolean {
  return Boolean(
    right &&
    left.address === right.address &&
    left.network.id === right.network.id &&
    left.network.wss === right.network.wss &&
    left.network.rpc === right.network.rpc,
  )
}

/** Crossmark broadcasts profile/node initialization as well as actual changes. */
export function bindCrossmarkSession(options: {
  events: {
    on(event: string, listener: () => void): unknown
    off(event: string, listener: () => void): unknown
  }
  manager: Pick<WalletManager, 'connected' | 'wallet' | 'account' | 'on' | 'off'>
  disconnect: () => Promise<void>
  onError: (error: unknown) => void
}): () => void {
  let disposed = false
  let epoch = 0
  let disconnecting = false
  let refresh: Refresh | undefined
  const reset = () => {
    epoch += 1
    refresh?.cancel?.()
    refresh = undefined
  }
  const isConnected = () =>
    !disposed && options.manager.connected && options.manager.wallet?.id === 'crossmark'

  const invalidate = (reason?: Error) => {
    if (disconnecting || !isConnected()) return
    reset()
    if (reason) options.onError(reason)
    disconnecting = true
    void options
      .disconnect()
      .catch(options.onError)
      .finally(() => {
        disconnecting = false
      })
  }

  const signout = () => invalidate()
  const recheck = () => {
    if (disconnecting || !isConnected()) return
    if (refresh) {
      refresh.rerun = true
      return
    }
    const adapter = options.manager.wallet
    const approved = options.manager.account
    if (!adapter || !approved || !supportsFetchAccount(adapter)) {
      invalidate(new Error('CROSSMARK_SESSION_REFRESH_UNAVAILABLE'))
      return
    }
    const started = epoch
    const job: Refresh = { rerun: false }
    refresh = job
    const current = () =>
      isConnected() && epoch === started && options.manager.wallet === adapter && refresh === job
    void (async () => {
      try {
        do {
          job.rerun = false
          let timer: ReturnType<typeof setTimeout> | undefined
          const deadline = new Promise<never>((_, reject) => {
            job.cancel = () => {
              clearTimeout(timer)
              reject(new Error('CROSSMARK_SESSION_REFRESH_CANCELLED'))
            }
            timer = setTimeout(
              () => reject(new Error('CROSSMARK_SESSION_REFRESH_TIMEOUT')),
              REFRESH_TIMEOUT_MS,
            )
          })
          let account: AccountInfo | null
          try {
            account = await Promise.race([
              Promise.resolve().then(() => adapter.fetchAccount()),
              deadline,
            ])
          } finally {
            clearTimeout(timer)
            job.cancel = undefined
          }
          if (!current()) return
          // A newer event arrived while reading: inspect its final state first.
          if (job.rerun) continue
          if (!sameIdentity(approved, account)) invalidate(new Error('CROSSMARK_SESSION_CHANGED'))
        } while (job.rerun && current())
      } catch (error) {
        if (current())
          invalidate(
            new Error(
              error instanceof Error && error.message === 'CROSSMARK_SESSION_REFRESH_TIMEOUT'
                ? error.message
                : 'CROSSMARK_SESSION_REFRESH_FAILED',
            ),
          )
      } finally {
        if (refresh === job) refresh = undefined
      }
    })()
  }

  options.manager.on('connect', reset)
  options.manager.on('disconnect', reset)
  options.events.on('signout', signout)
  for (const event of CHANGE_EVENTS) options.events.on(event, recheck)

  return () => {
    disposed = true
    reset()
    options.manager.off('connect', reset)
    options.manager.off('disconnect', reset)
    options.events.off('signout', signout)
    for (const event of CHANGE_EVENTS) options.events.off(event, recheck)
  }
}
