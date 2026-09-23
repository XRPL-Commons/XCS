import type { IndexerStatusRow, IndexerStatusState, LedgerCheckpointRow } from '@xcs-protocol/db'

import { assertFreshLedgerCheckpoint, IndexerUnavailableError } from './ledger-freshness.js'

const MAX_UINT32 = 4_294_967_295

function isUint32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_UINT32
}

export interface PublicIndexerStatus {
  profileId: string
  state: IndexerStatusState
  sourceTips: {
    primary: number | null
    secondary: number | null
  }
  lastAgreedLedger: {
    index: number
    hash: string
  } | null
  errorCode: string | null
  updatedAt: string
}

export function publicIndexerStatus(row: IndexerStatusRow): PublicIndexerStatus {
  const hasAgreedIndex = row.lastAgreedLedgerIndex !== null
  const hasAgreedHash = row.lastAgreedLedgerHash !== null
  if (
    hasAgreedIndex !== hasAgreedHash ||
    (row.primarySourceTip !== null && !isUint32(row.primarySourceTip)) ||
    (row.secondarySourceTip !== null && !isUint32(row.secondarySourceTip)) ||
    (row.lastAgreedLedgerIndex !== null && !isUint32(row.lastAgreedLedgerIndex))
  ) {
    throw new Error('Stored indexer status has an invalid ledger-evidence shape')
  }
  return {
    profileId: row.profileId,
    state: row.state,
    sourceTips: {
      primary: row.primarySourceTip,
      secondary: row.secondarySourceTip,
    },
    lastAgreedLedger:
      row.lastAgreedLedgerIndex === null || row.lastAgreedLedgerHash === null
        ? null
        : { index: row.lastAgreedLedgerIndex, hash: row.lastAgreedLedgerHash },
    errorCode: row.errorCode,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function assertIndexerReady(
  status: IndexerStatusRow | undefined,
  now: Date,
): asserts status is IndexerStatusRow {
  if (status === undefined) {
    throw new IndexerUnavailableError(
      'INDEXER_STATUS_UNAVAILABLE',
      'The indexer has not published an integrity status for this network.',
    )
  }
  if (status.state === 'halted') {
    throw new IndexerUnavailableError(
      'INDEXER_HALTED',
      'The indexer halted after detecting an integrity or continuity failure.',
    )
  }
  if (status.state !== 'ready') {
    throw new IndexerUnavailableError(
      'INDEXER_NOT_READY',
      'The indexer has not reached an agreed ledger state.',
    )
  }
  if (
    !Number.isFinite(now.getTime()) ||
    status.writerId === null ||
    status.leaseExpiresAt === null ||
    !Number.isFinite(status.leaseExpiresAt.getTime()) ||
    status.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    throw new IndexerUnavailableError(
      'INDEXER_LEASE_EXPIRED',
      'The indexer does not hold a live writer lease for this network.',
    )
  }
  if (
    status.primarySourceTip === null ||
    status.secondarySourceTip === null ||
    status.lastAgreedLedgerIndex === null ||
    status.lastAgreedLedgerHash === null ||
    !isUint32(status.primarySourceTip) ||
    !isUint32(status.secondarySourceTip) ||
    !isUint32(status.lastAgreedLedgerIndex) ||
    status.lastAgreedLedgerIndex !== Math.min(status.primarySourceTip, status.secondarySourceTip)
  ) {
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'The indexer integrity evidence is incomplete or inconsistent.',
    )
  }
}

export function assertAuthoritativeLedgerEvidence(input: {
  expectedProfileId: string
  status: IndexerStatusRow | undefined
  checkpoint: LedgerCheckpointRow | undefined
  now: Date
  maxLedgerAgeSeconds: number
  minimumLedgerIndex?: number
  projectionLedgerIndexes?: readonly number[]
}): asserts input is typeof input & {
  status: IndexerStatusRow
  checkpoint: LedgerCheckpointRow & { transactionRoot: string }
} {
  assertIndexerReady(input.status, input.now)
  const checkpoint = input.checkpoint
  if (checkpoint === undefined) {
    throw new IndexerUnavailableError(
      'INDEXER_NOT_INITIALIZED',
      'The indexer has not produced a ledger checkpoint for this network.',
    )
  }
  if (
    input.status.profileId !== input.expectedProfileId ||
    checkpoint.profileId !== input.expectedProfileId ||
    input.status.lastAgreedLedgerIndex !== checkpoint.ledgerIndex ||
    input.status.lastAgreedLedgerHash !== checkpoint.ledgerHash ||
    checkpoint.transactionRoot === null ||
    !isUint32(checkpoint.ledgerIndex) ||
    !isUint32(checkpoint.closeTime)
  ) {
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'The indexer integrity evidence is incomplete or inconsistent.',
    )
  }
  if (
    !Number.isInteger(input.minimumLedgerIndex ?? 0) ||
    (input.minimumLedgerIndex ?? 0) < 0 ||
    (input.minimumLedgerIndex ?? 0) > checkpoint.ledgerIndex ||
    input.projectionLedgerIndexes?.some(
      (ledgerIndex) =>
        !Number.isInteger(ledgerIndex) ||
        ledgerIndex < (input.minimumLedgerIndex ?? 0) ||
        ledgerIndex > checkpoint.ledgerIndex,
    ) === true
  ) {
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'The indexer integrity evidence is incomplete or inconsistent.',
    )
  }
  assertFreshLedgerCheckpoint(checkpoint.closeTime, input.now, input.maxLedgerAgeSeconds)
}
