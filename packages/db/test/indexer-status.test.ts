import { describe, expect, it } from 'vitest'

import {
  MAX_INDEXER_LEASE_DURATION_MS,
  MIN_INDEXER_LEASE_DURATION_MS,
  normalizeHaltIndexerStatus,
  normalizeIndexerLeaseRequest,
  normalizeIndexerStatusUpdate,
} from '../src/indexer-fencing.js'

const HASH = 'a'.repeat(64)
const NOW = new Date('2026-08-24T12:00:00.000Z')

describe('indexer status normalization', () => {
  it('accepts ready only at the effective two-source tip', () => {
    expect(
      normalizeIndexerStatusUpdate({
        state: 'ready',
        primarySourceTip: 120,
        secondarySourceTip: 118,
        lastAgreedLedgerIndex: 118,
        lastAgreedLedgerHash: HASH,
      }),
    ).toEqual({
      state: 'ready',
      primarySourceTip: 120,
      secondarySourceTip: 118,
      lastAgreedLedgerIndex: 118,
      lastAgreedLedgerHash: HASH,
      errorCode: null,
    })
  })

  it.each([
    {
      state: 'ready' as const,
      lastAgreedLedgerIndex: 118,
      lastAgreedLedgerHash: HASH,
    },
    {
      state: 'ready' as const,
      primarySourceTip: 120,
      secondarySourceTip: 118,
      lastAgreedLedgerIndex: 117,
      lastAgreedLedgerHash: HASH,
    },
    {
      state: 'catching_up' as const,
      lastAgreedLedgerIndex: 118,
    },
  ])('rejects incomplete or inconsistent status %#', (input) => {
    expect(() => normalizeIndexerStatusUpdate(input)).toThrow()
  })

  it('allows halted evidence to record source tips that regressed', () => {
    expect(
      normalizeHaltIndexerStatus(
        {
          primarySourceTip: 100,
          secondarySourceTip: 99,
          lastAgreedLedgerIndex: 110,
          lastAgreedLedgerHash: HASH,
        },
        'SOURCE_DIVERGENCE',
      ),
    ).toMatchObject({
      state: 'halted',
      primarySourceTip: 100,
      secondarySourceTip: 99,
      lastAgreedLedgerIndex: 110,
      errorCode: 'SOURCE_DIVERGENCE',
    })
  })

  it.each(['raw provider error', '12345', `A${'B'.repeat(64)}`])(
    'rejects unsanitized halt code %s',
    (errorCode) => {
      expect(() => normalizeHaltIndexerStatus({}, errorCode)).toThrow(
        'errorCode must be a sanitized machine code',
      )
    },
  )
})

describe('indexer lease normalization', () => {
  it('accepts the bounded lease duration and computes an absolute expiry', () => {
    expect(
      normalizeIndexerLeaseRequest({
        profileId: 'testnet',
        writerId: 'writer-1',
        leaseDurationMs: MIN_INDEXER_LEASE_DURATION_MS,
        now: NOW,
      }),
    ).toEqual({
      profileId: 'testnet',
      writerId: 'writer-1',
      now: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + MIN_INDEXER_LEASE_DURATION_MS),
    })
  })

  it.each([MIN_INDEXER_LEASE_DURATION_MS - 1, MAX_INDEXER_LEASE_DURATION_MS + 1, 10_000.5])(
    'rejects unsafe lease duration %s',
    (leaseDurationMs) => {
      expect(() =>
        normalizeIndexerLeaseRequest({
          profileId: 'testnet',
          writerId: 'writer-1',
          leaseDurationMs,
          now: NOW,
        }),
      ).toThrow('leaseDurationMs must be an integer')
    },
  )

  it.each([
    { profileId: 'Testnet', writerId: 'writer-1' },
    { profileId: 'testnet', writerId: 'writer with spaces' },
  ])('rejects invalid lease identity %#', ({ profileId, writerId }) => {
    expect(() =>
      normalizeIndexerLeaseRequest({
        profileId,
        writerId,
        leaseDurationMs: MIN_INDEXER_LEASE_DURATION_MS,
        now: NOW,
      }),
    ).toThrow()
  })
})
