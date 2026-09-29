import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { HASH_PATTERN } from '../common.js'
import { appCredentialMetadata } from './issuance.js'
import { appOrganizations } from './organizations.js'
import { appUsers } from './identity.js'
import { appSessions } from './auth.js'

export const appPresentations = pgTable(
  'app_presentations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    profileId: text('profile_id').notNull(),
    generationId: text('generation_id').notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    verifierOrganizationId: uuid('verifier_organization_id').references(() => appOrganizations.id, {
      onDelete: 'restrict',
    }),
    scope: text('scope', { enum: ['public', 'full'] }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.profileId, t.generationId, t.recipientUserId],
      foreignColumns: [
        appCredentialMetadata.profileId,
        appCredentialMetadata.generationId,
        appCredentialMetadata.recipientUserId,
      ],
      name: 'app_presentations_recipient_fk',
    }).onDelete('restrict'),
    index('app_presentations_recipient_idx').on(t.recipientUserId, t.createdAt),
    index('app_presentations_verifier_idx').on(t.verifierOrganizationId),
    check('app_presentations_scope', sql`${t.scope} IN ('public', 'full')`),
    check(
      'app_presentations_audience',
      sql`${t.scope} <> 'full' OR ${t.verifierOrganizationId} IS NOT NULL`,
    ),
    check('app_presentations_token', sql`${t.tokenHash} ~ ${HASH_PATTERN}`),
    check(
      'app_presentations_revocation',
      sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.createdAt}`,
    ),
  ],
)

// Verification history retains evidence summaries only: never claim values or link tokens.
export const appVerifierHistory = pgTable(
  'app_verifier_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    verifierOrganizationId: uuid('verifier_organization_id')
      .notNull()
      .references(() => appOrganizations.id, { onDelete: 'restrict' }),
    verifierUserId: uuid('verifier_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    presentationId: uuid('presentation_id')
      .notNull()
      .references(() => appPresentations.id, { onDelete: 'restrict' }),
    profileId: text('profile_id').notNull(),
    generationId: text('generation_id').notNull(),
    scope: text('scope', { enum: ['public', 'full'] }).notNull(),
    onChain: text('on_chain').notNull(),
    schemaStatus: text('schema_status').notNull(),
    payloadStatus: text('payload_status').notNull(),
    issuerTrust: text('issuer_trust').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_verifier_history_user_idx').on(t.verifierUserId, t.checkedAt, t.id),
    index('app_verifier_history_organization_idx').on(t.verifierOrganizationId, t.checkedAt, t.id),
    check('app_verifier_history_profile', sql`length(${t.profileId}) BETWEEN 1 AND 200`),
    check('app_verifier_history_generation', sql`${t.generationId} ~ ${HASH_PATTERN}`),
    check('app_verifier_history_scope', sql`${t.scope} IN ('public', 'full')`),
    check(
      'app_verifier_history_chain',
      sql`${t.onChain} IN ('not_found', 'pending', 'active', 'expired', 'deleted')`,
    ),
    check('app_verifier_history_schema', sql`${t.schemaStatus} IN ('valid', 'unknown')`),
    check(
      'app_verifier_history_payload',
      sql`${t.payloadStatus} IN ('valid', 'unavailable', 'tampered', 'invalid', 'not_checked')`,
    ),
    check(
      'app_verifier_history_trust',
      sql`${t.issuerTrust} IN ('trusted', 'untrusted', 'unknown')`,
    ),
  ],
)

// A separate purpose prevents a presentation signature from being consumed as a wallet link.
export const appPresentationChallenges = pgTable(
  'app_presentation_challenges',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => appSessions.id, { onDelete: 'cascade' }),
    presentationId: uuid('presentation_id').notNull().unique(),
    request: jsonb('request').$type<PresentationProofRequest>().notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('app_presentation_challenges_session_idx').on(t.sessionId),
    index('app_presentation_challenges_expiry_idx').on(t.expiresAt),
    check('app_presentation_challenges_request', sql`jsonb_typeof(${t.request}) = 'object'`),
    check(
      'app_presentation_challenges_message',
      sql`octet_length(${t.message}) BETWEEN 1 AND 8192`,
    ),
    check(
      'app_presentation_challenges_dates',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes' AND isfinite(${t.expiresAt})`,
    ),
  ],
)

export interface PresentationProofRequest {
  version: 1
  origin: string
  challengeId: string
  presentationId: string
  nonce: string
  issuedAt: string
  expiresAt: string
  profileId: string
  networkId: number
  generationId: string
  issuerAddress: string
  subjectAddress: string
  schemaUid: string
  payloadDigest: string | null
  visibility: 'public' | 'private'
  publicFields: string[]
  scope: 'public' | 'full'
  verifierOrganizationId: string | null
}

// Public signature evidence only; share tokens remain hashed in app_presentations.
export const appPresentationProofs = pgTable(
  'app_presentation_proofs',
  {
    presentationId: uuid('presentation_id')
      .primaryKey()
      .references(() => appPresentations.id, { onDelete: 'restrict' }),
    request: jsonb('request').$type<PresentationProofRequest>().notNull(),
    message: text('message').notNull(),
    signature: text('signature').notNull(),
    publicKey: text('public_key').notNull(),
    scheme: text('scheme', { enum: ['ripple', 'otsu'] }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('app_presentation_proofs_request', sql`jsonb_typeof(${t.request}) = 'object'`),
    check('app_presentation_proofs_message', sql`octet_length(${t.message}) BETWEEN 1 AND 8192`),
    check('app_presentation_proofs_signature', sql`${t.signature} ~ '^[0-9A-Fa-f]{128,144}$'`),
    check('app_presentation_proofs_key', sql`${t.publicKey} ~ '^(02|03|ED|ed)[0-9A-Fa-f]{64}$'`),
    check('app_presentation_proofs_scheme', sql`${t.scheme} IN ('ripple', 'otsu')`),
  ],
)
