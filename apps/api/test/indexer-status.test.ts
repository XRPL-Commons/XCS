import type { IndexerStatusRow, LedgerCheckpointRow } from '@xcs-protocol/db'
import { describe, expect, it } from 'vitest'

import {
  assertAuthoritativeLedgerEvidence,
  assertIndexerReady,
  publicIndexerStatus,
} from '../src/indexer-status.js'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const NOW_RIPPLE = Math.floor(NOW.getTime() / 1_000) - 946_684_800
const HASH = 'a'.repeat(64)

const status: IndexerStatusRow = {
  profileId: 'testnet',
  state: 'ready',
  primarySourceTip: 100,
  secondarySourceTip: 102,
  lastAgreedLedgerIndex: 100,
  lastAgreedLedgerHash: HASH,
  errorCode: null,
  writerId: 'writer-1',
  writerEpoch: 7,
  leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  updatedAt: NOW,
}

const checkpoint: LedgerCheckpointRow = {
  profileId: 'testnet',
  ledgerIndex: 100,
  ledgerHash: HASH,
  parentHash: 'b'.repeat(64),
  closeTime: NOW_RIPPLE - 10,
  transactionCount: 0,
  transactionRoot: 'c'.repeat(64),
  processedAt: NOW,
}

function evidence(
  overrides: Partial<Parameters<typeof assertAuthoritativeLedgerEvidence>[0]> = {},
) {
  return {
    expectedProfileId: 'testnet',
    status,
    checkpoint,
    now: NOW,
    maxLedgerAgeSeconds: 120,
    ...overrides,
  }
}

describe('authoritative indexer evidence', () => {
  it('accepts a live lease bound exactly to a complete fresh checkpoint', () => {
    expect(() => assertAuthoritativeLedgerEvidence(evidence())).not.toThrow()
  })

  it.each([
    ['expired lease', { status: { ...status, leaseExpiresAt: NOW } }, 'INDEXER_LEASE_EXPIRED'],
    [
      'ledger index mismatch',
      {
        status: {
          ...status,
          primarySourceTip: 101,
          secondarySourceTip: 101,
          lastAgreedLedgerIndex: 101,
        },
      },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'ledger hash mismatch',
      { status: { ...status, lastAgreedLedgerHash: 'd'.repeat(64) } },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'primary source tip above uint32',
      { status: { ...status, primarySourceTip: 4_294_967_296 } },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'secondary source tip above uint32',
      { status: { ...status, secondarySourceTip: 4_294_967_296 } },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'last agreed ledger index above uint32',
      {
        status: {
          ...status,
          primarySourceTip: 4_294_967_296,
          secondarySourceTip: 4_294_967_296,
          lastAgreedLedgerIndex: 4_294_967_296,
        },
      },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'checkpoint ledger index above uint32',
      { checkpoint: { ...checkpoint, ledgerIndex: 4_294_967_296 } },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'close time above uint32',
      { checkpoint: { ...checkpoint, closeTime: 4_294_967_296 } },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'projection newer than checkpoint',
      { projectionLedgerIndexes: [101] },
      'INDEXER_EVIDENCE_INVALID',
    ],
    [
      'projection older than network activation',
      { minimumLedgerIndex: 50, projectionLedgerIndexes: [49] },
      'INDEXER_EVIDENCE_INVALID',
    ],
    ['missing checkpoint', { checkpoint: undefined }, 'INDEXER_NOT_INITIALIZED'],
  ])('rejects %s', (_label, overrides, code) => {
    expect(() => assertAuthoritativeLedgerEvidence(evidence(overrides))).toThrow(
      expect.objectContaining({ code, statusCode: 503 }),
    )
  })

  it('requires both source tips even for a syntactically ready row', () => {
    expect(() => assertIndexerReady({ ...status, secondarySourceTip: null }, NOW)).toThrow(
      expect.objectContaining({ code: 'INDEXER_EVIDENCE_INVALID' }),
    )
  })

  it('keeps writer identity and fencing epoch out of the public DTO', () => {
    const value = publicIndexerStatus(status)
    expect(value).not.toHaveProperty('writerId')
    expect(value).not.toHaveProperty('writerEpoch')
    expect(value).not.toHaveProperty('leaseExpiresAt')
  })

  it('refuses to serialize out-of-range diagnostic ledger evidence', () => {
    expect(() => publicIndexerStatus({ ...status, primarySourceTip: 4_294_967_296 })).toThrow(
      'Stored indexer status has an invalid ledger-evidence shape',
    )
  })
})
