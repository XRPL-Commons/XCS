import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { HASH_PATTERN } from '../common.js'
import { appUsers } from './identity.js'
import { appOrganizationApplications } from './organizations.js'

export const appAdminDecisions = pgTable(
  'app_admin_decisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    role: text('role', { enum: ['issuer', 'verifier'] }).notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    action: text('action', { enum: ['approve', 'reject', 'suspend', 'restore'] }).notNull(),
    beforeStatus: text('before_status').notNull(),
    afterStatus: text('after_status').notNull(),
    reason: text('reason'),
    revision: integer('revision').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'app_admin_decisions_application_fk',
      columns: [t.organizationId, t.role],
      foreignColumns: [
        appOrganizationApplications.organizationId,
        appOrganizationApplications.role,
      ],
    }).onDelete('restrict'),
    uniqueIndex('app_admin_decisions_idempotency_uq').on(t.actorId, t.idempotencyKey),
    uniqueIndex('app_admin_decisions_revision_uq').on(t.organizationId, t.role, t.revision),
    index('app_admin_decisions_history_idx').on(t.createdAt, t.id),
    check('app_admin_decisions_revision', sql`${t.revision} > 0`),
    check('app_admin_decisions_hash', sql`${t.requestHash} ~ ${HASH_PATTERN}`),
    check(
      'app_admin_decisions_transition',
      sql`(${t.action} = 'approve' AND ${t.beforeStatus} = 'pending' AND ${t.afterStatus} = 'approved') OR (${t.action} = 'reject' AND ${t.beforeStatus} = 'pending' AND ${t.afterStatus} = 'rejected') OR (${t.action} = 'suspend' AND ${t.role} = 'verifier' AND ${t.beforeStatus} = 'approved' AND ${t.afterStatus} = 'suspended') OR (${t.action} = 'restore' AND ${t.role} = 'verifier' AND ${t.beforeStatus} = 'suspended' AND ${t.afterStatus} = 'approved')`,
    ),
    check(
      'app_admin_decisions_reason',
      sql`${t.action} NOT IN ('reject', 'suspend') OR (${t.reason} IS NOT NULL AND length(btrim(${t.reason})) > 0)`,
    ),
  ],
)

export const appAdminNotifications = pgTable(
  'app_admin_notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    decisionId: uuid('decision_id')
      .notNull()
      .unique()
      .references(() => appAdminDecisions.id, { onDelete: 'restrict' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    recipientEmail: text('recipient_email'),
    status: text('status', {
      enum: ['pending', 'sending', 'sent', 'failed', 'blocked', 'uncertain'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    attemptId: uuid('attempt_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_admin_notifications_queue_idx').on(t.status, t.createdAt),
    check(
      'app_admin_notifications_status',
      sql`${t.status} IN ('pending', 'sending', 'sent', 'failed', 'blocked', 'uncertain')`,
    ),
    check('app_admin_notifications_attempts', sql`${t.attempts} >= 0`),
    check(
      'app_admin_notifications_sending',
      sql`${t.status} <> 'sending' OR (${t.attemptId} IS NOT NULL AND ${t.claimedAt} IS NOT NULL AND ${t.recipientEmail} IS NOT NULL)`,
    ),
    check('app_admin_notifications_sent', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
  ],
)

export const appAdminBootstrapAudit = pgTable(
  'app_admin_bootstrap_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    operator: text('operator').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('app_admin_bootstrap_operator', sql`length(btrim(${t.operator})) BETWEEN 1 AND 200`),
  ],
)
