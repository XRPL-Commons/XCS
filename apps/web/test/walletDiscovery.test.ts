import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CrossmarkAdapter, CrossmarkSDK, WalletManager } from 'xrpl-connect'
import { observeWalletAvailability } from '../app/utils/walletDiscovery'

afterEach(() => vi.restoreAllMocks())

describe('live wallet availability', () => {
  it('updates the same open chooser when the real SDK detects Crossmark after its first snapshot', async () => {
    const installed = vi.spyOn(CrossmarkSDK.default.sync, 'isInstalled').mockReturnValue(false)
    // The SDK's own detected listener also asks the extension for its session.
    vi.spyOn(CrossmarkSDK.default.api, 'awaitRequest').mockResolvedValue({
      response: { data: {} },
    } as never)
    const manager = new WalletManager({
      adapters: [new CrossmarkAdapter()],
      logger: { level: 'silent' },
    })
    const onChange = vi.fn()
    const onError = vi.fn()
    const stop = observeWalletAvailability({
      manager,
      events: CrossmarkSDK.default,
      onChange,
      onError,
    })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
    installed.mockReturnValue(true)
    CrossmarkSDK.default.emit('detected')
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith([manager.wallets[0]]))
    expect(onError).not.toHaveBeenCalled()
    stop()
    CrossmarkSDK.default.emit('detected')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('coalesces discovery during a snapshot and ignores completion after the chooser closes', async () => {
    const events = new EventEmitter()
    const adapter = new CrossmarkAdapter()
    let finish!: (wallets: (typeof adapter)[]) => void
    const manager = {
      getAvailableWallets: vi.fn(
        () => new Promise<(typeof adapter)[]>((resolve) => (finish = resolve)),
      ),
    }
    const onChange = vi.fn()
    const stop = observeWalletAvailability({ manager, events, onChange, onError: vi.fn() })
    events.emit('detected')
    events.emit('detected')
    finish([])
    await vi.waitFor(() => expect(manager.getAvailableWallets).toHaveBeenCalledTimes(2))
    expect(onChange).not.toHaveBeenCalled()
    stop()
    finish([adapter])
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalled()
    expect(events.listenerCount('detected')).toBe(0)
  })
})
