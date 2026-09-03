import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'

import type { XcsDatabase } from './client.js'
import {
  INDEXER_STATUS_STATES,
  indexerIncidents,
  indexerStatuses,
  type IndexerStatusRow,
  type IndexerStatusState,
} from './schema/index.js'

const UINT32_MAX = 4_294_967_295
const MAX_SAFE_EPOCH = Number.MAX_SAFE_INTEGER
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const WRITER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export const MIN_INDEXER_LEASE_DURATION_MS = 10_000
export const MAX_INDEXER_LEASE_DURATION_MS = 300_000

export interface IndexerLeaseToken {
  profileId: string
  writerId: string
  epoch: number
}

export interface AcquiredIndexerLease extends IndexerLeaseToken {
  leaseExpiresAt: Date
}

export interface AcquireIndexerLeaseInput {
  profileId: string
  writerId: string
  leaseDurationMs: number
  now?: Date
}

export interface RenewIndexerLeaseInput {
  leaseDurationMs: number
  now?: Date
}

export interface NormalizedIndexerLeaseRequest {
  profileId: string
  writerId: string
  now: Date
  leaseExpiresAt: Date
}

export interface IndexerStatusWriteOptions {
  now?: Date
}

export type WritableIndexerStatusState = Exclude<IndexerStatusState, 'halted'>

export interface IndexerStatusUpdateInput {
  state: WritableIndexerStatusState
  primarySourceTip?: number | null
  secondarySourceTip?: number | null
  lastAgreedLedgerIndex?: number | null
  lastAgreedLedgerHash?: string | null
}

export interface HaltIndexerStatusInput {
  primarySourceTip?: number | null
  secondarySourceTip?: number | null
  lastAgreedLedgerIndex?: number | null
  lastAgreedLedgerHash?: string | null
}

export interface NormalizedIndexerStatus {
  state: IndexerStatusState
  primarySourceTip: number | null
  secondarySourceTip: number | null
  lastAgreedLedgerIndex: number | null
  lastAgreedLedgerHash: string | null
  errorCode: string | null
}

export type IndexerLeaseErrorCode = 'INDEXER_LEASE_UNAVAILABLE' | 'INDEXER_LEASE_LOST'

export class IndexerLeaseError extends Error {
  constructor(readonly code: IndexerLeaseErrorCode) {
    super(code)
    this.name = 'IndexerLeaseError'
  }
}

function validDate(value: Date | undefined): Date {
  const date = value ?? new Date()
  if (!Number.isFinite(date.getTime())) throw new Error('now must be a valid date')
  return date
}

function databaseNow(value: Date | undefined) {
  // clock_timestamp() is evaluated after a blocked row lock is acquired.
  // CURRENT_TIMESTAMP is frozen at transaction start and could renew a lease
  // to an instant that already passed while the statement was waiting.
  return value === undefined ? sql`clock_timestamp()` : validDate(value)
}

function nullableUint32(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${field} must be a nullable uint32`)
  }
  return value
}

function sanitizedErrorCode(value: string): string {
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw new Error('errorCode must be a sanitized machine code')
  }
  return value
}

function normalizeStatus(
  input:
    IndexerStatusUpdateInput | (HaltIndexerStatusInput & { state: 'halted'; errorCode: string }),
): NormalizedIndexerStatus {
  if (!INDEXER_STATUS_STATES.includes(input.state)) throw new Error('state is invalid')

  const primarySourceTip = nullableUint32(input.primarySourceTip, 'primarySourceTip')
  const secondarySourceTip = nullableUint32(input.secondarySourceTip, 'secondarySourceTip')
  const lastAgreedLedgerIndex = nullableUint32(input.lastAgreedLedgerIndex, 'lastAgreedLedgerIndex')
  const lastAgreedLedgerHash = input.lastAgreedLedgerHash ?? null

  if ((lastAgreedLedgerIndex === null) !== (lastAgreedLedgerHash === null)) {
    throw new Error('last agreed ledger index and hash must be provided together')
  }
  if (lastAgreedLedgerHash !== null && !HASH_PATTERN.test(lastAgreedLedgerHash)) {
    throw new Error('lastAgreedLedgerHash must be lowercase 32-byte hexadecimal')
  }

  if (input.state !== 'halted' && lastAgreedLedgerIndex !== null) {
    if (primarySourceTip !== null && lastAgreedLedgerIndex > primarySourceTip) {
      throw new Error('last agreed ledger cannot exceed the primary source tip')
    }
    if (secondarySourceTip !== null && lastAgreedLedgerIndex > secondarySourceTip) {
      throw new Error('last agreed ledger cannot exceed the secondary source tip')
    }
  }

  if (input.state === 'ready') {
    if (
      primarySourceTip === null ||
      secondarySourceTip === null ||
      lastAgreedLedgerIndex === null ||
      lastAgreedLedgerHash === null
    ) {
      throw new Error('ready status requires both source tips and a last agreed ledger')
    }
    if (lastAgreedLedgerIndex !== Math.min(primarySourceTip, secondarySourceTip)) {
      throw new Error('ready status must agree with the effective source tip')
    }
  }

  return {
    state: input.state,
    primarySourceTip,
    secondarySourceTip,
    lastAgreedLedgerIndex,
    lastAgreedLedgerHash,
    errorCode: input.state === 'halted' ? sanitizedErrorCode(input.errorCode) : null,
  }
}

export function normalizeIndexerStatusUpdate(
  input: IndexerStatusUpdateInput,
): NormalizedIndexerStatus {
  return normalizeStatus(input)
}

export function normalizeHaltIndexerStatus(
  input: HaltIndexerStatusInput,
  errorCode: string,
): NormalizedIndexerStatus {
  return normalizeStatus({ ...input, state: 'halted', errorCode })
}

function normalizeLeaseDuration(leaseDurationMs: number): number {
  if (
    !Number.isInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_INDEXER_LEASE_DURATION_MS ||
    leaseDurationMs > MAX_INDEXER_LEASE_DURATION_MS
  ) {
    throw new Error(
      `leaseDurationMs must be an integer between ${MIN_INDEXER_LEASE_DURATION_MS} and ${MAX_INDEXER_LEASE_DURATION_MS}`,
    )
  }
  return leaseDurationMs
}

function normalizeToken(token: IndexerLeaseToken): IndexerLeaseToken {
  if (!PROFILE_ID_PATTERN.test(token.profileId)) throw new Error('profileId is invalid')
  if (!WRITER_ID_PATTERN.test(token.writerId)) throw new Error('writerId is invalid')
  if (!Number.isSafeInteger(token.epoch) || token.epoch < 1 || token.epoch > MAX_SAFE_EPOCH) {
    throw new Error('epoch must be a positive safe integer')
  }
  return token
}

function leaseExpiration(now: Date, leaseDurationMs: number): Date {
  const expiresAt = new Date(now.getTime() + normalizeLeaseDuration(leaseDurationMs))
  if (!Number.isFinite(expiresAt.getTime())) throw new Error('lease expiration is invalid')
  return expiresAt
}

function databaseLeaseExpiration(value: Date | undefined, leaseDurationMs: number) {
  return value === undefined
    ? sql`clock_timestamp() + (${leaseDurationMs}::bigint * interval '1 millisecond')`
    : leaseExpiration(validDate(value), leaseDurationMs)
}

export function normalizeIndexerLeaseRequest(
  input: AcquireIndexerLeaseInput,
): NormalizedIndexerLeaseRequest {
  const token = normalizeToken({ profileId: input.profileId, writerId: input.writerId, epoch: 1 })
  const now = validDate(input.now)
  return {
    profileId: token.profileId,
    writerId: token.writerId,
    now,
    leaseExpiresAt: leaseExpiration(now, input.leaseDurationMs),
  }
}

function acquiredLease(row: IndexerStatusRow): AcquiredIndexerLease {
  if (row.writerId === null || row.leaseExpiresAt === null) {
    throw new Error('indexer lease write returned an inactive lease')
  }
  return {
    profileId: row.profileId,
    writerId: row.writerId,
    epoch: row.writerEpoch,
    leaseExpiresAt: row.leaseExpiresAt,
  }
}

function tokenFilter(token: IndexerLeaseToken) {
  return and(
    eq(indexerStatuses.profileId, token.profileId),
    eq(indexerStatuses.writerId, token.writerId),
    eq(indexerStatuses.writerEpoch, token.epoch),
  )
}

function activeTokenFilter(token: IndexerLeaseToken, now: ReturnType<typeof databaseNow>) {
  return and(tokenFilter(token), gt(indexerStatuses.leaseExpiresAt, now))
}

export async function readIndexerStatus(
  database: XcsDatabase,
  profileId: string,
): Promise<IndexerStatusRow | undefined> {
  const [row] = await database
    .select()
    .from(indexerStatuses)
    .where(eq(indexerStatuses.profileId, profileId))
    .limit(1)
  return row
}

export async function acquireIndexerLease(
  database: XcsDatabase,
  input: AcquireIndexerLeaseInput,
): Promise<AcquiredIndexerLease> {
  const lease = normalizeIndexerLeaseRequest(input)
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as XcsDatabase
    const [inserted] = await tx
      .insert(indexerStatuses)
      .values({
        profileId: lease.profileId,
        state: 'starting',
        primarySourceTip: null,
        secondarySourceTip: null,
        lastAgreedLedgerIndex: null,
        lastAgreedLedgerHash: null,
        errorCode: null,
        writerId: null,
        writerEpoch: 1,
        leaseExpiresAt: null,
        updatedAt: databaseNow(input.now),
      })
      .onConflictDoNothing()
      .returning({ profileId: indexerStatuses.profileId })

    // A separate locked read makes every clock expression in the following
    // UPDATE run after conflict/row-lock waits, never before them.
    await tx
      .select({ profileId: indexerStatuses.profileId })
      .from(indexerStatuses)
      .where(eq(indexerStatuses.profileId, lease.profileId))
      .for('update')
      .limit(1)

    const now = databaseNow(input.now)
    const [row] = await tx
      .update(indexerStatuses)
      .set({
        state: 'starting',
        primarySourceTip: null,
        secondarySourceTip: null,
        lastAgreedLedgerIndex: null,
        lastAgreedLedgerHash: null,
        errorCode: null,
        writerId: lease.writerId,
        writerEpoch:
          inserted === undefined
            ? sql`${indexerStatuses.writerEpoch} + 1`
            : indexerStatuses.writerEpoch,
        leaseExpiresAt: databaseLeaseExpiration(input.now, input.leaseDurationMs),
        updatedAt: now,
      })
      .where(
        inserted === undefined
          ? and(
              eq(indexerStatuses.profileId, lease.profileId),
              or(isNull(indexerStatuses.leaseExpiresAt), lte(indexerStatuses.leaseExpiresAt, now)),
              lte(indexerStatuses.writerEpoch, MAX_SAFE_EPOCH - 1),
            )
          : eq(indexerStatuses.profileId, lease.profileId),
      )
      .returning()
    if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_UNAVAILABLE')
    return acquiredLease(row)
  })
}

export async function renewIndexerLease(
  database: XcsDatabase,
  tokenInput: IndexerLeaseToken,
  input: RenewIndexerLeaseInput,
): Promise<AcquiredIndexerLease> {
  const token = normalizeToken(tokenInput)
  normalizeLeaseDuration(input.leaseDurationMs)
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as XcsDatabase
    await tx
      .select({ profileId: indexerStatuses.profileId })
      .from(indexerStatuses)
      .where(tokenFilter(token))
      .for('update')
      .limit(1)

    const now = databaseNow(input.now)
    const [row] = await tx
      .update(indexerStatuses)
      .set({
        leaseExpiresAt: databaseLeaseExpiration(input.now, input.leaseDurationMs),
        updatedAt: now,
      })
      .where(activeTokenFilter(token, now))
      .returning()
    if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_LOST')
    return acquiredLease(row)
  })
}

export async function updateIndexerStatus(
  database: XcsDatabase,
  tokenInput: IndexerLeaseToken,
  input: IndexerStatusUpdateInput,
  options: IndexerStatusWriteOptions = {},
): Promise<IndexerStatusRow> {
  const token = normalizeToken(tokenInput)
  const value = normalizeIndexerStatusUpdate(input)
  const now = databaseNow(options.now)
  const [row] = await database
    .update(indexerStatuses)
    .set({ ...value, updatedAt: now })
    .where(activeTokenFilter(token, now))
    .returning()
  if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_LOST')
  return row
}

export async function releaseIndexerLease(
  database: XcsDatabase,
  tokenInput: IndexerLeaseToken,
  options: IndexerStatusWriteOptions = {},
): Promise<IndexerStatusRow> {
  const token = normalizeToken(tokenInput)
  const now = databaseNow(options.now)
  const [row] = await database
    .update(indexerStatuses)
    .set({
      state: 'catching_up',
      errorCode: null,
      writerId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(tokenFilter(token))
    .returning()
  if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_LOST')
  return row
}

export async function haltIndexer(
  database: XcsDatabase,
  tokenInput: IndexerLeaseToken,
  input: HaltIndexerStatusInput,
  errorCode: string,
  options: IndexerStatusWriteOptions = {},
): Promise<IndexerStatusRow> {
  const token = normalizeToken(tokenInput)
  const value = normalizeHaltIndexerStatus(input, errorCode)
  const now = databaseNow(options.now)
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as XcsDatabase
    const [row] = await tx
      .update(indexerStatuses)
      .set({ ...value, writerId: null, leaseExpiresAt: null, updatedAt: now })
      .where(tokenFilter(token))
      .returning()
    if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_LOST')

    await tx.insert(indexerIncidents).values({
      profileId: token.profileId,
      writerEpoch: token.epoch,
      errorCode: value.errorCode!,
      primarySourceTip: value.primarySourceTip,
      secondarySourceTip: value.secondarySourceTip,
      lastAgreedLedgerIndex: value.lastAgreedLedgerIndex,
      lastAgreedLedgerHash: value.lastAgreedLedgerHash,
      recordedAt: now,
    })
    return row
  })
}

/**
 * Locks and validates the fencing row. Call this inside the same transaction
 * that persists a ledger so a lease takeover cannot race the projection write.
 */
export async function lockActiveIndexerLease(
  database: XcsDatabase,
  tokenInput: IndexerLeaseToken,
  options: IndexerStatusWriteOptions = {},
): Promise<IndexerStatusRow> {
  const token = normalizeToken(tokenInput)
  const [row] = await database
    .select()
    .from(indexerStatuses)
    .where(activeTokenFilter(token, databaseNow(options.now)))
    .for('update')
    .limit(1)
  if (row === undefined) throw new IndexerLeaseError('INDEXER_LEASE_LOST')
  return row
}
