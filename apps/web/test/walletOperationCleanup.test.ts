import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishWalletOperation } from '../app/utils/walletOperationCleanup'

afterEach(() => vi.restoreAllMocks())

describe('wallet operation cleanup', () => {
  it('releases busy state when setup failed before creating an RPC client', async () => {
    const busy = { value: true }
    const refresh = vi.fn().mockResolvedValue([])
    await finishWalletOperation(busy, refresh)
    expect(refresh).toHaveBeenCalledOnce()
    expect(busy.value).toBe(false)
  })

  it.each(['history', 'disconnect', 'both'] as const)(
    'keeps the validated result and unlocks the UI despite a %s cleanup failure',
    async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const busy = { value: true }
      const refresh = vi.fn(async () => {
        if (failure !== 'disconnect') throw new Error('history unavailable')
      })
      const client = {
        isConnected: () => true,
        disconnect: vi.fn(async () => {
          if (failure !== 'history') throw new Error('connection close failed')
        }),
      }
      const result = { status: 'validated', transactionResult: 'tesSUCCESS' }
      const operation = async () => {
        try {
          return result
        } finally {
          await finishWalletOperation(busy, refresh, client)
        }
      }
      await expect(operation()).resolves.toBe(result)
      expect(client.disconnect).toHaveBeenCalledOnce()
      expect(busy.value).toBe(false)
    },
  )

  it('preserves the original operation error when cleanup also fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busy = { value: true }
    const original = new Error('wallet approval rejected')
    const operation = async () => {
      try {
        throw original
      } finally {
        await finishWalletOperation(busy, async () => {}, {
          isConnected: () => true,
          disconnect: async () => {
            throw new Error('connection close failed')
          },
        })
      }
    }
    await expect(operation()).rejects.toBe(original)
    expect(busy.value).toBe(false)
  })

  it('does not disconnect an already closed connection', async () => {
    const busy = { value: true }
    const disconnect = vi.fn()
    await finishWalletOperation(busy, async () => {}, {
      isConnected: () => false,
      disconnect,
    })
    expect(disconnect).not.toHaveBeenCalled()
    expect(busy.value).toBe(false)
  })
})
