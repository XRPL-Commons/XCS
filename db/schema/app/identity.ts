import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { ADDRESS_PATTERN } from '../common.js'

export const appUsers = pgTable(
  'app_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identityIssuer: text('identity_issuer'),
    identitySubject: text('identity_subject'),
    email: text('email'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    displayName: text('display_name'),
    status: text('status', { enum: ['active', 'suspended', 'deleted'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('app_users_identity_uq').on(t.identityIssuer, t.identitySubject),
    check('app_users_status', sql`${t.status} IN ('active', 'suspended', 'deleted')`),
    check(
      'app_users_identity',
      sql`(${t.status} <> 'deleted' AND length(${t.identityIssuer}) > 0 AND ${t.identityIssuer} IS NOT NULL AND length(${t.identitySubject}) > 0 AND ${t.identitySubject} IS NOT NULL AND ${t.deletedAt} IS NULL) OR (${t.status} = 'deleted' AND ${t.identityIssuer} IS NULL AND ${t.identitySubject} IS NULL AND ${t.email} IS NULL AND ${t.emailVerifiedAt} IS NULL AND ${t.displayName} IS NULL AND ${t.deletedAt} IS NOT NULL)`,
    ),
    check('app_users_verified_email', sql`${t.emailVerifiedAt} IS NULL OR ${t.email} IS NOT NULL`),
  ],
)

// Issuer/verifier approval belongs to an organization; these are personal roles only.
export const appUserRoles = pgTable(
  'app_user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['admin', 'recipient'] })
      .notNull()
      .default('recipient'),
    grantedBy: uuid('granted_by').references(() => appUsers.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check('app_user_roles_role', sql`${t.role} IN ('admin', 'recipient')`),
  ],
)

export const appWallets = pgTable(
  'app_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    networkId: bigint('network_id', { mode: 'number' }).notNull(),
    address: text('address').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('app_wallets_network_address_uq').on(t.networkId, t.address),
    index('app_wallets_user_idx').on(t.userId),
    check('app_wallets_network', sql`${t.networkId} BETWEEN 0 AND 4294967295`),
    check('app_wallets_address', sql`${t.address} ~ ${ADDRESS_PATTERN}`),
    check(
      'app_wallets_revocation',
      sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.verifiedAt}`,
    ),
  ],
)
