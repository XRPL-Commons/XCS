import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { appInvites } from './issuance.js'
import { appUsers } from './identity.js'

// Application-private drafts never enter the public hosted-payload store or indexer.
export const appIssuerPayloads = pgTable(
  'app_issuer_payloads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    locator: text('locator').notNull().unique(),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => appInvites.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    subjectAddress: text('subject_address').notNull(),
    canonicalPayload: text('canonical_payload').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    credentialUri: text('credential_uri').notNull(),
    visibility: text('visibility', { enum: ['public', 'private'] }).notNull(),
    publicFields: jsonb('public_fields').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_issuer_payloads_invite_idx').on(t.inviteId),
    check('app_issuer_payloads_locator', sql`${t.locator} ~ '^[0-9a-f]{18}$'`),
    check('app_issuer_payloads_digest', sql`${t.payloadDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'app_issuer_payloads_size',
      sql`octet_length(${t.canonicalPayload}) BETWEEN 1 AND 1048576`,
    ),
    check('app_issuer_payloads_visibility', sql`${t.visibility} IN ('public', 'private')`),
    check(
      'app_issuer_payloads_fields',
      sql`jsonb_typeof(${t.publicFields}) = 'array' AND NOT jsonb_path_exists(${t.publicFields}, '$[*] ? (@.type() != "string")')`,
    ),
  ],
)

// Bearer invitation tokens exist only in memory during the single delivery attempt.
export const appInviteDeliveries = pgTable(
  'app_invite_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => appInvites.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['invitation', 'issued', 'revoked'] }).notNull(),
    recipientEmail: text('recipient_email').notNull(),
    status: text('status', {
      enum: ['sending', 'sent', 'failed', 'uncertain', 'cancelled'],
    }).notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_invite_deliveries_invite_idx').on(t.inviteId, t.createdAt),
    uniqueIndex('app_invite_deliveries_event_uq')
      .on(t.inviteId, t.kind)
      .where(sql`${t.kind} <> 'invitation'`),
    check(
      'app_invite_deliveries_status',
      sql`${t.status} IN ('sending', 'sent', 'failed', 'uncertain', 'cancelled')`,
    ),
    check('app_invite_deliveries_kind', sql`${t.kind} IN ('invitation', 'issued', 'revoked')`),
  ],
)
