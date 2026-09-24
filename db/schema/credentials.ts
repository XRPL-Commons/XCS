import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
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
import { schemas } from './catalog.js'

export const credentialGenerations = pgTable(
  'credential_generations',
  {
    profileId: text('profile_id').notNull(),
    generationId: text('generation_id').notNull(),
    ledgerObjectId: text('ledger_object_id').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    schemaUid: text('schema_uid').notNull(),
    uriHex: text('uri_hex'),
    expiration: bigint('expiration', { mode: 'number' }),
    accepted: boolean('accepted').notNull().default(false),
    createdLedgerIndex: bigint('created_ledger_index', { mode: 'number' }).notNull(),
    createdTransactionIndex: integer('created_transaction_index').notNull(),
    lastLedgerIndex: bigint('last_ledger_index', { mode: 'number' }).notNull(),
    deletedLedgerIndex: bigint('deleted_ledger_index', { mode: 'number' }),
    deletionCause: text('deletion_cause'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'credential_generations_pk',
      columns: [table.profileId, table.generationId],
    }),
    foreignKey({
      name: 'credential_generations_profile_fk',
      columns: [table.profileId],
      foreignColumns: [networkProfiles.profileId],
    }).onDelete('restrict'),
    uniqueIndex('credential_generations_live_uq')
      .on(table.profileId, table.issuer, table.subject, table.schemaUid)
      .where(sql`${table.deletedLedgerIndex} IS NULL`),
    foreignKey({
      name: 'credential_generations_schema_fk',
      columns: [table.profileId, table.schemaUid],
      foreignColumns: [schemas.profileId, schemas.schemaUid],
    }).onDelete('restrict'),
    index('credential_generations_exact_idx').on(
      table.profileId,
      table.issuer,
      table.subject,
      table.schemaUid,
      table.createdLedgerIndex,
    ),
    index('credential_generations_stats_idx').on(
      table.profileId,
      table.deletedLedgerIndex,
      table.accepted,
      table.expiration,
    ),
    check('credential_generations_id', sql`${table.generationId} ~ ${HASH_PATTERN}`),
    check('credential_generations_object', sql`${table.ledgerObjectId} ~ ${HASH_PATTERN}`),
    check('credential_generations_schema', sql`${table.schemaUid} ~ ${HASH_PATTERN}`),
    check(
      'credential_generations_expiration_uint32',
      sql`${table.expiration} IS NULL OR ${table.expiration} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'credential_generations_created_ledger_uint32',
      sql`${table.createdLedgerIndex} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'credential_generations_created_transaction_index',
      sql`${table.createdTransactionIndex} >= 0`,
    ),
    check(
      'credential_generations_last_ledger_uint32',
      sql`${table.lastLedgerIndex} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'credential_generations_deleted_ledger_uint32',
      sql`${table.deletedLedgerIndex} IS NULL OR ${table.deletedLedgerIndex} BETWEEN 0 AND 4294967295`,
    ),
    check(
      'credential_generations_ledger_order',
      sql`${table.lastLedgerIndex} >= ${table.createdLedgerIndex}
          AND (${table.deletedLedgerIndex} IS NULL OR ${table.deletedLedgerIndex} = ${table.lastLedgerIndex})`,
    ),
    check(
      'credential_generations_deletion',
      sql`(${table.deletedLedgerIndex} IS NULL AND ${table.deletionCause} IS NULL)
          OR (${table.deletedLedgerIndex} IS NOT NULL AND ${table.deletionCause} IS NOT NULL)`,
    ),
    check(
      'credential_generations_deletion_cause',
      sql`${table.deletionCause} IS NULL OR ${table.deletionCause} IN ('issuer_revoked', 'subject_rejected', 'subject_removed', 'expired_cleanup', 'account_deleted', 'self_deleted')`,
    ),
  ],
)

export const credentialEvents = pgTable(
  'credential_events',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    transactionHash: text('transaction_hash').notNull(),
    nodeIndex: integer('node_index').notNull(),
    generationId: text('generation_id').notNull(),
    ledgerObjectId: text('ledger_object_id').notNull(),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    ledgerHash: text('ledger_hash').notNull(),
    transactionIndex: integer('transaction_index').notNull(),
    eventType: text('event_type').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    schemaUid: text('schema_uid').notNull(),
    uriHex: text('uri_hex'),
    expiration: bigint('expiration', { mode: 'number' }),
    accepted: boolean('accepted').notNull(),
    deletionCause: text('deletion_cause'),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'credential_events_pk',
      columns: [table.profileId, table.transactionHash, table.nodeIndex],
    }),
    index('credential_events_generation_idx').on(
      table.profileId,
      table.generationId,
      table.ledgerIndex,
      table.transactionIndex,
      table.nodeIndex,
    ),
    foreignKey({
      name: 'credential_events_schema_fk',
      columns: [table.profileId, table.schemaUid],
      foreignColumns: [schemas.profileId, schemas.schemaUid],
    }).onDelete('restrict'),
    foreignKey({
      name: 'credential_events_generation_fk',
      columns: [table.profileId, table.generationId],
      foreignColumns: [credentialGenerations.profileId, credentialGenerations.generationId],
    }).onDelete('restrict'),
    index('credential_events_exact_idx').on(
      table.profileId,
      table.issuer,
      table.subject,
      table.schemaUid,
      table.ledgerIndex,
    ),
    check('credential_events_tx_hash', sql`${table.transactionHash} ~ ${HASH_PATTERN}`),
    check('credential_events_object', sql`${table.ledgerObjectId} ~ ${HASH_PATTERN}`),
    check('credential_events_ledger_hash', sql`${table.ledgerHash} ~ ${HASH_PATTERN}`),
    check('credential_events_schema', sql`${table.schemaUid} ~ ${HASH_PATTERN}`),
    check('credential_events_node_index', sql`${table.nodeIndex} >= 0`),
    check(
      'credential_events_ledger_index_uint32',
      sql`${table.ledgerIndex} BETWEEN 0 AND 4294967295`,
    ),
    check('credential_events_transaction_index', sql`${table.transactionIndex} >= 0`),
    check(
      'credential_events_expiration_uint32',
      sql`${table.expiration} IS NULL OR ${table.expiration} BETWEEN 0 AND 4294967295`,
    ),
    check('credential_events_type', sql`${table.eventType} IN ('created', 'accepted', 'deleted')`),
    check(
      'credential_events_delete_shape',
      sql`(${table.eventType} = 'deleted' AND ${table.deletionCause} IS NOT NULL)
          OR (${table.eventType} <> 'deleted' AND ${table.deletionCause} IS NULL)`,
    ),
  ],
)

export type CredentialGenerationRow = typeof credentialGenerations.$inferSelect
export type CredentialEventRow = typeof credentialEvents.$inferSelect
