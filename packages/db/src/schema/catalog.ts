import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { HASH_PATTERN } from './common.js'
import { networkProfiles } from './profiles.js'

export const schemaEvents = pgTable(
  'schema_events',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    transactionHash: text('transaction_hash').notNull(),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    ledgerHash: text('ledger_hash').notNull(),
    transactionIndex: integer('transaction_index').notNull(),
    publisher: text('publisher').notNull(),
    status: text('status').notNull(),
    reasonCode: text('reason_code'),
    schemaUid: text('schema_uid'),
    memoJson: jsonb('memo_json').$type<unknown>(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'schema_events_pk',
      columns: [table.profileId, table.transactionHash],
    }),
    index('schema_events_ledger_idx').on(
      table.profileId,
      table.ledgerIndex,
      table.transactionIndex,
    ),
    index('schema_events_activity_idx').on(
      table.profileId,
      table.ledgerIndex,
      table.transactionIndex,
      table.transactionHash,
    ),
    index('schema_events_publisher_idx').on(table.profileId, table.publisher),
    check('schema_events_tx_hash', sql`${table.transactionHash} ~ ${HASH_PATTERN}`),
    check('schema_events_ledger_hash', sql`${table.ledgerHash} ~ ${HASH_PATTERN}`),
    check('schema_events_ledger_index_uint32', sql`${table.ledgerIndex} BETWEEN 0 AND 4294967295`),
    check('schema_events_tx_index', sql`${table.transactionIndex} >= 0`),
    check('schema_events_status', sql`${table.status} IN ('accepted', 'rejected')`),
    check(
      'schema_events_result_shape',
      sql`(${table.status} = 'accepted' AND ${table.schemaUid} IS NOT NULL AND ${table.reasonCode} IS NULL AND ${table.memoJson} IS NOT NULL)
          OR (${table.status} = 'rejected' AND ${table.schemaUid} IS NULL AND ${table.reasonCode} IS NOT NULL)`,
    ),
    check(
      'schema_events_schema_uid',
      sql`${table.schemaUid} IS NULL OR ${table.schemaUid} ~ ${HASH_PATTERN}`,
    ),
  ],
)

export const schemas = pgTable(
  'schemas',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    schemaUid: text('schema_uid').notNull(),
    publisher: text('publisher').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    parentUid: text('parent_uid'),
    supersedesUid: text('supersedes_uid'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    resolvedDefinition: jsonb('resolved_definition').$type<Record<string, unknown>>().notNull(),
    registrationTransactionHash: text('registration_transaction_hash').notNull(),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    transactionIndex: integer('transaction_index').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'schemas_pk',
      columns: [table.profileId, table.schemaUid],
    }),
    uniqueIndex('schemas_registration_tx_uq').on(
      table.profileId,
      table.registrationTransactionHash,
    ),
    foreignKey({
      name: 'schemas_registration_event_fk',
      columns: [table.profileId, table.registrationTransactionHash],
      foreignColumns: [schemaEvents.profileId, schemaEvents.transactionHash],
    }).onDelete('restrict'),
    index('schemas_publisher_order_idx').on(
      table.profileId,
      table.publisher,
      table.ledgerIndex,
      table.transactionIndex,
    ),
    index('schemas_order_idx').on(
      table.profileId,
      table.ledgerIndex,
      table.transactionIndex,
      table.schemaUid,
    ),
    index('schemas_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${table.name} || ' ' || ${table.description})`,
    ),
    check('schemas_uid', sql`${table.schemaUid} ~ ${HASH_PATTERN}`),
    check(
      'schemas_parent_uid',
      sql`${table.parentUid} IS NULL OR ${table.parentUid} ~ ${HASH_PATTERN}`,
    ),
    check(
      'schemas_supersedes_uid',
      sql`${table.supersedesUid} IS NULL OR ${table.supersedesUid} ~ ${HASH_PATTERN}`,
    ),
    check(
      'schemas_registration_tx_hash',
      sql`${table.registrationTransactionHash} ~ ${HASH_PATTERN}`,
    ),
    check('schemas_ledger_index_uint32', sql`${table.ledgerIndex} BETWEEN 0 AND 4294967295`),
    check('schemas_transaction_index', sql`${table.transactionIndex} >= 0`),
  ],
)

export type SchemaEventRow = typeof schemaEvents.$inferSelect
export type SchemaRow = typeof schemas.$inferSelect
