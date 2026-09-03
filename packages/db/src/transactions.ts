import type { XcsDatabase } from './client.js'

const RETRYABLE_TRANSACTION_ERROR_CODES = new Set(['40001', '40P01'])

export const DEFAULT_SERIALIZABLE_TRANSACTION_ATTEMPTS = 5
export const DEFAULT_SERIALIZABLE_RETRY_BASE_DELAY_MS = 10
export const DEFAULT_SERIALIZABLE_RETRY_MAX_DELAY_MS = 250

export interface SerializableTransactionRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
  sleep?: (delayMs: number) => Promise<void>
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

function databaseErrorCode(error: unknown): string | undefined {
  let candidate = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code
    candidate = 'cause' in candidate ? candidate.cause : undefined
  }
  return undefined
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

/**
 * Retries a complete SERIALIZABLE unit after PostgreSQL serialization failures
 * or deadlocks. Full jitter keeps concurrent callers from immediately colliding
 * again, while the small bounded delay preserves request latency.
 */
export async function runSerializableTransaction<T>(
  database: XcsDatabase,
  operation: (transaction: XcsDatabase) => Promise<T>,
  options: SerializableTransactionRetryOptions = {},
): Promise<T> {
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? DEFAULT_SERIALIZABLE_TRANSACTION_ATTEMPTS,
    'maxAttempts',
  )
  const baseDelayMs = nonNegativeInteger(
    options.baseDelayMs ?? DEFAULT_SERIALIZABLE_RETRY_BASE_DELAY_MS,
    'baseDelayMs',
  )
  const maxDelayMs = nonNegativeInteger(
    options.maxDelayMs ?? DEFAULT_SERIALIZABLE_RETRY_MAX_DELAY_MS,
    'maxDelayMs',
  )
  if (baseDelayMs > maxDelayMs) throw new Error('baseDelayMs must not exceed maxDelayMs')
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await database.transaction(
        async (transaction) => operation(transaction as unknown as XcsDatabase),
        { isolationLevel: 'serializable' },
      )
    } catch (error) {
      const retryable = RETRYABLE_TRANSACTION_ERROR_CODES.has(databaseErrorCode(error) ?? '')
      if (!retryable || attempt === maxAttempts) throw error

      const randomValue = random()
      if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
        throw new Error('random must return a finite number in [0, 1)')
      }
      const delayCapMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      await sleep(Math.floor(randomValue * (delayCapMs + 1)))
    }
  }

  throw new Error('Serializable transaction retry budget exhausted')
}
