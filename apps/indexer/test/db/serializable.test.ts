import { describe, expect, it, vi } from 'vitest'

import type { XcsDatabase } from '../../src/lib/db/client.js'
import { runSerializableTransaction } from '../../src/lib/db/transactions.js'

function databaseWithResults(results: unknown[]) {
  const transaction = vi.fn(
    async (
      operation: (transaction: unknown) => Promise<unknown>,
      _config?: { isolationLevel?: string },
    ) => {
      const result = results.shift()
      if (result instanceof Error) throw result
      return operation({ result })
    },
  )
  return { database: { transaction } as unknown as XcsDatabase, transaction }
}

function databaseError(code: string, cause?: unknown): Error & { code?: string } {
  const error = new Error(code, cause === undefined ? undefined : { cause }) as Error & {
    code?: string
  }
  if (cause === undefined) error.code = code
  return error
}

describe('runSerializableTransaction', () => {
  it('retries the complete transaction with bounded full-jitter backoff', async () => {
    const nestedSerializationError = databaseError(
      'wrapper',
      databaseError('wrapper', databaseError('40001')),
    )
    const { database, transaction } = databaseWithResults([
      nestedSerializationError,
      databaseError('40P01'),
      'success',
    ])
    const delays: number[] = []

    await expect(
      runSerializableTransaction(
        database,
        async (tx) => (tx as unknown as { result: string }).result,
        {
          random: () => 0.5,
          sleep: async (delayMs) => {
            delays.push(delayMs)
          },
        },
      ),
    ).resolves.toBe('success')
    expect(transaction).toHaveBeenCalledTimes(3)
    expect(transaction.mock.calls.every((call) => call[1]?.isolationLevel === 'serializable')).toBe(
      true,
    )
    expect(delays).toEqual([5, 10])
  })

  it('does not retry non-transaction errors', async () => {
    const failure = databaseError('23505')
    const { database, transaction } = databaseWithResults([failure])

    await expect(
      runSerializableTransaction(database, async () => undefined, {
        sleep: async () => undefined,
      }),
    ).rejects.toBe(failure)
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('stops at the configured retry budget', async () => {
    const failures = Array.from({ length: 5 }, () => databaseError('40001'))
    const { database, transaction } = databaseWithResults(failures)

    await expect(
      runSerializableTransaction(database, async () => undefined, {
        random: () => 0,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: '40001' })
    expect(transaction).toHaveBeenCalledTimes(5)
  })
})
