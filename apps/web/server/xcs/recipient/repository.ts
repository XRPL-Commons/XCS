import { randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  appCredentialMetadata,
  appInvites,
  appIssuerPayloads,
  appOrganizations,
  appPresentations,
  appPresentationChallenges,
  appPresentationProofs,
  type PresentationProofRequest,
} from '#db/schema/app'
import { credentialEvents, credentialGenerations, networkProfiles, schemas } from '#db/schema'
import {
  createAppToken,
  filterCredentialClaims,
  type Claims,
  type DatabaseClient,
  type XcsDatabase,
} from '../../lib/db/index.js'
import type { Session } from '../auth/types'
import { verifyWalletProof } from '../auth/wallet-proof'
import { presentationProofMessage, proofMatchesCredential } from '../presentations/proof'
import {
  managedCredentialEvidence,
  type CredentialMetadata,
  type EvidencePolicy,
} from '../presentations/evidence'
import { IndexerUnavailableError } from '../ledger-freshness'
import {
  RecipientError,
  type CreatePresentationInput,
  type PresentationChallengeInput,
  type PresentationChallenge,
  type CreatedPresentation,
  type Presentation,
  type RecipientCredential,
  type RecipientCredentialDetail,
  type RecipientPayload,
  type RecipientWorkspace,
} from './types'

export async function currentPortalSession(db: XcsDatabase, session: Session): Promise<void> {
  const rows =
    await db.execute(sql`SELECT s.id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
    WHERE s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
    AND u.status='active' AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()`)
  if (!rows.length) throw new RecipientError(401, 'AUTH_REQUIRED')
}

export function presentationDto(
  row: typeof appPresentations.$inferSelect,
  name: string | null,
): Presentation {
  return {
    id: row.id,
    profileId: row.profileId,
    generationId: row.generationId,
    scope: row.scope,
    verifierOrganizationId: row.verifierOrganizationId,
    verifierOrganizationName: name,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

export async function managedCredentialRow(
  db: XcsDatabase,
  profileId: string,
  generationId: string,
) {
  const [row] = await db
    .select({
      metadata: appCredentialMetadata,
      organizationName: appOrganizations.name,
      schemaName: schemas.name,
      networkId: networkProfiles.networkId,
      generation: credentialGenerations,
    })
    .from(appCredentialMetadata)
    .innerJoin(
      appOrganizations,
      eq(appOrganizations.id, appCredentialMetadata.issuerOrganizationId),
    )
    .innerJoin(networkProfiles, eq(networkProfiles.profileId, appCredentialMetadata.profileId))
    .leftJoin(
      schemas,
      and(
        eq(schemas.profileId, appCredentialMetadata.profileId),
        eq(schemas.schemaUid, appCredentialMetadata.schemaUid),
      ),
    )
    .leftJoin(
      credentialGenerations,
      and(
        eq(credentialGenerations.profileId, appCredentialMetadata.profileId),
        eq(credentialGenerations.generationId, appCredentialMetadata.generationId),
      ),
    )
    .where(
      and(
        eq(appCredentialMetadata.profileId, profileId),
        eq(appCredentialMetadata.generationId, generationId),
      ),
    )
  if (!row) throw new RecipientError(404, 'RECIPIENT_CREDENTIAL_NOT_FOUND')
  return row
}
export function recipientCredentialDto(
  row: Awaited<ReturnType<typeof managedCredentialRow>>,
  state: RecipientCredential['status']['state'] = 'unknown',
): RecipientCredential {
  const { metadata: m, generation: g } = row
  return {
    profileId: m.profileId,
    generationId: m.generationId,
    schemaUid: m.schemaUid,
    schemaName: row.schemaName,
    organizationId: m.issuerOrganizationId,
    organizationName: row.organizationName,
    issuerAddress: m.issuerAddress,
    subjectAddress: m.subjectAddress,
    networkId: row.networkId,
    visibility: m.visibility,
    createdAt: m.createdAt.toISOString(),
    creationTransactionHash: m.creationTransactionHash,
    status: {
      state,
      accepted: g?.accepted ?? null,
      expiration: g?.expiration ?? null,
      deletedLedgerIndex: g?.deletedLedgerIndex ?? null,
      deletionCause: g?.deletionCause ?? null,
    },
  }
}
export async function managedPayload(
  db: XcsDatabase,
  metadata: CredentialMetadata,
): Promise<string | undefined> {
  if (!metadata.payloadStorageKey) return undefined
  const [payload] = await db
    .select()
    .from(appIssuerPayloads)
    .where(eq(appIssuerPayloads.id, metadata.payloadStorageKey))
  // The stored bytes must still be bound to the exact recorded issuance; no remote fallback.
  if (
    !payload ||
    payload.inviteId !== metadata.inviteId ||
    payload.subjectAddress !== metadata.subjectAddress ||
    payload.payloadDigest !== metadata.payloadDigest
  )
    throw new RecipientError(409, 'RECIPIENT_PAYLOAD_UNAVAILABLE')
  return payload.canonicalPayload
}

export class RecipientRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly origin: string,
    private readonly policy: EvidencePolicy = {},
  ) {}

  private transaction<T>(
    work: (db: XcsDatabase) => Promise<T>,
    isolationLevel: 'repeatable read' | 'read committed' = 'repeatable read',
  ): Promise<T> {
    return this.client.db.transaction((tx) => work(tx as unknown as XcsDatabase), {
      isolationLevel,
    })
  }
  private async owned(db: XcsDatabase, session: Session, profileId: string, generationId: string) {
    await currentPortalSession(db, session)
    const row = await managedCredentialRow(db, profileId, generationId)
    if (row.metadata.recipientUserId !== session.userId)
      throw new RecipientError(404, 'RECIPIENT_CREDENTIAL_NOT_FOUND')
    return row
  }
  private async detail(
    db: XcsDatabase,
    session: Session,
    profileId: string,
    generationId: string,
  ): Promise<RecipientCredentialDetail> {
    const row = await this.owned(db, session, profileId, generationId)
    let state: RecipientCredential['status']['state'] = 'unknown'
    try {
      state = (await managedCredentialEvidence(db, row.metadata, undefined, false, this.policy))
        .verification.onChain as RecipientCredential['status']['state']
    } catch (error) {
      if (!(error instanceof IndexerUnavailableError)) throw error
    }
    const events = await db
      .select({
        transactionHash: credentialEvents.transactionHash,
        eventType: credentialEvents.eventType,
        ledgerIndex: credentialEvents.ledgerIndex,
        deletionCause: credentialEvents.deletionCause,
      })
      .from(credentialEvents)
      .where(
        and(
          eq(credentialEvents.profileId, profileId),
          eq(credentialEvents.generationId, generationId),
        ),
      )
      .orderBy(desc(credentialEvents.ledgerIndex), desc(credentialEvents.transactionIndex))
      .limit(100)
    const [schema] = await db
      .select({ definition: schemas.resolvedDefinition })
      .from(schemas)
      .where(and(eq(schemas.profileId, profileId), eq(schemas.schemaUid, row.metadata.schemaUid)))
    const fields = (schema?.definition as { fields?: Record<string, unknown> } | undefined)?.fields
    return {
      ...recipientCredentialDto(row, state),
      disclosure: {
        publicFields: row.metadata.publicFields,
        fields: fields && typeof fields === 'object' ? Object.keys(fields) : [],
      },
      events: events as RecipientCredentialDetail['events'],
    }
  }
  async workspace(session: Session): Promise<RecipientWorkspace> {
    return this.transaction(async (db) => {
      await currentPortalSession(db, session)
      const references = await db
        .select({
          profileId: appCredentialMetadata.profileId,
          generationId: appCredentialMetadata.generationId,
        })
        .from(appCredentialMetadata)
        .where(eq(appCredentialMetadata.recipientUserId, session.userId))
        .orderBy(desc(appCredentialMetadata.createdAt))
        .limit(200)
      const credentials: RecipientCredential[] = []
      for (const reference of references) {
        const row = await managedCredentialRow(db, reference.profileId, reference.generationId)
        let state: RecipientCredential['status']['state'] = 'unknown'
        try {
          state = (await managedCredentialEvidence(db, row.metadata, undefined, false, this.policy))
            .verification.onChain as RecipientCredential['status']['state']
        } catch (error) {
          if (!(error instanceof IndexerUnavailableError)) throw error
        }
        credentials.push(recipientCredentialDto(row, state))
      }
      const invitations = await db
        .select({
          invite: appInvites,
          name: appOrganizations.name,
          schemaName: schemas.name,
          generationId: appCredentialMetadata.generationId,
        })
        .from(appInvites)
        .innerJoin(appOrganizations, eq(appOrganizations.id, appInvites.organizationId))
        .leftJoin(
          schemas,
          and(
            eq(schemas.profileId, appInvites.profileId),
            eq(schemas.schemaUid, appInvites.schemaUid),
          ),
        )
        .leftJoin(appCredentialMetadata, eq(appCredentialMetadata.inviteId, appInvites.id))
        .where(eq(appInvites.claimedBy, session.userId))
        .orderBy(desc(appInvites.claimedAt))
        .limit(200)
      // In-app notifications come from durable issuance and ledger events, including out-of-portal revocation.
      const notices = await db.execute<{
        id: string
        kind: 'issued' | 'revoked'
        profileId: string
        generationId: string
        organizationName: string
        createdAt: string
      }>(sql`
        SELECT e.transaction_hash || ':' || e.node_index AS id,
          CASE WHEN e.event_type='created' THEN 'issued' ELSE 'revoked' END AS kind,
          m.profile_id AS "profileId",m.generation_id AS "generationId",o.name AS "organizationName",e.recorded_at AS "createdAt"
        FROM app_credential_metadata m JOIN credential_events e ON e.profile_id=m.profile_id AND e.generation_id=m.generation_id
        JOIN app_organizations o ON o.id=m.issuer_organization_id
        WHERE m.recipient_user_id=${session.userId} AND (e.event_type='created' OR (e.event_type='deleted' AND e.deletion_cause='issuer_revoked'))
        ORDER BY e.recorded_at DESC,e.transaction_hash DESC LIMIT 200`)
      return {
        credentials,
        invitations: invitations.map(({ invite: i, name, schemaName, generationId }) => ({
          id: i.id,
          organizationId: i.organizationId,
          organizationName: name,
          profileId: i.profileId,
          schemaUid: i.schemaUid,
          schemaName,
          claimedAt: i.claimedAt!.toISOString(),
          expiresAt: i.expiresAt.toISOString(),
          revokedAt: i.revokedAt?.toISOString() ?? null,
          generationId,
        })),
        notifications: notices.map((n) => ({
          ...n,
          createdAt: new Date(n.createdAt).toISOString(),
        })),
      }
    })
  }
  credential(session: Session, profileId: string, generationId: string) {
    return this.transaction((db) => this.detail(db, session, profileId, generationId))
  }
  payload(session: Session, profileId: string, generationId: string): Promise<RecipientPayload> {
    return this.transaction(async (db) => {
      const row = await this.owned(db, session, profileId, generationId)
      const content = await managedPayload(db, row.metadata)
      if (content === undefined) throw new RecipientError(404, 'RECIPIENT_PAYLOAD_UNAVAILABLE')
      const { verification } = await managedCredentialEvidence(
        db,
        row.metadata,
        content,
        true,
        this.policy,
      )
      if (verification.payload !== 'valid')
        throw new RecipientError(409, 'RECIPIENT_PAYLOAD_INVALID')
      return {
        scope: 'full',
        claims: filterCredentialClaims((JSON.parse(content) as { claims: Claims }).claims, {
          scope: 'full',
          publicFields: [],
        }),
        verification,
      }
    })
  }
  reconcile(
    session: Session,
    profileId: string,
    generationId: string,
    transactionHash: string,
    action: 'accept' | 'reject' | 'remove',
  ) {
    return this.transaction(async (db) => {
      const row = await this.owned(db, session, profileId, generationId)
      // Rejection needs ledger evidence only. Never load payload bytes on this path.
      const { generation } = await managedCredentialEvidence(
        db,
        row.metadata,
        undefined,
        false,
        this.policy,
      )
      const wallets = await db.execute(
        sql`SELECT id FROM app_wallets WHERE user_id=${session.userId} AND network_id=${row.networkId} AND address=${row.metadata.subjectAddress} AND revoked_at IS NULL`,
      )
      if (!wallets.length) throw new RecipientError(403, 'RECIPIENT_WALLET_REQUIRED')
      const [event] = await db
        .select()
        .from(credentialEvents)
        .where(
          and(
            eq(credentialEvents.profileId, profileId),
            eq(credentialEvents.generationId, generationId),
            eq(credentialEvents.transactionHash, transactionHash),
          ),
        )
      if (
        !event ||
        event.issuer !== row.metadata.issuerAddress ||
        event.subject !== row.metadata.subjectAddress ||
        event.schemaUid !== row.metadata.schemaUid ||
        event.ledgerIndex < generation.createdLedgerIndex ||
        event.ledgerIndex > generation.lastLedgerIndex ||
        (action === 'accept'
          ? event.eventType !== 'accepted' || !event.accepted
          : event.eventType !== 'deleted' ||
            event.deletionCause !== (action === 'reject' ? 'subject_rejected' : 'subject_removed'))
      )
        throw new RecipientError(409, 'RECIPIENT_ACTION_NOT_VALIDATED')
      return this.detail(db, session, profileId, generationId)
    })
  }
  verifiers(session: Session) {
    return this.transaction(async (db) => {
      await currentPortalSession(db, session)
      const rows = await db.execute<{ id: string; name: string }>(
        sql`SELECT o.id,o.name FROM app_organizations o JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier' WHERE o.status='active' AND a.status='approved' ORDER BY o.name,o.id LIMIT 200`,
      )
      return { verifiers: [...rows] }
    })
  }
  presentations(session: Session, filter?: { profileId: string; generationId: string }) {
    return this.transaction(async (db) => {
      await currentPortalSession(db, session)
      const rows = await db
        .select({ presentation: appPresentations, name: appOrganizations.name })
        .from(appPresentations)
        .leftJoin(
          appOrganizations,
          eq(appOrganizations.id, appPresentations.verifierOrganizationId),
        )
        .where(
          and(
            eq(appPresentations.recipientUserId, session.userId),
            ...(filter
              ? [
                  eq(appPresentations.profileId, filter.profileId),
                  eq(appPresentations.generationId, filter.generationId),
                ]
              : []),
          ),
        )
        .orderBy(desc(sql`${appPresentations.revokedAt} IS NULL`), desc(appPresentations.createdAt))
        .limit(200)
      return { presentations: rows.map((r) => presentationDto(r.presentation, r.name)) }
    })
  }
  private async presentationReady(
    db: XcsDatabase,
    session: Session,
    input: PresentationChallengeInput,
  ) {
    const row = await this.owned(db, session, input.profileId, input.generationId)
    // A stored historical link alone cannot authorize a new share after wallet removal.
    const wallets = await db.execute(
      sql`SELECT id FROM app_wallets WHERE user_id=${session.userId} AND network_id=${row.networkId} AND address=${row.metadata.subjectAddress} AND revoked_at IS NULL`,
    )
    if (!wallets.length) throw new RecipientError(409, 'RECIPIENT_WALLET_REQUIRED')
    const { verification } = await managedCredentialEvidence(
      db,
      row.metadata,
      undefined,
      false,
      this.policy,
    )
    if (verification.onChain !== 'active')
      throw new RecipientError(409, 'RECIPIENT_CREDENTIAL_NOT_ACTIVE')
    let verifierName: string | null = null
    if (input.scope === 'full') {
      if (!input.verifierOrganizationId)
        throw new RecipientError(400, 'RECIPIENT_VERIFIER_REQUIRED')
      const rows = await db.execute<{ name: string }>(
        sql`SELECT o.name FROM app_organizations o JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='verifier' WHERE o.id=${input.verifierOrganizationId} AND o.status='active' AND a.status='approved'`,
      )
      if (!rows[0]) throw new RecipientError(409, 'RECIPIENT_VERIFIER_UNAVAILABLE')
      verifierName = rows[0].name
    } else if (input.scope !== 'public' || input.verifierOrganizationId)
      throw new RecipientError(400, 'RECIPIENT_INPUT_INVALID')
    return { row, verifierName }
  }
  presentationChallenge(
    session: Session,
    input: PresentationChallengeInput,
  ): Promise<PresentationChallenge> {
    return this.transaction(async (db) => {
      const { row } = await this.presentationReady(db, session, input)
      // Use the same database clock as consumption; application-host clock skew cannot extend the proof window.
      const [clock] = await db.execute<{ now: string }>(sql`SELECT statement_timestamp() AS now`)
      const now = new Date(String(clock!.now)),
        expiresAt = new Date(now.getTime() + 300000)
      const id = randomUUID(),
        presentationId = randomUUID()
      const request: PresentationProofRequest = {
        version: 1,
        origin: this.origin,
        challengeId: id,
        presentationId,
        nonce: randomBytes(32).toString('base64url'),
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        profileId: input.profileId,
        networkId: row.networkId,
        generationId: input.generationId,
        issuerAddress: row.metadata.issuerAddress,
        subjectAddress: row.metadata.subjectAddress,
        schemaUid: row.metadata.schemaUid,
        payloadDigest: row.metadata.payloadDigest,
        visibility: row.metadata.visibility,
        publicFields: [...row.metadata.publicFields].sort(),
        scope: input.scope,
        verifierOrganizationId: input.verifierOrganizationId ?? null,
      }
      const message = presentationProofMessage(request)
      if (Buffer.byteLength(message) > 8192)
        throw new RecipientError(400, 'RECIPIENT_INPUT_INVALID')
      await db.execute(
        sql`DELETE FROM app_presentation_challenges WHERE session_id=${session.id} AND expires_at <= statement_timestamp()`,
      )
      await db.insert(appPresentationChallenges).values({
        id,
        sessionId: session.id,
        presentationId,
        request,
        message,
        createdAt: now,
        expiresAt,
      })
      return {
        id,
        presentationId,
        address: row.metadata.subjectAddress,
        networkId: row.networkId,
        message,
        expiresAt: expiresAt.toISOString(),
      }
    })
  }
  createPresentation(
    session: Session,
    input: CreatePresentationInput,
  ): Promise<CreatedPresentation> {
    return this.transaction(async (db) => {
      // Serialize quota decisions per owner/credential. READ COMMITTED below is intentional:
      // after waiting, authorization, ledger state and count must see the previous creator's commit.
      const key = JSON.stringify([
        'presentations',
        session.userId,
        input.profileId,
        input.generationId,
      ])
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`)
      const { row, verifierName } = await this.presentationReady(db, session, input)
      if (!input.proof) throw new RecipientError(400, 'RECIPIENT_PROOF_REQUIRED')
      // DELETE takes a row lock and rolls back with any later validation failure.
      // Separate challenge tables prevent wallet-link signatures from crossing purposes.
      const [challenge] = await db
        .delete(appPresentationChallenges)
        .where(
          and(
            eq(appPresentationChallenges.id, input.proof.challengeId),
            eq(appPresentationChallenges.sessionId, session.id),
          ),
        )
        .returning()
      if (!challenge) throw new RecipientError(403, 'RECIPIENT_PROOF_INVALID')
      const [clock] = await db.execute<{ fresh: boolean }>(
        sql`SELECT ${challenge.expiresAt.toISOString()}::timestamptz > statement_timestamp() AS fresh`,
      )
      if (!clock?.fresh) throw new RecipientError(409, 'RECIPIENT_PROOF_EXPIRED')
      const request = challenge.request
      if (
        request.origin !== this.origin ||
        request.challengeId !== challenge.id ||
        request.presentationId !== challenge.presentationId ||
        request.issuedAt !== challenge.createdAt.toISOString() ||
        request.expiresAt !== challenge.expiresAt.toISOString() ||
        request.scope !== input.scope ||
        request.verifierOrganizationId !== (input.verifierOrganizationId ?? null) ||
        !proofMatchesCredential(request, row) ||
        presentationProofMessage(request) !== challenge.message ||
        !verifyWalletProof(challenge.message, row.metadata.subjectAddress, input.proof)
      )
        throw new RecipientError(403, 'RECIPIENT_PROOF_INVALID')
      const [quota] = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM app_presentations WHERE recipient_user_id=${session.userId} AND profile_id=${input.profileId} AND generation_id=${input.generationId} AND revoked_at IS NULL`,
      )
      if (quota!.count >= 200) throw new RecipientError(409, 'RECIPIENT_PRESENTATION_LIMIT')
      const secret = createAppToken()
      const [presentation] = await db
        .insert(appPresentations)
        .values({
          id: challenge.presentationId,
          profileId: input.profileId,
          generationId: input.generationId,
          recipientUserId: session.userId,
          scope: input.scope,
          verifierOrganizationId: input.scope === 'full' ? input.verifierOrganizationId : null,
          tokenHash: secret.tokenHash,
        })
        .returning()
      await db.insert(appPresentationProofs).values({
        presentationId: presentation!.id,
        request,
        message: challenge.message,
        signature: input.proof.signature,
        publicKey: input.proof.publicKey,
        scheme: input.proof.scheme,
      })
      return {
        ...presentationDto(presentation!, verifierName),
        token: secret.token,
        url: `${this.origin}/presentations#${secret.token}`,
      }
    }, 'read committed')
  }
  revokePresentation(session: Session, id: string): Promise<Presentation> {
    return this.transaction(async (db) => {
      await currentPortalSession(db, session)
      await db
        .update(appPresentations)
        .set({ revokedAt: sql`statement_timestamp()` })
        .where(
          and(
            eq(appPresentations.id, id),
            eq(appPresentations.recipientUserId, session.userId),
            isNull(appPresentations.revokedAt),
          ),
        )
      const [row] = await db
        .select({ presentation: appPresentations, name: appOrganizations.name })
        .from(appPresentations)
        .leftJoin(
          appOrganizations,
          eq(appOrganizations.id, appPresentations.verifierOrganizationId),
        )
        .where(
          and(eq(appPresentations.id, id), eq(appPresentations.recipientUserId, session.userId)),
        )
      if (!row) throw new RecipientError(404, 'RECIPIENT_PRESENTATION_NOT_FOUND')
      return presentationDto(row.presentation, row.name)
    })
  }
}
