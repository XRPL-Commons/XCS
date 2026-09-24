import { sql } from 'drizzle-orm'
import type { DatabaseClient } from '../../lib/db/index.js'
import type { XcsDatabase } from '../../lib/db/client.js'
import type { Session } from '../auth/types'
import type { IssuerRepository } from '../issuer/repository'
import type { ApplicationInput } from '../issuer/types'
import type { ResolvedPresentation } from '../recipient/types'
import type { VerificationReport } from '../verification'
import { VerifierError, type VerifierHistoryEntry, type VerifierWorkspace } from './types'

type Query = DatabaseClient['sql']
export type PresentationResolver = (
  session: Session,
  presentationId: string,
) => Promise<ResolvedPresentation>

export class VerifierRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly applications: Pick<IssuerRepository, 'apply'>,
  ) {}

  private async session(query: Query, session: Session) {
    const [current] = await query`SELECT s.id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
      AND u.status='active' AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()`
    if (!current) throw new VerifierError(401, 'AUTH_REQUIRED')
  }

  async workspace(session: Session, selected?: string): Promise<VerifierWorkspace> {
    await this.session(this.client.sql, session)
    const organizations = await this.client.sql`SELECT o.id,o.name,o.status,
      a.status AS "applicationStatus",a.review_reason AS "reviewReason",a.revision
      FROM app_organizations o JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier'
      WHERE o.responsible_user_id=${session.userId}
      ORDER BY (o.status='active' AND a.status='approved') DESC,o.created_at,o.id`
    const chosen = selected ?? organizations[0]?.id
    const organization = organizations.find((entry) => entry.id === chosen)
    if (chosen && !organization) throw new VerifierError(404, 'VERIFIER_ORGANIZATION_NOT_FOUND')
    return {
      organizations: organizations as unknown as VerifierWorkspace['organizations'],
      selectedOrganizationId: organization?.id ?? null,
      history:
        organization?.status === 'active' && organization.applicationStatus === 'approved'
          ? await this.history(session, organization.id)
          : [],
    }
  }

  apply(session: Session, input: ApplicationInput) {
    return this.applications.apply(session, input, 'verifier')
  }

  private async approvedOrganization(session: Session, organizationId?: string) {
    await this.session(this.client.sql, session)
    const rows = organizationId
      ? await this.client.sql`SELECT o.id FROM app_organizations o
        JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier'
        WHERE o.id=${organizationId} AND o.responsible_user_id=${session.userId}
        AND o.status='active' AND a.status='approved'`
      : await this.client.sql`SELECT o.id FROM app_organizations o
        JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier'
        WHERE o.responsible_user_id=${session.userId} AND o.status='active' AND a.status='approved'
        ORDER BY o.created_at,o.id LIMIT 1`
    if (!rows[0]) throw new VerifierError(403, 'VERIFIER_APPROVAL_REQUIRED')
    return String(rows[0].id)
  }

  async history(session: Session, organizationId?: string): Promise<VerifierHistoryEntry[]> {
    const id = await this.approvedOrganization(session, organizationId)
    const rows = await this.client.sql`SELECT h.id,h.verifier_organization_id,h.presentation_id,
      h.profile_id,h.generation_id,h.scope,h.checked_at,h.on_chain,h.schema_status,h.payload_status,h.issuer_trust
      FROM app_verifier_history h
      JOIN app_organizations o ON o.id=h.verifier_organization_id AND o.responsible_user_id=${session.userId} AND o.status='active'
      JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier' AND a.status='approved'
      JOIN app_sessions s ON s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
      JOIN app_users u ON u.id=s.user_id AND u.status='active'
      WHERE h.verifier_organization_id=${id} AND h.verifier_user_id=${session.userId}
      AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()
      ORDER BY h.checked_at DESC,h.id DESC LIMIT 500`
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.verifier_organization_id,
      presentationId: row.presentation_id,
      profileId: row.profile_id,
      generationId: row.generation_id,
      scope: row.scope,
      checkedAt: new Date(row.checked_at).toISOString(),
      verification: {
        onChain: row.on_chain,
        schema: row.schema_status,
        payload: row.payload_status,
        issuerTrust: row.issuer_trust,
      } as VerificationReport,
    }))
  }

  async reopen(session: Session, id: string, resolve: PresentationResolver) {
    await this.session(this.client.sql, session)
    const [entry] = await this.client.sql`SELECT h.presentation_id FROM app_verifier_history h
      JOIN app_organizations o ON o.id=h.verifier_organization_id AND o.responsible_user_id=${session.userId} AND o.status='active'
      JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier' AND a.status='approved'
      WHERE h.id=${id} AND h.verifier_user_id=${session.userId}`
    if (!entry) throw new VerifierError(404, 'VERIFIER_HISTORY_NOT_FOUND')
    // History is a locator, never a cached access grant or a cache of private claims.
    return resolve(session, String(entry.presentation_id))
  }

  /** Called inside the presentation resolver's authorized, consistent transaction. */
  async record(db: XcsDatabase, session: Session, result: ResolvedPresentation) {
    if (result.requiresAuthorization) return
    const audience = result.scope === 'full' ? result.presentation.verifierOrganizationId : null
    if (result.scope === 'full' && !audience) return
    await db.execute(sql`INSERT INTO app_verifier_history
      (verifier_organization_id,verifier_user_id,presentation_id,profile_id,generation_id,scope,on_chain,schema_status,payload_status,issuer_trust)
      SELECT o.id,s.user_id,p.id,p.profile_id,p.generation_id,${result.scope},
        ${result.verification.onChain},${result.verification.schema},${result.verification.payload},${result.verification.issuerTrust}
      FROM app_organizations o
      JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier' AND a.status='approved'
      JOIN app_sessions s ON s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
      JOIN app_users u ON u.id=s.user_id AND u.status='active'
      JOIN app_presentations p ON p.id=${result.presentation.id} AND p.revoked_at IS NULL
      WHERE o.responsible_user_id=s.user_id AND o.status='active'
      AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()
      AND p.profile_id=${result.credential.profileId} AND p.generation_id=${result.credential.generationId}
      AND (${result.scope}='public' AND p.scope='public' OR ${result.scope}='full' AND p.scope='full' AND p.verifier_organization_id=o.id)
      AND (${audience}::uuid IS NULL OR o.id=${audience}::uuid)
      ORDER BY o.created_at,o.id LIMIT 1`)
  }
}
