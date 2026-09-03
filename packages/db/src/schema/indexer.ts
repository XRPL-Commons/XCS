import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

import { ERROR_CODE_PATTERN, HASH_PATTERN, WRITER_ID_PATTERN } from './common.js'
import { networkProfiles } from './profiles.js'

export const INDEXER_STATUS_STATES = ['starting', 'catching_up', 'ready', 'halted'] as const
export type IndexerStatusState = (typeof INDEXER_STATUS_STATES)[number]

export const indexerStatuses = pgTable(
  'indexer_status',
  {
    profileId: text('profile_id')
      .primaryKey()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    state: text('state').$type<IndexerStatusState>().notNull(),
    primarySourceTip: bigint('primary_source_tip', { mode: 'number' }),
    secondarySourceTip: bigint('secondary_source_tip', { mode: 'number' }),
    lastAgreedLedgerIndex: bigint('last_agreed_ledger_index', { mode: 'number' }),
    lastAgreedLedgerHash: text('last_agreed_ledger_hash'),
    errorCode: text('error_code'),
    writerId: text('writer_id'),
    writerEpoch: bigint('writer_epoch', { mode: 'number' }).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'indexer_status_state',
      sql`${table.state} IN ('starting', 'catching_up', 'ready', 'halted')`,
    ),
    check(
      'indexer_status_primary_tip',
      sql`${table.primarySourceTip} IS NULL OR ${table.primarySourceTip} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'indexer_status_secondary_tip',
      sql`${table.secondarySourceTip} IS NULL OR ${table.secondarySourceTip} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'indexer_status_agreed_ledger',
      sql`(${table.lastAgreedLedgerIndex} IS NULL AND ${table.lastAgreedLedgerHash} IS NULL)
          OR (${table.lastAgreedLedgerIndex} IS NOT NULL
          AND ${table.lastAgreedLedgerHash} IS NOT NULL
          AND ${table.lastAgreedLedgerIndex} BETWEEN 0 AND 4294967295
          AND ${table.lastAgreedLedgerHash} ~ ${HASH_PATTERN})`,
    ),
    check(
      'indexer_status_agreed_not_ahead',
      sql`${table.state} = 'halted'
          OR ${table.lastAgreedLedgerIndex} IS NULL
          OR ((${table.primarySourceTip} IS NULL OR ${table.lastAgreedLedgerIndex} <= ${table.primarySourceTip})
          AND (${table.secondarySourceTip} IS NULL OR ${table.lastAgreedLedgerIndex} <= ${table.secondarySourceTip}))`,
    ),
    check(
      'indexer_status_ready_shape',
      sql`${table.state} <> 'ready'
          OR (${table.primarySourceTip} IS NOT NULL
          AND ${table.secondarySourceTip} IS NOT NULL
          AND ${table.lastAgreedLedgerIndex} IS NOT NULL
          AND ${table.lastAgreedLedgerHash} IS NOT NULL
          AND ${table.writerId} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
          AND ${table.lastAgreedLedgerIndex} = LEAST(${table.primarySourceTip}, ${table.secondarySourceTip}))`,
    ),
    check(
      'indexer_status_error_code',
      sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ ${ERROR_CODE_PATTERN}`,
    ),
    check(
      'indexer_status_error_shape',
      sql`(${table.state} = 'halted' AND ${table.errorCode} IS NOT NULL)
          OR (${table.state} <> 'halted' AND ${table.errorCode} IS NULL)`,
    ),
    check(
      'indexer_status_writer_id',
      sql`${table.writerId} IS NULL OR ${table.writerId} ~ ${WRITER_ID_PATTERN}`,
    ),
    check('indexer_status_writer_epoch', sql`${table.writerEpoch} BETWEEN 1 AND 9007199254740991`),
    check(
      'indexer_status_lease_window',
      sql`(${table.writerId} IS NULL AND ${table.leaseExpiresAt} IS NULL)
          OR (${table.writerId} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
          AND ${table.leaseExpiresAt} >= ${table.updatedAt}
          AND ${table.leaseExpiresAt} <= ${table.updatedAt} + interval '5 minutes')`,
    ),
  ],
)

export const indexerIncidents = pgTable(
  'indexer_incidents',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    writerEpoch: bigint('writer_epoch', { mode: 'number' }).notNull(),
    errorCode: text('error_code').notNull(),
    primarySourceTip: bigint('primary_source_tip', { mode: 'number' }),
    secondarySourceTip: bigint('secondary_source_tip', { mode: 'number' }),
    lastAgreedLedgerIndex: bigint('last_agreed_ledger_index', { mode: 'number' }),
    lastAgreedLedgerHash: text('last_agreed_ledger_hash'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'indexer_incidents_pk',
      columns: [table.profileId, table.writerEpoch],
    }),
    check(
      'indexer_incidents_writer_epoch',
      sql`${table.writerEpoch} BETWEEN 1 AND 9007199254740991`,
    ),
    check('indexer_incidents_error_code', sql`${table.errorCode} ~ ${ERROR_CODE_PATTERN}`),
    check(
      'indexer_incidents_primary_tip',
      sql`${table.primarySourceTip} IS NULL OR ${table.primarySourceTip} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'indexer_incidents_secondary_tip',
      sql`${table.secondarySourceTip} IS NULL OR ${table.secondarySourceTip} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'indexer_incidents_agreed_ledger',
      sql`(${table.lastAgreedLedgerIndex} IS NULL AND ${table.lastAgreedLedgerHash} IS NULL)
          OR (${table.lastAgreedLedgerIndex} IS NOT NULL
          AND ${table.lastAgreedLedgerHash} IS NOT NULL
          AND ${table.lastAgreedLedgerIndex} BETWEEN 0 AND 4294967295
          AND ${table.lastAgreedLedgerHash} ~ ${HASH_PATTERN})`,
    ),
  ],
)

export type IndexerStatusRow = typeof indexerStatuses.$inferSelect
export type NewIndexerStatusRow = typeof indexerStatuses.$inferInsert
export type IndexerIncidentRow = typeof indexerIncidents.$inferSelect
export type NewIndexerIncidentRow = typeof indexerIncidents.$inferInsert
