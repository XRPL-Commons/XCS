import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { ADDRESS_PATTERN, HASH_PATTERN } from '../common.js'
import { appUsers } from './identity.js'
import { appOrganizations } from './organizations.js'

// Stable ledger references, deliberately not FKs into the rebuildable projection.
export const appSchemaMetadata = pgTable(
  'app_schema_metadata',
  {
    profileId: text('profile_id').notNull(),
    schemaUid: text('schema_uid').notNull(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => appOrganizations.id, { onDelete: 'restrict' }),
    displayName: text('display_name'),
    category: text('category'),
    registrationTransactionHash: text('registration_transaction_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.schemaUid] }),
    unique('app_schema_metadata_owner_uq').on(t.profileId, t.schemaUid, t.organizationId),
    index('app_schema_metadata_organization_idx').on(t.organizationId),
    check('app_schema_metadata_profile', sql`length(${t.profileId}) > 0`),
    check('app_schema_metadata_uid', sql`${t.schemaUid} ~ ${HASH_PATTERN}`),
    check(
      'app_schema_metadata_transaction',
      sql`${t.registrationTransactionHash} ~ ${HASH_PATTERN}`,
    ),
  ],
)

export const appInvites = pgTable(
  'app_invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    profileId: text('profile_id').notNull(),
    schemaUid: text('schema_uid').notNull(),
    deliveryEmail: text('delivery_email'),
    tokenHash: text('token_hash').unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedBy: uuid('claimed_by').references(() => appUsers.id, { onDelete: 'restrict' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.profileId, t.schemaUid, t.organizationId],
      foreignColumns: [
        appSchemaMetadata.profileId,
        appSchemaMetadata.schemaUid,
        appSchemaMetadata.organizationId,
      ],
      name: 'app_invites_schema_owner_fk',
    }).onDelete('restrict'),
    unique('app_invites_claim_identity_uq').on(
      t.id,
      t.organizationId,
      t.profileId,
      t.schemaUid,
      t.claimedBy,
    ),
    index('app_invites_organization_idx').on(t.organizationId, t.createdAt),
    index('app_invites_claimant_idx').on(t.claimedBy),
    check('app_invites_token', sql`${t.tokenHash} IS NULL OR ${t.tokenHash} ~ ${HASH_PATTERN}`),
    check(
      'app_invites_unclaimed_token',
      sql`${t.claimedAt} IS NOT NULL OR ${t.revokedAt} IS NOT NULL OR ${t.tokenHash} IS NOT NULL`,
    ),
    check('app_invites_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'app_invites_claim',
      sql`(${t.claimedBy} IS NULL AND ${t.claimedAt} IS NULL) OR (${t.claimedBy} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.claimedAt} >= ${t.createdAt} AND ${t.claimedAt} < ${t.expiresAt})`,
    ),
  ],
)

export const appCredentialMetadata = pgTable(
  'app_credential_metadata',
  {
    profileId: text('profile_id').notNull(),
    generationId: text('generation_id').notNull(),
    schemaUid: text('schema_uid').notNull(),
    issuerOrganizationId: uuid('issuer_organization_id').notNull(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    inviteId: uuid('invite_id').unique(),
    issuerAddress: text('issuer_address').notNull(),
    subjectAddress: text('subject_address').notNull(),
    visibility: text('visibility', { enum: ['public', 'private'] }).notNull(),
    publicFields: jsonb('public_fields').$type<string[]>().notNull().default([]),
    payloadStorageKey: text('payload_storage_key'),
    payloadDigest: text('payload_digest').notNull(),
    creationTransactionHash: text('creation_transaction_hash').notNull(),
    creationLedgerIndex: bigint('creation_ledger_index', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.generationId] }),
    unique('app_credential_metadata_recipient_uq').on(
      t.profileId,
      t.generationId,
      t.recipientUserId,
    ),
    foreignKey({
      columns: [t.profileId, t.schemaUid, t.issuerOrganizationId],
      foreignColumns: [
        appSchemaMetadata.profileId,
        appSchemaMetadata.schemaUid,
        appSchemaMetadata.organizationId,
      ],
      name: 'app_credential_metadata_schema_owner_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.inviteId, t.issuerOrganizationId, t.profileId, t.schemaUid, t.recipientUserId],
      foreignColumns: [
        appInvites.id,
        appInvites.organizationId,
        appInvites.profileId,
        appInvites.schemaUid,
        appInvites.claimedBy,
      ],
      name: 'app_credential_metadata_invite_claim_fk',
    }).onDelete('restrict'),
    index('app_credential_metadata_recipient_idx').on(t.recipientUserId, t.createdAt),
    index('app_credential_metadata_issuer_idx').on(t.issuerOrganizationId, t.createdAt),
    check('app_credential_metadata_generation', sql`${t.generationId} ~ ${HASH_PATTERN}`),
    check(
      'app_credential_metadata_addresses',
      sql`${t.issuerAddress} ~ ${ADDRESS_PATTERN} AND ${t.subjectAddress} ~ ${ADDRESS_PATTERN}`,
    ),
    check('app_credential_metadata_visibility', sql`${t.visibility} IN ('public', 'private')`),
    check(
      'app_credential_metadata_fields',
      sql`jsonb_typeof(${t.publicFields}) = 'array' AND NOT jsonb_path_exists(${t.publicFields}, '$[*] ? (@.type() != "string")')`,
    ),
    check('app_credential_metadata_digest', sql`${t.payloadDigest} ~ ${HASH_PATTERN}`),
    check(
      'app_credential_metadata_transaction',
      sql`${t.creationTransactionHash} ~ ${HASH_PATTERN}`,
    ),
    check('app_credential_metadata_ledger', sql`${t.creationLedgerIndex} BETWEEN 1 AND 4294967295`),
    check(
      'app_credential_metadata_storage',
      sql`${t.payloadStorageKey} IS NULL OR length(btrim(${t.payloadStorageKey})) > 0`,
    ),
  ],
)
