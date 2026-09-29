import { HASH_PATTERN, ADDRESS_PATTERN } from './common.js'
import { schemas } from './catalog.js'
import { networkProfiles } from './profiles.js'
import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
export const hostedPayloads = pgTable(
  'hosted_payloads',
  {
    locator: text('locator').primaryKey(),
    digestHex: text('digest_hex').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('hosted_payloads_locator', sql`${table.locator} ~ '^(?:[0-9a-f]{18}|[0-9a-f]{20})$'`),
    check('hosted_payloads_digest', sql`${table.digestHex} ~ ${HASH_PATTERN}`),
    check('hosted_payloads_size', sql`octet_length(${table.content}) BETWEEN 1 AND 65536`),
  ],
)
export const hostedPayloadPublications = pgTable(
  'hosted_payload_publications',
  {
    transactionHash: text('transaction_hash').primaryKey(),
    locator: text('locator')
      .notNull()
      .references(() => hostedPayloads.locator, { onDelete: 'restrict' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => networkProfiles.profileId, { onDelete: 'restrict' }),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    schemaUid: text('schema_uid').notNull(),
    requesterIpHash: text('requester_ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'hosted_payload_publications_schema_fk',
      columns: [table.profileId, table.schemaUid],
      foreignColumns: [schemas.profileId, schemas.schemaUid],
    }).onDelete('restrict'),
    index('hosted_payload_publications_wallet_quota_idx').on(table.issuer, table.createdAt),
    index('hosted_payload_publications_ip_quota_idx').on(table.requesterIpHash, table.createdAt),
    index('hosted_payload_publications_locator_idx').on(table.locator),
    check('hosted_payload_publications_tx_hash', sql`${table.transactionHash} ~ ${HASH_PATTERN}`),
    check('hosted_payload_publications_issuer', sql`${table.issuer} ~ ${ADDRESS_PATTERN}`),
    check('hosted_payload_publications_subject', sql`${table.subject} ~ ${ADDRESS_PATTERN}`),
    check('hosted_payload_publications_schema', sql`${table.schemaUid} ~ ${HASH_PATTERN}`),
    check('hosted_payload_publications_ip_hash', sql`${table.requesterIpHash} ~ ${HASH_PATTERN}`),
  ],
)
