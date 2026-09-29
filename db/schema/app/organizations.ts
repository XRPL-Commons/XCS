import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

import { HASH_PATTERN } from '../common.js'
import { appUsers } from './identity.js'

export const appOrganizations = pgTable(
  'app_organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    responsibleUserId: uuid('responsible_user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'suspended', 'closed'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('app_organizations_responsible_idx').on(t.responsibleUserId),
    check('app_organizations_name', sql`length(btrim(${t.name})) > 0`),
    check('app_organizations_status', sql`${t.status} IN ('active', 'suspended', 'closed')`),
  ],
)

// One application/profile per organization and role; approvals are independent.
export const appOrganizationApplications = pgTable(
  'app_organization_applications',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => appOrganizations.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['issuer', 'verifier'] }).notNull(),
    revision: integer('revision').notNull().default(0),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'suspended'] })
      .notNull()
      .default('pending'),
    website: text('website'),
    contact: text('contact'),
    jurisdiction: text('jurisdiction'),
    description: text('description'),
    purpose: text('purpose'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by').references(() => appUsers.id, { onDelete: 'restrict' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewReason: text('review_reason'),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.role] }),
    index('app_organization_applications_queue_idx').on(t.status, t.submittedAt),
    check('app_organization_applications_revision', sql`${t.revision} >= 0`),
    check('app_organization_applications_role', sql`${t.role} IN ('issuer', 'verifier')`),
    check(
      'app_organization_applications_status',
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'suspended')`,
    ),
    check(
      'app_organization_applications_review',
      sql`(${t.status} = 'pending' AND ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.reviewReason} IS NULL) OR (${t.status} <> 'pending' AND ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.reviewedAt} >= ${t.submittedAt})`,
    ),
    check(
      'app_organization_applications_reason',
      sql`${t.status} NOT IN ('rejected', 'suspended') OR (${t.reviewReason} IS NOT NULL AND length(btrim(${t.reviewReason})) > 0)`,
    ),
  ],
)

export const appDocuments = pgTable(
  'app_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    applicationRole: text('application_role', { enum: ['issuer', 'verifier'] }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'restrict' }),
    reviewStatus: text('review_status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId, t.applicationRole],
      foreignColumns: [
        appOrganizationApplications.organizationId,
        appOrganizationApplications.role,
      ],
      name: 'app_documents_application_fk',
    }).onDelete('restrict'),
    index('app_documents_application_idx').on(t.organizationId, t.applicationRole),
    check('app_documents_size', sql`${t.byteLength} > 0`),
    check('app_documents_digest', sql`${t.sha256} ~ ${HASH_PATTERN}`),
    check('app_documents_storage_key', sql`length(btrim(${t.storageKey})) > 0`),
    check('app_documents_review', sql`${t.reviewStatus} IN ('pending', 'approved', 'rejected')`),
  ],
)
