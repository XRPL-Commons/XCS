import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { ADDRESS_PATTERN, HASH_PATTERN } from '../common.js'
import { appUsers } from './identity.js'

const TOKEN_PATTERN = sql.raw("'^[A-Za-z0-9_-]{43}$'")

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('app_sessions_user_idx').on(t.userId),
    index('app_sessions_expiry_idx').on(t.expiresAt),
    check('app_sessions_token', sql`${t.tokenHash} ~ ${HASH_PATTERN}`),
    check('app_sessions_csrf', sql`${t.csrfToken} ~ ${TOKEN_PATTERN}`),
    check(
      'app_sessions_dates',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.absoluteExpiresAt} >= ${t.expiresAt} AND isfinite(${t.absoluteExpiresAt})`,
    ),
  ],
)

export const appAuthTransactions = pgTable(
  'app_auth_transactions',
  {
    stateHash: text('state_hash').primaryKey(),
    browserHash: text('browser_hash').notNull(),
    nonce: text('nonce').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('app_auth_transactions_expiry_idx').on(t.expiresAt),
    check(
      'app_auth_transactions_hashes',
      sql`${t.stateHash} ~ ${HASH_PATTERN} AND ${t.browserHash} ~ ${HASH_PATTERN}`,
    ),
    check(
      'app_auth_transactions_tokens',
      sql`${t.nonce} ~ ${TOKEN_PATTERN} AND ${t.codeVerifier} ~ ${TOKEN_PATTERN}`,
    ),
    check(
      'app_auth_transactions_return_to',
      sql`length(${t.returnTo}) BETWEEN 1 AND 2048 AND left(${t.returnTo}, 1) = '/' AND left(${t.returnTo}, 2) <> '//' AND position(chr(92) in ${t.returnTo}) = 0 AND ${t.returnTo} !~ '[[:cntrl:]]'`,
    ),
    check(
      'app_auth_transactions_dates',
      sql`${t.expiresAt} > ${t.createdAt} AND isfinite(${t.expiresAt})`,
    ),
  ],
)

export const appWalletChallenges = pgTable(
  'app_wallet_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => appSessions.id, { onDelete: 'cascade' }),
    networkId: bigint('network_id', { mode: 'number' }).notNull(),
    address: text('address').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('app_wallet_challenges_session_idx').on(t.sessionId),
    index('app_wallet_challenges_expiry_idx').on(t.expiresAt),
    check('app_wallet_challenges_network', sql`${t.networkId} BETWEEN 0 AND 4294967295`),
    check('app_wallet_challenges_address', sql`${t.address} ~ ${ADDRESS_PATTERN}`),
    check('app_wallet_challenges_message', sql`length(${t.message}) BETWEEN 1 AND 8192`),
    check(
      'app_wallet_challenges_dates',
      sql`${t.expiresAt} > ${t.createdAt} AND isfinite(${t.expiresAt})`,
    ),
  ],
)
