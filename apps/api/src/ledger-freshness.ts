import { rippleTimeToUnixTime } from 'xrpl'

export const DEFAULT_LEDGER_MAX_AGE_SECONDS = 120
export const MAX_LEDGER_CLOCK_SKEW_SECONDS = 30

export type LedgerCheckpointFreshness = 'fresh' | 'missing' | 'stale'
export type IndexerUnavailableCode =
  | 'INDEXER_NOT_INITIALIZED'
  | 'INDEXER_STALE'
  | 'INDEXER_STATUS_UNAVAILABLE'
  | 'INDEXER_NOT_READY'
  | 'INDEXER_HALTED'
  | 'INDEXER_LEASE_EXPIRED'
  | 'INDEXER_EVIDENCE_INVALID'

export class IndexerUnavailableError extends Error {
  readonly statusCode = 503

  constructor(
    readonly code: IndexerUnavailableCode,
    message: string,
  ) {
    super(message)
    this.name = 'IndexerUnavailableError'
  }
}

export function evaluateLedgerCheckpointFreshness(
  closeTime: number | undefined,
  now: Date,
  maxAgeSeconds: number,
): LedgerCheckpointFreshness {
  if (closeTime === undefined) return 'missing'
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) return 'stale'

  const nowUnixSeconds = Math.floor(now.getTime() / 1_000)
  if (!Number.isSafeInteger(nowUnixSeconds)) return 'stale'

  try {
    const ageSeconds = nowUnixSeconds - Math.floor(rippleTimeToUnixTime(closeTime) / 1_000)
    if (ageSeconds > maxAgeSeconds || ageSeconds < -MAX_LEDGER_CLOCK_SKEW_SECONDS) {
      return 'stale'
    }
    return 'fresh'
  } catch {
    return 'stale'
  }
}

export function assertFreshLedgerCheckpoint(
  closeTime: number | undefined,
  now: Date,
  maxAgeSeconds: number,
): void {
  const freshness = evaluateLedgerCheckpointFreshness(closeTime, now, maxAgeSeconds)
  if (freshness === 'missing') {
    throw new IndexerUnavailableError(
      'INDEXER_NOT_INITIALIZED',
      'The indexer has not produced a ledger checkpoint for this network.',
    )
  }
  if (freshness === 'stale') {
    throw new IndexerUnavailableError(
      'INDEXER_STALE',
      'The indexed ledger checkpoint is stale or has an invalid timestamp.',
    )
  }
}
