import { sql } from 'drizzle-orm'
import type { XcsDatabase } from '../../lib/db/index.js'

export interface IssuerAdmission {
  status: 'approved' | 'suspended' | 'not_approved' | 'unknown'
  organizationId: string
  checkedAt: string
  reviewedAt: string | null
}

/** Current portal admission, not historical approval or a claim about issuer trust. */
export async function issuerAdmission(
  db: XcsDatabase,
  organizationId: string,
): Promise<IssuerAdmission> {
  const [row] = await db.execute(sql`SELECT o.status AS organization_status,
    a.status AS application_status,a.reviewed_at,statement_timestamp() AS checked_at
    FROM app_organizations o LEFT JOIN app_organization_applications a
      ON a.organization_id=o.id AND a.role='issuer'
    WHERE o.id=${organizationId}`)
  // A missing organization contradicts the credential's foreign key, so do not invent evidence.
  if (!row) throw new Error('ISSUER_ADMISSION_UNAVAILABLE')
  const status: IssuerAdmission['status'] =
    row.organization_status === 'suspended' || row.application_status === 'suspended'
      ? 'suspended'
      : row.organization_status === 'active' && row.application_status === 'approved'
        ? 'approved'
        : row.application_status == null
          ? 'unknown'
          : 'not_approved'
  return {
    status,
    organizationId,
    checkedAt: new Date(String(row.checked_at)).toISOString(),
    reviewedAt: row.reviewed_at == null ? null : new Date(String(row.reviewed_at)).toISOString(),
  }
}
