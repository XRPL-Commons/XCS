import { describe, expect, it } from 'vitest'

import {
  evaluateLedgerCheckpointFreshness,
  MAX_LEDGER_CLOCK_SKEW_SECONDS,
} from '../../server/xcs/ledger-freshness.js'

const NOW = new Date('2026-08-19T00:00:00.000Z')
const NOW_RIPPLE = Math.floor(NOW.getTime() / 1_000) - 946_684_800

describe('ledger checkpoint freshness', () => {
  it('reports a missing checkpoint separately', () => {
    expect(evaluateLedgerCheckpointFreshness(undefined, NOW, 120)).toBe('missing')
  })

  it('accepts the configured maximum age boundary', () => {
    expect(evaluateLedgerCheckpointFreshness(NOW_RIPPLE - 120, NOW, 120)).toBe('fresh')
    expect(evaluateLedgerCheckpointFreshness(NOW_RIPPLE - 121, NOW, 120)).toBe('stale')
  })

  it('accepts at most 30 seconds of future ledger clock skew', () => {
    expect(
      evaluateLedgerCheckpointFreshness(NOW_RIPPLE + MAX_LEDGER_CLOCK_SKEW_SECONDS, NOW, 120),
    ).toBe('fresh')
    expect(
      evaluateLedgerCheckpointFreshness(NOW_RIPPLE + MAX_LEDGER_CLOCK_SKEW_SECONDS + 1, NOW, 120),
    ).toBe('stale')
  })

  it('fails closed for invalid timestamps or policy values', () => {
    expect(evaluateLedgerCheckpointFreshness(-1, NOW, 120)).toBe('stale')
    expect(evaluateLedgerCheckpointFreshness(NOW_RIPPLE, new Date(Number.NaN), 120)).toBe('stale')
    expect(evaluateLedgerCheckpointFreshness(NOW_RIPPLE, NOW, -1)).toBe('stale')
  })
})
