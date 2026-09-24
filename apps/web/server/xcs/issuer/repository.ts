import { randomBytes, randomUUID } from 'node:crypto'
import {
  canonicalJson,
  createHttpsPayloadUri,
  decodeHexUtf8,
  parseCredentialPayload,
  payloadDigest,
  type SchemaFields,
} from '#xcs/core/index.js'
import {
  createAppToken,
  filterCredentialClaims,
  getCredentialAccess,
  hashAppToken,
  type Claims,
  type DatabaseClient,
} from '../../lib/db/index.js'
import type { Session } from '../auth/types'
import type { IssuerDocumentStore } from './storage'
import type { IssuerNotification, IssuerNotificationResult } from './notifications'
import { IssuerError, type ApplicationInput } from './types'
import { isNotificationEmail } from '../admin/notifications'

type Query = DatabaseClient['sql']
const iso = (value: unknown): string | null =>
  value == null ? null : new Date(String(value)).toISOString()
export interface IssuerRepositoryOptions {
  origin: string
  inviteDays: number
  documents: IssuerDocumentStore
  notify: (message: IssuerNotification) => Promise<IssuerNotificationResult>
}

export class IssuerRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly options: IssuerRepositoryOptions,
  ) {}

  private async session(sql: Query, session: Session) {
    const [current] = await sql`SELECT s.id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
      AND u.status='active' AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()`
    if (!current) throw new IssuerError(401, 'AUTH_REQUIRED')
  }

  private async organization(sql: Query, session: Session, id: string, approved = true) {
    await this.session(sql, session)
    const [org] =
      await sql`SELECT o.id,o.name,o.status,a.status AS application_status FROM app_organizations o
      JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='issuer'
      WHERE o.id=${id} AND o.responsible_user_id=${session.userId}`
    if (!org) throw new IssuerError(404, 'ISSUER_ORGANIZATION_NOT_FOUND')
    if (approved && (org.status !== 'active' || org.application_status !== 'approved'))
      throw new IssuerError(403, 'ISSUER_APPROVAL_REQUIRED')
    return org
  }

  async workspace(session: Session, selected?: string) {
    await this.session(this.client.sql, session)
    const organizations = await this.client
      .sql`SELECT o.id,o.name,o.status,a.status AS "applicationStatus",a.review_reason AS "reviewReason",a.revision
      FROM app_organizations o JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='issuer'
      WHERE o.responsible_user_id=${session.userId} ORDER BY o.created_at,o.id`
    const id = selected ?? organizations[0]?.id ?? null
    if (id && !organizations.some((org) => org.id === id))
      throw new IssuerError(404, 'ISSUER_ORGANIZATION_NOT_FOUND')
    if (!id)
      return {
        organizations,
        selectedOrganizationId: null,
        schemas: [],
        invites: [],
        credentials: [],
      }
    const schemas = await this.client
      .sql`SELECT m.profile_id AS "profileId",m.schema_uid AS "schemaUid",m.display_name AS "displayName",m.category,
      s.name,s.publisher,m.registration_transaction_hash AS "registrationTransactionHash" FROM app_schema_metadata m
      LEFT JOIN schemas s ON s.profile_id=m.profile_id AND s.schema_uid=m.schema_uid WHERE m.organization_id=${id} ORDER BY m.created_at DESC LIMIT 200`
    const invites = await this.client
      .sql`SELECT i.id,i.organization_id AS "organizationId",i.profile_id AS "profileId",i.schema_uid AS "schemaUid",
      i.delivery_email AS email,i.created_at AS "createdAt",i.expires_at AS "expiresAt",i.claimed_by AS "claimedBy",i.claimed_at AS "claimedAt",i.revoked_at AS "revokedAt",
      CASE WHEN d.status='sending' AND d.created_at<statement_timestamp()-interval '2 minutes' THEN 'uncertain' ELSE d.status END AS "deliveryStatus",d.error_code AS "deliveryError",
      recipient.display_name AS "recipientDisplayName",wallet.verified_at AS "recipientWalletVerifiedAt",
      CASE WHEN i.revoked_at IS NOT NULL OR NOT n.enabled OR n.network_id<>1
        OR (i.claimed_by IS NOT NULL AND recipient.status<>'active') THEN 'unavailable'
        WHEN m.generation_id IS NOT NULL THEN 'issued'
        WHEN i.claimed_by IS NULL THEN 'invited'
        WHEN wallet.verified_at IS NOT NULL THEN 'ready' ELSE 'wallet_required' END AS "recipientStatus"
      FROM app_invites i
      JOIN network_profiles n ON n.profile_id=i.profile_id
      LEFT JOIN app_users recipient ON recipient.id=i.claimed_by
      LEFT JOIN app_credential_metadata m ON m.invite_id=i.id
      LEFT JOIN LATERAL (SELECT max(verified_at) AS verified_at FROM app_wallets
        WHERE user_id=i.claimed_by AND network_id=n.network_id AND revoked_at IS NULL) wallet ON TRUE
      LEFT JOIN LATERAL (SELECT status,error_code,created_at FROM app_invite_deliveries WHERE invite_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1) d ON TRUE
      WHERE i.organization_id=${id} ORDER BY i.created_at DESC,i.id LIMIT 200`
    const credentials = await this.client
      .sql`SELECT m.*,g.accepted,g.expiration,g.deleted_ledger_index,g.deletion_cause
      FROM app_credential_metadata m LEFT JOIN credential_generations g ON g.profile_id=m.profile_id AND g.generation_id=m.generation_id
      WHERE m.issuer_organization_id=${id} ORDER BY m.created_at DESC LIMIT 200`
    return {
      organizations,
      selectedOrganizationId: id,
      schemas,
      invites: invites.map((row) => ({
        ...row,
        createdAt: iso(row.createdAt),
        expiresAt: iso(row.expiresAt),
        claimedAt: iso(row.claimedAt),
        revokedAt: iso(row.revokedAt),
        recipientWalletVerifiedAt: iso(row.recipientWalletVerifiedAt),
      })),
      credentials: credentials.map((row) => this.credentialDto(row)),
    }
  }

  async apply(session: Session, input: ApplicationInput, role: 'issuer' | 'verifier' = 'issuer') {
    const stored: Awaited<ReturnType<IssuerDocumentStore['write']>>[] = []
    const applicationId = randomUUID()
    let transactionStarted = false
    try {
      for (const document of input.documents)
        stored.push(await this.options.documents.write(document))
      const result = await this.client.sql.begin(async (transaction) => {
        transactionStarted = true
        const sql = transaction as unknown as Query
        await this.session(sql, session)
        // Bound accidental repeated submissions, and serialize the count with creation.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.userId + ':issuer-applications'},0))`
        const [count] =
          await sql`SELECT count(*)::int AS count FROM app_organizations WHERE responsible_user_id=${session.userId}`
        if (count!.count >= 20) throw new IssuerError(409, 'ISSUER_APPLICATION_LIMIT')
        const id = applicationId
        await sql`INSERT INTO app_organizations(id,responsible_user_id,name) VALUES (${id},${session.userId},${input.name})`
        await sql`INSERT INTO app_organization_applications(organization_id,role,website,contact,jurisdiction,description,purpose)
          VALUES (${id},${role},${input.website},${input.contact},${input.jurisdiction},${input.description},${input.purpose})`
        for (const document of stored)
          await sql`INSERT INTO app_documents(id,organization_id,application_role,storage_key,mime_type,byte_length,sha256,uploaded_by)
          VALUES (${randomUUID()},${id},${role},${document.storageKey},${document.mimeType},${document.byteLength},${document.sha256},${session.userId})`
        return { organizationId: id, status: 'pending' }
      })
      for (const document of stored) this.options.documents.release?.(document.storageKey)
      return result
    } catch (error) {
      // A connection failure after COMMIT may conceal success. Never delete files
      // until the original transaction has finished and absence is confirmed.
      let cleanup = !transactionStarted
      if (transactionStarted) {
        try {
          cleanup = await this.client.sql.begin(async (sql) => {
            // The original COMMIT can still be in flight on another connection.
            // Wait on its lock before taking the statement snapshot for this read.
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.userId + ':issuer-applications'},0))`
            const [persisted] =
              await sql`SELECT id FROM app_organizations WHERE id=${applicationId}`
            return !persisted
          })
        } catch {
          cleanup = false
        }
      }
      if (cleanup)
        await Promise.allSettled(
          stored.map((document) => this.options.documents.remove(document.storageKey)),
        )
      else for (const document of stored) this.options.documents.release?.(document.storageKey)
      throw error
    }
  }

  async registerSchema(
    session: Session,
    input: {
      organizationId: string
      profileId: string
      transactionHash: string
      displayName: string
      category: string
    },
  ) {
    return this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      await this.organization(sql, session, input.organizationId)
      const [schema] =
        await sql`SELECT s.schema_uid FROM schemas s JOIN schema_events e ON e.profile_id=s.profile_id AND e.transaction_hash=s.registration_transaction_hash
        JOIN network_profiles n ON n.profile_id=s.profile_id AND n.enabled AND n.network_id=1
        JOIN app_wallets w ON w.user_id=${session.userId} AND w.address=s.publisher AND w.network_id=n.network_id AND w.revoked_at IS NULL
        WHERE s.profile_id=${input.profileId} AND lower(s.registration_transaction_hash)=${input.transactionHash} AND e.status='accepted' AND e.schema_uid=s.schema_uid`
      if (!schema) throw new IssuerError(409, 'ISSUER_SCHEMA_NOT_VALIDATED')
      await sql`INSERT INTO app_schema_metadata(profile_id,schema_uid,organization_id,display_name,category,registration_transaction_hash)
        VALUES (${input.profileId},${schema.schema_uid},${input.organizationId},${input.displayName || null},${input.category || null},${input.transactionHash}) ON CONFLICT DO NOTHING`
      const [owner] =
        await sql`SELECT organization_id FROM app_schema_metadata WHERE profile_id=${input.profileId} AND schema_uid=${schema.schema_uid}`
      if (owner?.organization_id !== input.organizationId)
        throw new IssuerError(409, 'ISSUER_SCHEMA_OWNED')
      return {
        profileId: input.profileId,
        schemaUid: schema.schema_uid,
        organizationId: input.organizationId,
      }
    })
  }

  private async deliver(message: IssuerNotification) {
    let result: IssuerNotificationResult
    try {
      result = await this.options.notify(message)
    } catch {
      result = { status: 'uncertain', errorCode: 'SMTP_ACCEPTANCE_UNCERTAIN' }
    }
    // A database failure leaves sending, which is surfaced as uncertain; never replay automatically.
    await this.client
      .sql`UPDATE app_invite_deliveries SET status=${result.status},error_code=${result.errorCode} WHERE id=${message.id} AND status='sending'`
    return result
  }

  async invite(
    session: Session,
    input: {
      organizationId: string
      profileId: string
      schemaUid: string
      email: string
      message: string
    },
  ) {
    const secret = createAppToken(),
      id = randomUUID(),
      deliveryId = randomUUID()
    const org = await this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      const org = await this.organization(sql, session, input.organizationId)
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.organizationId + ':invites'},0))`
      const [count] =
        await sql`SELECT count(*)::int AS count FROM app_invites WHERE organization_id=${input.organizationId}`
      if (count!.count >= 2000) throw new IssuerError(409, 'ISSUER_INVITE_LIMIT')
      const [schema] =
        await sql`SELECT schema_uid FROM app_schema_metadata WHERE organization_id=${input.organizationId} AND profile_id=${input.profileId} AND schema_uid=${input.schemaUid}`
      if (!schema) throw new IssuerError(404, 'ISSUER_SCHEMA_NOT_FOUND')
      await sql`INSERT INTO app_invites(id,organization_id,profile_id,schema_uid,delivery_email,token_hash,created_by,expires_at)
        VALUES (${id},${input.organizationId},${input.profileId},${input.schemaUid},${input.email},${secret.tokenHash},${session.userId},statement_timestamp()+${this.options.inviteDays}*interval '1 day')`
      await sql`INSERT INTO app_invite_deliveries(id,invite_id,kind,recipient_email,status) VALUES (${deliveryId},${id},'invitation',${input.email},'sending')`
      return org
    })
    const delivery = await this.deliver({
      id: deliveryId,
      kind: 'invitation',
      recipientEmail: input.email,
      organizationName: org.name,
      claimUrl: `${this.options.origin}/recipient/invitations#${secret.token}`,
      message: input.message,
    })
    return { id, deliveryStatus: delivery.status }
  }

  async changeInvite(session: Session, id: string, action: 'resend' | 'revoke') {
    const secret = createAppToken(),
      deliveryId = randomUUID()
    const result = await this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      const [invite] = await sql`SELECT * FROM app_invites WHERE id=${id} FOR UPDATE`
      if (!invite) throw new IssuerError(404, 'ISSUER_INVITE_NOT_FOUND')
      const org = await this.organization(sql, session, invite.organization_id)
      if (invite.claimed_by || invite.revoked_at) throw new IssuerError(409, 'ISSUER_INVITE_FINAL')
      await sql`UPDATE app_invite_deliveries SET status='cancelled',error_code=NULL WHERE invite_id=${id} AND status='sending'`
      if (action === 'resend') {
        await sql`UPDATE app_invites SET token_hash=${secret.tokenHash},expires_at=statement_timestamp()+${this.options.inviteDays}*interval '1 day' WHERE id=${id}`
        await sql`INSERT INTO app_invite_deliveries(id,invite_id,kind,recipient_email,status) VALUES (${deliveryId},${id},'invitation',${invite.delivery_email},'sending')`
      } else
        await sql`UPDATE app_invites SET revoked_at=statement_timestamp(),token_hash=NULL WHERE id=${id}`
      return { invite, org }
    })
    if (action === 'revoke') return { id, status: 'revoked' }
    const delivery = await this.deliver({
      id: deliveryId,
      kind: 'invitation',
      recipientEmail: result.invite.delivery_email,
      organizationName: result.org.name,
      claimUrl: `${this.options.origin}/recipient/invitations#${secret.token}`,
    })
    return { id, deliveryStatus: delivery.status }
  }

  private async issuanceRows(sql: Query, session: Session, id: string) {
    const [invite] = await sql`SELECT * FROM app_invites WHERE id=${id}`
    if (!invite) throw new IssuerError(404, 'ISSUER_INVITE_NOT_FOUND')
    const org = await this.organization(sql, session, invite.organization_id)
    if (!invite.claimed_by || invite.revoked_at)
      throw new IssuerError(409, 'ISSUER_RECIPIENT_REQUIRED')
    const [recipient] =
      await sql`SELECT id,display_name FROM app_users WHERE id=${invite.claimed_by} AND status='active'`
    const [schema] =
      await sql`SELECT s.*,n.network_id FROM schemas s JOIN network_profiles n ON n.profile_id=s.profile_id
      WHERE s.profile_id=${invite.profile_id} AND s.schema_uid=${invite.schema_uid} AND n.enabled AND n.network_id=1`
    if (!recipient || !schema) throw new IssuerError(409, 'ISSUER_ISSUANCE_UNAVAILABLE')
    const wallets =
      await sql`SELECT address,network_id AS "networkId",verified_at AS "verifiedAt" FROM app_wallets WHERE user_id=${recipient.id} AND network_id=${schema.network_id} AND revoked_at IS NULL`
    const issuerWallets =
      await sql`SELECT address,network_id AS "networkId",verified_at AS "verifiedAt" FROM app_wallets WHERE user_id=${session.userId} AND network_id=${schema.network_id} AND revoked_at IS NULL`
    return { invite, org, recipient, schema, wallets, issuerWallets }
  }

  async issuance(session: Session, id: string) {
    const rows = await this.issuanceRows(this.client.sql, session, id)
    const [existing] = await this.client
      .sql`SELECT profile_id AS "profileId",generation_id AS "generationId" FROM app_credential_metadata WHERE invite_id=${id}`
    return {
      existingCredential: existing ?? null,
      invite: {
        id,
        organizationId: rows.invite.organization_id,
        profileId: rows.invite.profile_id,
        schemaUid: rows.invite.schema_uid,
        claimedBy: rows.invite.claimed_by,
        expiresAt: iso(rows.invite.expires_at),
        revokedAt: iso(rows.invite.revoked_at),
        deliveryEmail: rows.invite.delivery_email,
      },
      organization: { id: rows.org.id, name: rows.org.name },
      recipient: {
        id: rows.recipient.id,
        displayName: rows.recipient.display_name,
        wallets: rows.wallets.map((wallet) => ({
          ...wallet,
          networkId: Number(wallet.networkId),
          verifiedAt: iso(wallet.verifiedAt),
        })),
      },
      issuerWallets: rows.issuerWallets.map((wallet) => ({
        ...wallet,
        networkId: Number(wallet.networkId),
        verifiedAt: iso(wallet.verifiedAt),
      })),
      schema: {
        profileId: rows.schema.profile_id,
        schemaUid: rows.schema.schema_uid,
        name: rows.schema.name,
        publisher: rows.schema.publisher,
        definition: rows.schema.definition,
        resolvedDefinition: rows.schema.resolved_definition,
      },
    }
  }

  async preparePayload(
    session: Session,
    input: {
      inviteId: string
      canonicalPayload: string
      subjectAddress: string
      visibility: 'public' | 'private'
      publicFields: string[]
    },
  ) {
    return this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      await sql`SELECT id FROM app_invites WHERE id=${input.inviteId} FOR UPDATE`
      const rows = await this.issuanceRows(sql, session, input.inviteId)
      const [count] =
        await sql`SELECT count(*)::int AS count FROM app_issuer_payloads WHERE invite_id=${input.inviteId}`
      if (count!.count >= 20) throw new IssuerError(409, 'ISSUER_DRAFT_LIMIT')
      const [existing] =
        await sql`SELECT generation_id FROM app_credential_metadata WHERE invite_id=${input.inviteId}`
      if (existing) throw new IssuerError(409, 'ISSUER_INVITE_ALREADY_ISSUED')
      if (!rows.wallets.some((wallet) => wallet.address === input.subjectAddress))
        throw new IssuerError(409, 'ISSUER_SUBJECT_WALLET_REQUIRED')
      let parsed
      try {
        const envelope = JSON.parse(input.canonicalPayload)
        if (!rows.issuerWallets.some((wallet) => wallet.address === envelope.issuer))
          throw new Error()
        parsed = parseCredentialPayload(input.canonicalPayload, {
          issuer: envelope.issuer,
          subject: input.subjectAddress,
          schemaUid: rows.invite.schema_uid,
          fields: rows.schema.resolved_definition.fields as SchemaFields,
        })
      } catch {
        throw new IssuerError(400, 'ISSUER_PAYLOAD_INVALID')
      }
      // Validate selectors against the real envelope without exposing its other fields.
      filterCredentialClaims(parsed.claims as Claims, {
        scope: 'public',
        publicFields: input.publicFields,
      })
      const id = randomUUID(),
        digest = payloadDigest(input.canonicalPayload)
      const locator = randomBytes(9).toString('hex')
      const credentialUri = createHttpsPayloadUri(
        `${this.options.origin}/q/${locator}`,
        input.canonicalPayload,
      )
      if (Buffer.byteLength(credentialUri) > 128)
        throw new IssuerError(422, 'ISSUER_ORIGIN_TOO_LONG')
      await sql`INSERT INTO app_issuer_payloads(id,locator,invite_id,created_by,subject_address,canonical_payload,payload_digest,credential_uri,visibility,public_fields)
        VALUES (${id},${locator},${input.inviteId},${session.userId},${input.subjectAddress},${input.canonicalPayload},${digest},${credentialUri},${input.visibility},${JSON.stringify(input.publicFields)}::jsonb)`
      return { payloadId: id, credentialUri, payloadDigest: digest }
    })
  }

  async recordCredential(
    session: Session,
    input: {
      inviteId: string
      transactionHash: string
      payloadId: string
      visibility: 'public' | 'private'
      publicFields: string[]
    },
  ) {
    const recorded = await this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      await sql`SELECT id FROM app_invites WHERE id=${input.inviteId} FOR UPDATE`
      const rows = await this.issuanceRows(sql, session, input.inviteId)
      const [payload] =
        await sql`SELECT * FROM app_issuer_payloads WHERE id=${input.payloadId} AND invite_id=${input.inviteId} AND created_by=${session.userId}`
      if (
        !payload ||
        payload.visibility !== input.visibility ||
        canonicalJson(payload.public_fields) !== canonicalJson(input.publicFields)
      )
        throw new IssuerError(409, 'ISSUER_PAYLOAD_MISMATCH')
      const [event] =
        await sql`SELECT e.*,g.deleted_ledger_index FROM credential_events e JOIN credential_generations g ON g.profile_id=e.profile_id AND g.generation_id=e.generation_id
        WHERE e.profile_id=${rows.invite.profile_id} AND lower(e.transaction_hash)=${input.transactionHash} AND e.event_type='created' AND e.schema_uid=${rows.invite.schema_uid}`
      if (!event) throw new IssuerError(409, 'ISSUER_CREDENTIAL_NOT_VALIDATED')
      let uri: string
      try {
        uri = decodeHexUtf8(event.uri_hex)
      } catch {
        throw new IssuerError(409, 'ISSUER_PAYLOAD_MISMATCH')
      }
      const envelope = JSON.parse(payload.canonical_payload)
      if (
        uri !== payload.credential_uri ||
        payloadDigest(payload.canonical_payload) !== payload.payload_digest ||
        envelope.issuer !== event.issuer ||
        envelope.subject !== event.subject ||
        event.subject !== payload.subject_address ||
        !rows.issuerWallets.some((wallet) => wallet.address === event.issuer) ||
        !rows.wallets.some((wallet) => wallet.address === event.subject)
      )
        throw new IssuerError(409, 'ISSUER_CREDENTIAL_MISMATCH')
      const [existing] =
        await sql`SELECT * FROM app_credential_metadata WHERE invite_id=${input.inviteId} OR (profile_id=${event.profile_id} AND generation_id=${event.generation_id})`
      if (existing) {
        if (
          existing.invite_id !== input.inviteId ||
          existing.generation_id !== event.generation_id ||
          existing.payload_storage_key !== input.payloadId
        )
          throw new IssuerError(409, 'ISSUER_CREDENTIAL_EXISTS')
      } else
        await sql`INSERT INTO app_credential_metadata(profile_id,generation_id,schema_uid,issuer_organization_id,recipient_user_id,invite_id,issuer_address,subject_address,visibility,public_fields,payload_storage_key,payload_digest,creation_transaction_hash,creation_ledger_index)
        VALUES (${event.profile_id},${event.generation_id},${event.schema_uid},${rows.org.id},${rows.recipient.id},${input.inviteId},${event.issuer},${event.subject},${payload.visibility},${JSON.stringify(payload.public_fields)}::jsonb,${payload.id},${payload.payload_digest},${input.transactionHash},${event.ledger_index})`
      return {
        profileId: event.profile_id,
        generationId: event.generation_id,
        organizationId: rows.org.id,
        inviteId: input.inviteId,
        notification: existing
          ? null
          : await this.queueNotification(sql, input.inviteId, rows.org.name, 'issued'),
      }
    })
    const { notification, ...result } = recorded
    if (notification) await this.deliver(notification)
    return result
  }

  private async queueNotification(
    sql: Query,
    inviteId: string,
    organizationName: string,
    kind: 'issued' | 'revoked',
  ): Promise<IssuerNotification | null> {
    const [existing] =
      await sql`SELECT id FROM app_invite_deliveries WHERE invite_id=${inviteId} AND kind=${kind}`
    if (existing) return null
    const [recipient] =
      await sql`SELECT u.email,u.email_verified_at FROM app_invites i JOIN app_users u ON u.id=i.claimed_by AND u.status='active' WHERE i.id=${inviteId}`
    if (!recipient?.email_verified_at || !isNotificationEmail(recipient.email)) return null
    const id = randomUUID()
    await sql`INSERT INTO app_invite_deliveries(id,invite_id,kind,recipient_email,status) VALUES (${id},${inviteId},${kind},${recipient.email},'sending')`
    return { id, kind, organizationName, recipientEmail: recipient.email }
  }

  async refreshCredential(
    session: Session,
    profileId: string,
    generationId: string,
    transactionHash: string,
  ) {
    const notification = await this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      const [record] =
        await sql`SELECT m.*,e.deletion_cause FROM app_credential_metadata m JOIN credential_events e ON e.profile_id=m.profile_id AND e.generation_id=m.generation_id
        WHERE m.profile_id=${profileId} AND m.generation_id=${generationId} AND lower(e.transaction_hash)=${transactionHash} AND e.event_type='deleted' AND e.deletion_cause='issuer_revoked'`
      if (!record) throw new IssuerError(409, 'ISSUER_REVOCATION_NOT_VALIDATED')
      const org = await this.organization(sql, session, record.issuer_organization_id)
      const [wallet] =
        await sql`SELECT w.id FROM app_wallets w JOIN network_profiles n ON n.network_id=w.network_id WHERE n.profile_id=${profileId} AND n.enabled AND w.user_id=${session.userId} AND w.address=${record.issuer_address} AND w.revoked_at IS NULL`
      if (!wallet) throw new IssuerError(403, 'ISSUER_WALLET_REQUIRED')
      await sql`SELECT id FROM app_invites WHERE id=${record.invite_id} FOR UPDATE`
      return this.queueNotification(sql, record.invite_id, org.name, 'revoked')
    })
    if (notification) await this.deliver(notification)
    return this.credential(session, profileId, generationId)
  }

  private credentialDto(row: Record<string, unknown>) {
    return {
      profileId: row.profile_id,
      generationId: row.generation_id,
      schemaUid: row.schema_uid,
      organizationId: row.issuer_organization_id,
      inviteId: row.invite_id,
      recipientUserId: row.recipient_user_id,
      issuerAddress: row.issuer_address,
      subjectAddress: row.subject_address,
      visibility: row.visibility,
      publicFields: row.public_fields,
      payloadId: row.payload_storage_key,
      creationTransactionHash: row.creation_transaction_hash,
      createdAt: iso(row.created_at),
      status: {
        accepted: row.accepted ?? null,
        expiration: row.expiration == null ? null : Number(row.expiration),
        deletedLedgerIndex:
          row.deleted_ledger_index == null ? null : Number(row.deleted_ledger_index),
        deletionCause: row.deletion_cause ?? null,
      },
    }
  }

  async credential(session: Session, profileId: string, generationId: string) {
    const [row] = await this.client
      .sql`SELECT m.*,g.accepted,g.expiration,g.deleted_ledger_index,g.deletion_cause,s.name AS schema_name,u.display_name AS recipient_name
      FROM app_credential_metadata m LEFT JOIN credential_generations g ON g.profile_id=m.profile_id AND g.generation_id=m.generation_id
      LEFT JOIN schemas s ON s.profile_id=m.profile_id AND s.schema_uid=m.schema_uid LEFT JOIN app_users u ON u.id=m.recipient_user_id WHERE m.profile_id=${profileId} AND m.generation_id=${generationId}`
    if (!row) throw new IssuerError(404, 'ISSUER_CREDENTIAL_NOT_FOUND')
    await this.organization(this.client.sql, session, row.issuer_organization_id)
    return {
      ...this.credentialDto(row),
      schema: { name: row.schema_name },
      recipient: { id: row.recipient_user_id, displayName: row.recipient_name },
    }
  }

  async payload(session: Session | null, id: string, byLocator = false) {
    const [payload] = await this.client
      .sql`SELECT p.*,m.profile_id,m.generation_id FROM app_issuer_payloads p
      LEFT JOIN app_credential_metadata m ON m.payload_storage_key=p.id::text WHERE ${byLocator ? this.client.sql`p.locator=${id}` : this.client.sql`p.id=${id}`}`
    if (!payload) throw new IssuerError(404, 'ISSUER_PAYLOAD_NOT_FOUND')
    if (!payload.generation_id) {
      if (!session || payload.created_by !== session.userId)
        throw new IssuerError(404, 'ISSUER_PAYLOAD_NOT_FOUND')
      await this.issuanceRows(this.client.sql, session, payload.invite_id)
      return { content: payload.canonical_payload, scope: 'full' as const }
    }
    const access = await getCredentialAccess(this.client.db, {
      profileId: payload.profile_id,
      generationId: payload.generation_id,
      viewerUserId: session?.userId ?? null,
    })
    if (!access) throw new IssuerError(404, 'ISSUER_PAYLOAD_NOT_FOUND')
    if (access.scope === 'full')
      return { content: payload.canonical_payload, scope: 'full' as const }
    const envelope = JSON.parse(payload.canonical_payload)
    return {
      content: canonicalJson({ claims: filterCredentialClaims(envelope.claims, access) }),
      scope: 'public' as const,
    }
  }

  async invitation(session: Session, token: string, claim: boolean) {
    const tokenHash = hashAppToken(token)
    if (!tokenHash) throw new IssuerError(404, 'ISSUER_INVITATION_UNAVAILABLE')
    return this.client.sql.begin(async (transaction) => {
      const sql = transaction as unknown as Query
      await this.session(sql, session)
      const [invite] =
        await sql`SELECT i.id,i.organization_id,i.profile_id,i.schema_uid,i.claimed_by,i.expires_at,o.name,s.name AS schema_name
        FROM app_invites i JOIN app_organizations o ON o.id=i.organization_id AND o.status='active'
        JOIN app_organization_applications a ON a.organization_id=o.id AND a.role='issuer' AND a.status='approved'
        JOIN schemas s ON s.profile_id=i.profile_id AND s.schema_uid=i.schema_uid
        WHERE i.token_hash=${tokenHash} AND i.revoked_at IS NULL AND i.expires_at>statement_timestamp() FOR UPDATE OF i`
      if (!invite || (invite.claimed_by && invite.claimed_by !== session.userId))
        throw new IssuerError(404, 'ISSUER_INVITATION_UNAVAILABLE')
      if (claim && !invite.claimed_by) {
        const [updated] =
          await sql`UPDATE app_invites SET claimed_by=${session.userId},claimed_at=statement_timestamp()
          WHERE id=${invite.id} AND claimed_by IS NULL AND revoked_at IS NULL AND expires_at>statement_timestamp() RETURNING id`
        if (!updated) throw new IssuerError(409, 'ISSUER_INVITATION_UNAVAILABLE')
      }
      return {
        id: invite.id,
        organizationId: invite.organization_id,
        organizationName: invite.name,
        profileId: invite.profile_id,
        schemaUid: invite.schema_uid,
        schemaName: invite.schema_name,
        expiresAt: iso(invite.expires_at),
        claimed: claim || Boolean(invite.claimed_by),
      }
    })
  }
}
