import type { XcsDatabase } from '@xcs-protocol/db'
import { sql } from 'drizzle-orm'

import {
  OperationalMetricsEvidenceError,
  type OperationalIndexerState,
  type OperationalMetricsProfileSnapshot,
  type OperationalMetricsRepository,
} from './operational-metrics.js'

const INDEXER_STATES = new Set<OperationalIndexerState>([
  'starting',
  'catching_up',
  'ready',
  'halted',
])
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const HASH = /^[0-9a-f]{64}$/u
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u
const MAX_UINT32 = 4_294_967_295

interface DatabaseMetricsRow extends Record<string, unknown> {
  observedAt: Date | string
  usedConnections: string
  maxConnections: string
  sizeBytes: string
}

interface ProfileMetricsRow extends Record<string, unknown> {
  profileId: string
  activationLedgerIndex: string
  state: string | null
  primarySourceTip: string | null
  secondarySourceTip: string | null
  lastAgreedLedgerIndex: string | null
  lastAgreedLedgerHash: string | null
  errorCode: string | null
  writerPresent: boolean
  leaseExpiresAt: Date | string | null
  statusUpdatedAt: Date | string | null
  checkpointLedgerIndex: string | null
  checkpointLedgerHash: string | null
  checkpointCloseTime: string | null
  checkpointTransactionRootPresent: boolean
  acceptedRegistrations: string
  rejectedRegistrations: string
  haltCount: string
  latestHaltWriterEpoch: string | null
  latestHaltErrorCode: string | null
  latestHaltPrimarySourceTip: string | null
  latestHaltSecondarySourceTip: string | null
  latestHaltLastAgreedLedgerIndex: string | null
  latestHaltLastAgreedLedgerHashPresent: boolean
  latestHaltRecordedAt: Date | string | null
}

function nonNegativeSafeInteger(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new OperationalMetricsEvidenceError(`${label} is invalid`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new OperationalMetricsEvidenceError(`${label} exceeds the safe integer range`)
  }
  return parsed
}

function nullableNonNegativeSafeInteger(value: string | null, label: string): number | null {
  return value === null ? null : nonNegativeSafeInteger(value, label)
}

function databaseDate(value: Date | string, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new OperationalMetricsEvidenceError(`${label} is invalid`)
  }
  return parsed
}

function nullableUint32(value: string | null, label: string): number | null {
  const parsed = nullableNonNegativeSafeInteger(value, label)
  if (parsed !== null && parsed > MAX_UINT32) {
    throw new OperationalMetricsEvidenceError(`${label} exceeds the uint32 range`)
  }
  return parsed
}

function uint32(value: string, label: string): number {
  const parsed = nonNegativeSafeInteger(value, label)
  if (parsed > MAX_UINT32) {
    throw new OperationalMetricsEvidenceError(`${label} exceeds the uint32 range`)
  }
  return parsed
}

function positiveSafeInteger(value: string, label: string): number {
  const parsed = nonNegativeSafeInteger(value, label)
  if (parsed === 0) {
    throw new OperationalMetricsEvidenceError(`${label} must be positive`)
  }
  return parsed
}

function positiveUint32(value: string, label: string): number {
  const parsed = uint32(value, label)
  if (parsed === 0) {
    throw new OperationalMetricsEvidenceError(`${label} must be positive`)
  }
  return parsed
}

function profileSnapshot(row: ProfileMetricsRow): OperationalMetricsProfileSnapshot {
  if (!PROFILE_ID.test(row.profileId)) {
    throw new OperationalMetricsEvidenceError('Operational profile id is invalid')
  }
  const hasStatus = row.state !== null
  const hasAnyStatusEvidence =
    row.primarySourceTip !== null ||
    row.secondarySourceTip !== null ||
    row.lastAgreedLedgerIndex !== null ||
    row.lastAgreedLedgerHash !== null ||
    row.errorCode !== null ||
    row.writerPresent ||
    row.leaseExpiresAt !== null ||
    row.statusUpdatedAt !== null
  if ((!hasStatus && hasAnyStatusEvidence) || (hasStatus && row.statusUpdatedAt === null)) {
    throw new OperationalMetricsEvidenceError('Operational status evidence is inconsistent')
  }
  if (row.state !== null && !INDEXER_STATES.has(row.state as OperationalIndexerState)) {
    throw new OperationalMetricsEvidenceError('Operational status state is invalid')
  }
  if (
    (row.errorCode !== null && !ERROR_CODE.test(row.errorCode)) ||
    (row.state === 'halted') !== (row.errorCode !== null)
  ) {
    throw new OperationalMetricsEvidenceError('Operational status evidence is invalid')
  }
  if (row.writerPresent !== (row.leaseExpiresAt !== null)) {
    throw new OperationalMetricsEvidenceError('Operational writer lease evidence is inconsistent')
  }
  if (
    (row.lastAgreedLedgerIndex === null) !== (row.lastAgreedLedgerHash === null) ||
    (row.lastAgreedLedgerHash !== null && !HASH.test(row.lastAgreedLedgerHash))
  ) {
    throw new OperationalMetricsEvidenceError('Operational agreed-ledger evidence is inconsistent')
  }

  const hasCheckpoint = row.checkpointLedgerIndex !== null
  if (
    hasCheckpoint !== (row.checkpointLedgerHash !== null) ||
    hasCheckpoint !== (row.checkpointCloseTime !== null)
  ) {
    throw new OperationalMetricsEvidenceError('Operational checkpoint evidence is inconsistent')
  }
  if (row.checkpointLedgerHash !== null && !HASH.test(row.checkpointLedgerHash)) {
    throw new OperationalMetricsEvidenceError('Operational checkpoint evidence is invalid')
  }
  const haltCount = nonNegativeSafeInteger(row.haltCount, 'durable halt count')
  const latestHaltPresent = row.latestHaltWriterEpoch !== null
  const latestHaltRequired = [row.latestHaltErrorCode, row.latestHaltRecordedAt]
  const latestHaltOptional = [
    row.latestHaltPrimarySourceTip,
    row.latestHaltSecondarySourceTip,
    row.latestHaltLastAgreedLedgerIndex,
  ]
  if (
    (haltCount === 0) !== !latestHaltPresent ||
    latestHaltRequired.some((value) => (latestHaltPresent ? value === null : value !== null)) ||
    (!latestHaltPresent && latestHaltOptional.some((value) => value !== null)) ||
    (row.latestHaltLastAgreedLedgerIndex === null) !== !row.latestHaltLastAgreedLedgerHashPresent ||
    (row.latestHaltErrorCode !== null && !ERROR_CODE.test(row.latestHaltErrorCode))
  ) {
    throw new OperationalMetricsEvidenceError('Operational halt history evidence is inconsistent')
  }

  return {
    profileId: row.profileId,
    activationLedgerIndex: positiveUint32(row.activationLedgerIndex, 'activation ledger index'),
    status:
      row.state === null || row.statusUpdatedAt === null
        ? undefined
        : {
            state: row.state as OperationalIndexerState,
            primarySourceTip: nullableUint32(row.primarySourceTip, 'primary source tip'),
            secondarySourceTip: nullableUint32(row.secondarySourceTip, 'secondary source tip'),
            lastAgreedLedgerIndex: nullableUint32(
              row.lastAgreedLedgerIndex,
              'last agreed ledger index',
            ),
            lastAgreedLedgerHash: row.lastAgreedLedgerHash,
            errorCode: row.errorCode,
            writerPresent: row.writerPresent,
            leaseExpiresAt:
              row.leaseExpiresAt === null
                ? null
                : databaseDate(row.leaseExpiresAt, 'operational lease expiration time'),
            updatedAt: databaseDate(row.statusUpdatedAt, 'operational status update time'),
          },
    checkpoint:
      row.checkpointLedgerIndex === null ||
      row.checkpointLedgerHash === null ||
      row.checkpointCloseTime === null
        ? undefined
        : {
            ledgerIndex: uint32(row.checkpointLedgerIndex, 'checkpoint ledger index'),
            ledgerHash: row.checkpointLedgerHash,
            closeTime: uint32(row.checkpointCloseTime, 'checkpoint close time'),
            transactionRootPresent: row.checkpointTransactionRootPresent,
          },
    acceptedRegistrations: nonNegativeSafeInteger(
      row.acceptedRegistrations,
      'accepted registrations',
    ),
    rejectedRegistrations: nonNegativeSafeInteger(
      row.rejectedRegistrations,
      'rejected registrations',
    ),
    haltHistory: {
      total: haltCount,
      latest:
        row.latestHaltWriterEpoch === null ||
        row.latestHaltErrorCode === null ||
        row.latestHaltRecordedAt === null
          ? undefined
          : {
              writerEpoch: positiveSafeInteger(
                row.latestHaltWriterEpoch,
                'latest halt writer epoch',
              ),
              errorCode: row.latestHaltErrorCode,
              primarySourceTip: nullableUint32(
                row.latestHaltPrimarySourceTip,
                'latest halt primary source tip',
              ),
              secondarySourceTip: nullableUint32(
                row.latestHaltSecondarySourceTip,
                'latest halt secondary source tip',
              ),
              lastAgreedLedgerIndex: nullableUint32(
                row.latestHaltLastAgreedLedgerIndex,
                'latest halt agreed ledger index',
              ),
              recordedAt: databaseDate(row.latestHaltRecordedAt, 'latest halt time'),
            },
    },
  }
}

export class PostgresOperationalMetricsRepository implements OperationalMetricsRepository {
  constructor(private readonly db: XcsDatabase) {}

  getSnapshot() {
    return this.db.transaction(
      async (transaction) => {
        const [database] = await transaction.execute<DatabaseMetricsRow>(sql`
          SELECT
            CURRENT_TIMESTAMP AS "observedAt",
            (
              SELECT COUNT(*)::text
              FROM pg_stat_activity
              WHERE backend_type = 'client backend'
            ) AS "usedConnections",
            current_setting('max_connections') AS "maxConnections",
            pg_database_size(current_database())::text AS "sizeBytes"
        `)
        if (database === undefined) {
          throw new OperationalMetricsEvidenceError(
            'PostgreSQL returned incomplete operational database metrics',
          )
        }
        const observedAt = databaseDate(
          database.observedAt,
          'operational database observation time',
        )

        const rows = await transaction.execute<ProfileMetricsRow>(sql`
          SELECT
            network.profile_id AS "profileId",
            network.activation_ledger_index::text AS "activationLedgerIndex",
            status.state,
            status.primary_source_tip::text AS "primarySourceTip",
            status.secondary_source_tip::text AS "secondarySourceTip",
            status.last_agreed_ledger_index::text AS "lastAgreedLedgerIndex",
            status.last_agreed_ledger_hash AS "lastAgreedLedgerHash",
            status.error_code AS "errorCode",
            status.writer_id IS NOT NULL AS "writerPresent",
            status.lease_expires_at AS "leaseExpiresAt",
            status.updated_at AS "statusUpdatedAt",
            checkpoint.ledger_index::text AS "checkpointLedgerIndex",
            checkpoint.ledger_hash AS "checkpointLedgerHash",
            checkpoint.close_time::text AS "checkpointCloseTime",
            checkpoint.transaction_root IS NOT NULL AS "checkpointTransactionRootPresent",
            registrations.accepted::text AS "acceptedRegistrations",
            registrations.rejected::text AS "rejectedRegistrations",
            halt_count.total::text AS "haltCount",
            latest_halt.writer_epoch::text AS "latestHaltWriterEpoch",
            latest_halt.error_code AS "latestHaltErrorCode",
            latest_halt.primary_source_tip::text AS "latestHaltPrimarySourceTip",
            latest_halt.secondary_source_tip::text AS "latestHaltSecondarySourceTip",
            latest_halt.last_agreed_ledger_index::text AS "latestHaltLastAgreedLedgerIndex",
            latest_halt.last_agreed_ledger_hash IS NOT NULL AS "latestHaltLastAgreedLedgerHashPresent",
            latest_halt.recorded_at AS "latestHaltRecordedAt"
          FROM network_profiles AS network
          LEFT JOIN indexer_status AS status ON status.profile_id = network.profile_id
          LEFT JOIN LATERAL (
            SELECT ledger_index, ledger_hash, close_time, transaction_root
            FROM ledger_checkpoints
            WHERE profile_id = network.profile_id
            ORDER BY ledger_index DESC
            LIMIT 1
          ) AS checkpoint ON true
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
              COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
            FROM schema_events
            WHERE profile_id = network.profile_id
          ) AS registrations ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS total
            FROM indexer_incidents
            WHERE profile_id = network.profile_id
          ) AS halt_count ON true
          LEFT JOIN LATERAL (
            SELECT
              writer_epoch,
              error_code,
              primary_source_tip,
              secondary_source_tip,
              last_agreed_ledger_index,
              last_agreed_ledger_hash,
              recorded_at
            FROM indexer_incidents
            WHERE profile_id = network.profile_id
            ORDER BY writer_epoch DESC
            LIMIT 1
          ) AS latest_halt ON true
          WHERE network.enabled = true
          ORDER BY network.profile_id ASC
        `)

        return {
          observedAt,
          database: {
            usedConnections: nonNegativeSafeInteger(
              database.usedConnections,
              'used database connections',
            ),
            maxConnections: nonNegativeSafeInteger(
              database.maxConnections,
              'maximum database connections',
            ),
            sizeBytes: nonNegativeSafeInteger(database.sizeBytes, 'database size'),
          },
          profiles: rows.map(profileSnapshot),
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
}
