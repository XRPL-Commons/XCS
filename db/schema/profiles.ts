import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

import { ADDRESS_PATTERN, HASH_PATTERN } from './common.js'

export const networkProfiles = pgTable(
  'network_profiles',
  {
    profileId: text('profile_id').primaryKey(),
    xcsVersion: text('xcs_version').notNull(),
    networkId: bigint('network_id', { mode: 'number' }).notNull(),
    requiredAmendment: text('required_amendment').notNull(),
    registryAddress: text('registry_address').notNull(),
    registrationAmountDrops: bigint('registration_amount_drops', {
      mode: 'number',
    }).notNull(),
    activationLedgerIndex: bigint('activation_ledger_index', {
      mode: 'number',
    }).notNull(),
    activationLedgerHash: text('activation_ledger_hash').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('network_profiles_xcs_version', sql`${table.xcsVersion} = '0.1'`),
    check('network_profiles_network_id', sql`${table.networkId} BETWEEN 0 AND 4294967295`),
    check('network_profiles_registration_amount', sql`${table.registrationAmountDrops} = 1`),
    check(
      'network_profiles_activation_index',
      sql`${table.activationLedgerIndex} BETWEEN 1 AND 4294967295`,
    ),
    check('network_profiles_activation_hash', sql`${table.activationLedgerHash} ~ ${HASH_PATTERN}`),
    check('network_profiles_registry_address', sql`${table.registryAddress} ~ ${ADDRESS_PATTERN}`),
  ],
)

export const ledgerCheckpoints = pgTable(
  'ledger_checkpoints',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    ledgerHash: text('ledger_hash').notNull(),
    parentHash: text('parent_hash').notNull(),
    closeTime: bigint('close_time', { mode: 'number' }).notNull(),
    transactionCount: integer('transaction_count').notNull(),
    transactionRoot: text('transaction_root').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'ledger_checkpoints_pk',
      columns: [table.profileId, table.ledgerIndex],
    }),
    uniqueIndex('ledger_checkpoints_profile_hash_uq').on(table.profileId, table.ledgerHash),
    check('ledger_checkpoints_index_uint32', sql`${table.ledgerIndex} BETWEEN 0 AND 4294967295`),
    check('ledger_checkpoints_hash', sql`${table.ledgerHash} ~ ${HASH_PATTERN}`),
    check('ledger_checkpoints_parent', sql`${table.parentHash} ~ ${HASH_PATTERN}`),
    check('ledger_checkpoints_close_time_uint32', sql`${table.closeTime} BETWEEN 0 AND 4294967295`),
    check('ledger_checkpoints_tx_count', sql`${table.transactionCount} >= 0`),
    check('ledger_checkpoints_transaction_root', sql`${table.transactionRoot} ~ ${HASH_PATTERN}`),
  ],
)

export type NetworkProfileRow = typeof networkProfiles.$inferSelect
export type NewNetworkProfileRow = typeof networkProfiles.$inferInsert
export type LedgerCheckpointRow = typeof ledgerCheckpoints.$inferSelect
