import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindCrossmarkSession } from '../app/utils/crossmarkSession'

function setup(connected = true, walletId = 'crossmark') {
  const events = new EventEmitter()
  const managerEvents = new EventEmitter()
  const account = {
    address: 'approved-address',
    network: {
      id: 'testnet',
      name: 'Testnet',
      wss: 'wss://test.example',
      rpc: 'https://test.example',
    },
  }
  const fetchAccount = vi.fn(async () => structuredClone(account) as typeof account | null)
  const manager = {
    connected,
    account,
    wallet: { id: walletId, fetchAccount } as unknown as Parameters<
      typeof bindCrossmarkSession
    >[0]['manager']['wallet'],
    on: managerEvents.on.bind(managerEvents) as Parameters<
      typeof bindCrossmarkSession
    >[0]['manager']['on'],
    off: managerEvents.off.bind(managerEvents) as Parameters<
      typeof bindCrossmarkSession
    >[0]['manager']['off'],
  }
  const disconnect = vi.fn(async () => {})
  const onError = vi.fn()
  const unbind = bindCrossmarkSession({ events, manager, disconnect, onError })
  return { events, manager, managerEvents, account, fetchAccount, disconnect, onError, unbind }
}

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe('Crossmark session invalidation', () => {
  it('disconnects immediately on explicit signout', () => {
    const { events, disconnect, fetchAccount } = setup()
    events.emit('signout')
    expect(disconnect).toHaveBeenCalledOnce()
    expect(fetchAccount).not.toHaveBeenCalled()
  })

  it.each(['user-change', 'network-change'])(
    'preserves an approved session on duplicate %s',
    async (event) => {
      const { events, disconnect, fetchAccount } = setup()
      events.emit(event)
      await settle()
      expect(fetchAccount).toHaveBeenCalledOnce()
      expect(disconnect).not.toHaveBeenCalled()
    },
  )

  it.each(['address', 'id', 'wss', 'rpc', 'missing'])('invalidates a changed %s', async (field) => {
    const { events, account, fetchAccount, disconnect, onError } = setup()
    const updated = structuredClone(account)
    if (field === 'address') updated.address = 'different'
    else if (field !== 'missing') updated.network[field as 'id' | 'wss' | 'rpc'] = 'different'
    fetchAccount.mockResolvedValueOnce(field === 'missing' ? null : updated)
    events.emit('user-change')
    await settle()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(new Error('CROSSMARK_SESSION_CHANGED'))
  })

  it('rechecks a burst after the outstanding read completes', async () => {
    const { events, account, fetchAccount, disconnect } = setup()
    let finish!: (value: typeof account) => void
    fetchAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    events.emit('user-change')
    await settle()
    events.emit('network-change')
    events.emit('user-change')
    expect(fetchAccount).toHaveBeenCalledOnce()
    finish({ ...account, address: 'intermediate' })
    await settle()
    expect(fetchAccount).toHaveBeenCalledTimes(2)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it.each(['reconnect', 'unmount'])('ignores stale results after %s', async (action) => {
    const { events, managerEvents, account, fetchAccount, disconnect, onError, unbind } = setup()
    let finish!: (value: typeof account) => void
    fetchAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    events.emit('user-change')
    await settle()
    if (action === 'unmount') unbind()
    else {
      managerEvents.emit('disconnect')
      managerEvents.emit('connect', account)
    }
    finish({ ...account, address: 'old-account' })
    await settle()
    expect(disconnect).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('bounds stalled reads and handles a late rejection', async () => {
    vi.useFakeTimers()
    const { events, fetchAccount, disconnect, onError } = setup()
    let reject!: (error: Error) => void
    fetchAccount.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    events.emit('network-change')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(new Error('CROSSMARK_SESSION_REFRESH_TIMEOUT'))
    reject(new Error('LATE_FAILURE'))
    await settle()
    expect(onError).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears an unverifiable session with an explicit error', async () => {
    const { events, fetchAccount, disconnect, onError } = setup()
    fetchAccount.mockRejectedValueOnce(new Error('provider detail'))
    events.emit('network-change')
    await settle()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(new Error('CROSSMARK_SESSION_REFRESH_FAILED'))
  })

  it('does not interrupt a pending sign-in or connect a disconnected wallet', () => {
    const { events, disconnect } = setup(false)
    events.emit('user-change')
    events.emit('network-change')
    events.emit('signout')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('does not disconnect a different wallet', () => {
    const { events, disconnect } = setup(true, 'otsu')
    events.emit('signout')
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('coalesces session-change events while disconnect is pending', async () => {
    const { events, disconnect } = setup()
    let finish!: () => void
    disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    events.emit('network-change')
    events.emit('user-change')
    events.emit('signout')
    expect(disconnect).toHaveBeenCalledOnce()
    finish()
    await disconnect.mock.results[0]?.value
  })

  it('removes only its own listeners when the component unmounts', () => {
    const { events, managerEvents, disconnect, unbind } = setup()
    const otherListener = vi.fn()
    events.on('signout', otherListener)
    unbind()
    unbind()
    events.emit('signout')
    events.emit('user-change')
    events.emit('network-change')
    expect(disconnect).not.toHaveBeenCalled()
    expect(otherListener).toHaveBeenCalledOnce()
    expect(events.listenerCount('signout')).toBe(1)
    expect(events.listenerCount('user-change')).toBe(0)
    expect(events.listenerCount('network-change')).toBe(0)
    expect(managerEvents.listenerCount('connect')).toBe(0)
    expect(managerEvents.listenerCount('disconnect')).toBe(0)
  })

  it('reports disconnect failures and permits a later invalidation', async () => {
    const { events, disconnect, onError } = setup()
    const error = new Error('DISCONNECT_FAILED')
    disconnect.mockRejectedValueOnce(error)
    events.emit('signout')
    await expect(disconnect.mock.results[0]?.value).rejects.toBe(error)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
    events.emit('signout')
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
