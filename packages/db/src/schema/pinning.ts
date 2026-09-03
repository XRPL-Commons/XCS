import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { ADDRESS_PATTERN, HASH_PATTERN } from './common.js'
import { networkProfiles } from './profiles.js'

export const pinChallenges = pgTable(
  'pin_challenges',
  {
    challengeId: text('challenge_id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    wallet: text('wallet').notNull(),
    requesterIpHash: text('requester_ip_hash').notNull(),
    message: text('message').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pin_challenges_wallet_created_idx').on(table.profileId, table.wallet, table.createdAt),
    index('pin_challenges_ip_created_idx').on(table.requesterIpHash, table.createdAt),
    index('pin_challenges_expiry_idx').on(table.expiresAt),
    check('pin_challenges_id', sql`${table.challengeId} ~ ${HASH_PATTERN}`),
    check('pin_challenges_ip_hash', sql`${table.requesterIpHash} ~ ${HASH_PATTERN}`),
    check('pin_challenges_wallet', sql`${table.wallet} ~ ${ADDRESS_PATTERN}`),
    check('pin_challenges_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
)

export const demoPins = pgTable(
  'demo_pins',
  {
    pinId: text('pin_id').primaryKey(),
    challengeId: text('challenge_id')
      .notNull()
      .unique()
      .references(() => pinChallenges.challengeId, { onDelete: 'restrict' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    wallet: text('wallet').notNull(),
    requesterIpHash: text('requester_ip_hash').notNull(),
    cid: text('cid').notNull(),
    byteLength: integer('byte_length').notNull(),
    status: text('status').notNull(),
    failureCode: text('failure_code'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    unpinnedAt: timestamp('unpinned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('demo_pins_wallet_quota_idx').on(table.wallet, table.createdAt),
    index('demo_pins_ip_quota_idx').on(table.requesterIpHash, table.createdAt),
    index('demo_pins_expiry_idx').on(table.status, table.expiresAt),
    index('demo_pins_cid_active_idx').on(table.cid, table.status, table.expiresAt),
    check('demo_pins_id', sql`${table.pinId} ~ ${HASH_PATTERN}`),
    check('demo_pins_ip_hash', sql`${table.requesterIpHash} ~ ${HASH_PATTERN}`),
    check('demo_pins_wallet', sql`${table.wallet} ~ ${ADDRESS_PATTERN}`),
    check('demo_pins_cid', sql`${table.cid} ~ '^b[a-z2-7]+$'`),
    check('demo_pins_byte_length', sql`${table.byteLength} BETWEEN 1 AND 65536`),
    check('demo_pins_status', sql`${table.status} IN ('pending', 'pinned', 'failed', 'unpinned')`),
    check(
      'demo_pins_failure_shape',
      sql`(${table.status} = 'failed' AND ${table.failureCode} IS NOT NULL)
          OR (${table.status} <> 'failed' AND ${table.failureCode} IS NULL)`,
    ),
    check(
      'demo_pins_unpinned_shape',
      sql`(${table.status} = 'unpinned' AND ${table.unpinnedAt} IS NOT NULL)
          OR (${table.status} <> 'unpinned' AND ${table.unpinnedAt} IS NULL)`,
    ),
  ],
)

export type PinChallengeRow = typeof pinChallenges.$inferSelect
export type DemoPinRow = typeof demoPins.$inferSelect
