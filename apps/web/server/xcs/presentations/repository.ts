import { and, eq, isNull, sql } from 'drizzle-orm'
import { appOrganizations, appPresentations } from '#db/schema/app'
import {
  filterCredentialClaims,
  hashAppToken,
  type Claims,
  type DatabaseClient,
  type XcsDatabase,
} from '../../lib/db/index.js'
import type { Session } from '../auth/types'
import {
  currentPortalSession,
  managedCredentialRow,
  managedPayload,
  presentationDto,
  recipientCredentialDto,
} from '../recipient/repository'
import { RecipientError, type ResolvedPresentation } from '../recipient/types'
import { managedCredentialEvidence, type EvidencePolicy } from './evidence'
import { issuerAdmission } from './admission'
import { loadPresentationProof } from './proof'

export type PresentationObserver = (
  db: XcsDatabase,
  session: Session,
  result: ResolvedPresentation,
) => Promise<void>

export class PresentationRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly observer?: PresentationObserver,
    private readonly policy: EvidencePolicy = {},
  ) {}

  private resolveWhere(
    session: Session | null,
    selector: { tokenHash: string } | { id: string },
  ): Promise<ResolvedPresentation> {
    return this.client.db.transaction(
      async (tx) => {
        const db = tx as unknown as XcsDatabase
        if (session) await currentPortalSession(db, session)
        // Share lock serializes disclosure with recipient revocation without consuming a grant.
        await db.execute(
          'tokenHash' in selector
            ? sql`SELECT id FROM app_presentations WHERE token_hash=${selector.tokenHash} AND revoked_at IS NULL FOR SHARE`
            : sql`SELECT id FROM app_presentations WHERE id=${selector.id} AND revoked_at IS NULL FOR SHARE`,
        )
        const [row] = await db
          .select({ presentation: appPresentations, name: appOrganizations.name })
          .from(appPresentations)
          .leftJoin(
            appOrganizations,
            eq(appOrganizations.id, appPresentations.verifierOrganizationId),
          )
          .where(
            and(
              isNull(appPresentations.revokedAt),
              'tokenHash' in selector
                ? eq(appPresentations.tokenHash, selector.tokenHash)
                : eq(appPresentations.id, selector.id),
            ),
          )
        if (!row) throw new RecipientError(404, 'PRESENTATION_UNAVAILABLE')
        const credential = await managedCredentialRow(
          db,
          row.presentation.profileId,
          row.presentation.generationId,
        )
        if (credential.metadata.recipientUserId !== row.presentation.recipientUserId)
          throw new RecipientError(404, 'PRESENTATION_UNAVAILABLE')
        const holderProof = await loadPresentationProof(db, row.presentation.id, credential)
        if (holderProof.status === 'invalid')
          throw new RecipientError(404, 'PRESENTATION_UNAVAILABLE')
        let scope: 'public' | 'full' = 'public'
        if (row.presentation.scope === 'full' && session) {
          const authorized = await db.execute(sql`SELECT o.id FROM app_organizations o
          JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier'
          WHERE o.id=${row.presentation.verifierOrganizationId} AND o.responsible_user_id=${session.userId}
          AND o.status='active' AND a.status='approved'`)
          if (authorized.length) scope = 'full'
        }
        const content = await managedPayload(db, credential.metadata)
        const { verification } = await managedCredentialEvidence(
          db,
          credential.metadata,
          content,
          true,
          this.policy,
        )
        if (content === undefined) verification.payload = 'unavailable'
        // Validate the stored canonical bytes locally, then expose only the selected claims.
        // Ownership and administrator status never widen a link's scope. Already-public credentials
        // expose all claims; private credentials expose only the issuer-selected public fields.
        const claims =
          content !== undefined && verification.payload === 'valid'
            ? filterCredentialClaims((JSON.parse(content) as { claims: Claims }).claims, {
                scope: credential.metadata.visibility === 'public' ? 'full' : scope,
                publicFields: credential.metadata.publicFields,
              })
            : {}
        if (scope === 'public' && verification.payload === 'valid')
          verification.payload = 'not_checked'
        const result: ResolvedPresentation = {
          presentation: presentationDto(row.presentation, row.name),
          credential: recipientCredentialDto(
            credential,
            verification.onChain as ResolvedPresentation['credential']['status']['state'],
          ),
          scope,
          claims,
          verification,
          issuerAdmission: await issuerAdmission(db, credential.metadata.issuerOrganizationId),
          holderProof,
          requiresAuthorization: row.presentation.scope === 'full' && scope !== 'full',
        }
        if (session && this.observer) await this.observer(db, session, result)
        return result
      },
      { isolationLevel: 'repeatable read' },
    )
  }
  resolve(session: Session | null, token: string) {
    const tokenHash = hashAppToken(token)
    if (!tokenHash) throw new RecipientError(404, 'PRESENTATION_UNAVAILABLE')
    return this.resolveWhere(session, { tokenHash })
  }
  /** Only a history controller that already proved ownership may resolve an internal ID. */
  resolveById(session: Session, id: string) {
    return this.resolveWhere(session, { id })
  }
}
