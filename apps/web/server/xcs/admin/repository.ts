import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '../../lib/db/index.js'
import type { Session } from '../auth/types'
import {
  AdminError,
  requestHash,
  transition,
  verifiedEmail,
  type ApplicationRole,
  type DecisionInput,
} from './domain'

export class AdminRepository {
  constructor(private readonly client: DatabaseClient) {}

  async list(page: number, filter?: ApplicationRole, verifiers = false) {
    const sql = this.client.sql
    const items = await sql`SELECT a.organization_id, a.role, a.status, a.revision, a.submitted_at,
      a.reviewed_at, a.review_reason, o.name FROM app_organization_applications a
      JOIN app_organizations o ON o.id = a.organization_id
      WHERE (${verifiers} AND a.role = 'verifier' AND a.status IN ('approved','suspended'))
        OR (NOT ${verifiers} AND a.status = 'pending' AND (${filter ?? null}::text IS NULL OR a.role = ${filter ?? null}))
      ORDER BY a.submitted_at, a.organization_id, a.role LIMIT 20 OFFSET ${(page - 1) * 20}`
    const [count] = await sql`SELECT count(*)::int AS total FROM app_organization_applications a
      WHERE (${verifiers} AND a.role = 'verifier' AND a.status IN ('approved','suspended'))
        OR (NOT ${verifiers} AND a.status = 'pending' AND (${filter ?? null}::text IS NULL OR a.role = ${filter ?? null}))`
    const counts =
      await sql`SELECT role, count(*)::int AS count FROM app_organization_applications WHERE status='pending' GROUP BY role`
    return {
      items,
      total: count!.total,
      page,
      pageSize: 20,
      counts: {
        issuer: counts.find((r) => r.role === 'issuer')?.count ?? 0,
        verifier: counts.find((r) => r.role === 'verifier')?.count ?? 0,
      },
    }
  }

  async detail(id: string, role: ApplicationRole) {
    const sql = this.client.sql
    const [application] =
      await sql`SELECT a.organization_id, a.role, a.status, a.revision, a.submitted_at,
      a.reviewed_at, a.review_reason, a.website, a.contact, a.jurisdiction, a.description, a.purpose,
      o.name, o.responsible_user_id, u.display_name AS responsible_name, u.email AS responsible_email
      FROM app_organization_applications a JOIN app_organizations o ON o.id=a.organization_id
      JOIN app_users u ON u.id=o.responsible_user_id WHERE a.organization_id=${id} AND a.role=${role}`
    if (!application) throw new AdminError(404, 'ADMIN_APPLICATION_NOT_FOUND')
    const wallets =
      await sql`SELECT address, network_id, verified_at FROM app_wallets WHERE user_id=${application.responsible_user_id} AND revoked_at IS NULL ORDER BY verified_at, id`
    const documents =
      await sql`SELECT id, mime_type, byte_length FROM app_documents WHERE organization_id=${id} AND application_role=${role} ORDER BY created_at,id`
    const history = await this.historyRows(1, id, role)
    return { application, wallets, documents, history }
  }

  private async historyRows(page: number, id?: string, role?: ApplicationRole) {
    return this.client.sql`SELECT d.id, d.organization_id, d.role, o.name AS organization_name,
      u.display_name AS actor_name, d.actor_id, d.action, d.before_status, d.after_status,
      d.revision, d.reason, d.created_at, n.id AS notification_id, n.status AS notification_status
      FROM app_admin_decisions d JOIN app_organizations o ON o.id=d.organization_id
      JOIN app_users u ON u.id=d.actor_id LEFT JOIN app_admin_notifications n ON n.decision_id=d.id
      WHERE (${id ?? null}::uuid IS NULL OR d.organization_id=${id ?? null}) AND (${role ?? null}::text IS NULL OR d.role=${role ?? null})
      ORDER BY d.created_at DESC, d.id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`
  }

  async history(page: number) {
    const [count] = await this.client.sql`SELECT count(*)::int AS total FROM app_admin_decisions`
    return { items: await this.historyRows(page), total: count!.total, page, pageSize: 20 }
  }

  async decide(session: Session, id: string, role: ApplicationRole, input: DecisionInput) {
    const hash = requestHash(id, role, input)
    return this.client.sql.begin(async (sql) => {
      // Serialize reuse of an actor's key even across different applications.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${session.userId + ':' + input.idempotencyKey},0))`
      const [authorized] =
        await sql`SELECT s.id FROM app_sessions s JOIN app_users u ON u.id=s.user_id
        JOIN app_user_roles r ON r.user_id=u.id AND r.role='admin' AND r.revoked_at IS NULL
        WHERE s.id=${session.id} AND s.token_hash=${session.tokenHash} AND s.user_id=${session.userId}
        AND u.status='active' AND s.expires_at>statement_timestamp() AND s.absolute_expires_at>statement_timestamp()`
      if (!authorized) throw new AdminError(403, 'ADMIN_ACCESS_REVOKED')
      const [previous] =
        await sql`SELECT id, before_status, after_status, reason, revision, created_at, request_hash FROM app_admin_decisions WHERE actor_id=${session.userId} AND idempotency_key=${input.idempotencyKey}`
      if (previous) {
        if (previous.request_hash !== hash) throw new AdminError(409, 'ADMIN_IDEMPOTENCY_MISMATCH')
        const { request_hash: _hash, ...decision } = previous
        return { decision, replayed: true }
      }
      const [application] =
        await sql`SELECT status, revision, reviewed_at, review_reason FROM app_organization_applications WHERE organization_id=${id} AND role=${role} FOR UPDATE`
      if (!application) throw new AdminError(404, 'ADMIN_APPLICATION_NOT_FOUND')
      if (application.revision !== input.revision)
        throw new AdminError(409, 'ADMIN_CONFLICT', application)
      const after = transition(application.status, role, input.action)
      const [responsible] =
        await sql`SELECT u.id,u.email,u.email_verified_at FROM app_organizations o JOIN app_users u ON u.id=o.responsible_user_id WHERE o.id=${id} AND o.status='active' AND u.status='active'`
      if (!responsible) throw new AdminError(409, 'ADMIN_ORGANIZATION_INACTIVE')
      const email = verifiedEmail(responsible.email, responsible.email_verified_at)
      const [decision] = await sql`INSERT INTO app_admin_decisions
        (id,organization_id,role,actor_id,action,before_status,after_status,reason,revision,idempotency_key,request_hash)
        VALUES (${randomUUID()},${id},${role},${session.userId},${input.action},${application.status},${after},${input.reason || null},${input.revision + 1},${input.idempotencyKey},${hash})
        RETURNING id,before_status,after_status,reason,revision,created_at`
      await sql`UPDATE app_organization_applications SET status=${after},revision=revision+1,reviewed_by=${session.userId},reviewed_at=statement_timestamp(),review_reason=${input.reason || null} WHERE organization_id=${id} AND role=${role}`
      await sql`INSERT INTO app_admin_notifications(id,decision_id,recipient_user_id,recipient_email,status,error_code)
        VALUES (${randomUUID()},${decision!.id},${responsible.id},${email},${email ? 'pending' : 'blocked'},${email ? null : 'VERIFIED_EMAIL_REQUIRED'})`
      return { decision, replayed: false }
    })
  }

  async document(id: string) {
    const [document] = await this.client
      .sql`SELECT id,storage_key,mime_type,byte_length,sha256 FROM app_documents WHERE id=${id}`
    if (!document) throw new AdminError(404, 'ADMIN_DOCUMENT_NOT_FOUND')
    return document as {
      id: string
      storage_key: string
      mime_type: string
      byte_length: number
      sha256: string
    }
  }

  async retryNotification(id: string) {
    return this.client.sql.begin(async (sql) => {
      const [notification] =
        await sql`SELECT id,status,recipient_user_id FROM app_admin_notifications WHERE id=${id} FOR UPDATE`
      if (!notification) throw new AdminError(404, 'ADMIN_NOTIFICATION_NOT_FOUND')
      if (!['failed', 'blocked'].includes(notification.status))
        throw new AdminError(409, 'ADMIN_NOTIFICATION_NOT_RETRYABLE')
      const [user] =
        await sql`SELECT email,email_verified_at FROM app_users WHERE id=${notification.recipient_user_id} AND status='active'`
      const email = verifiedEmail(user?.email, user?.email_verified_at)
      if (!email) throw new AdminError(409, 'ADMIN_VERIFIED_EMAIL_REQUIRED')
      await sql`UPDATE app_admin_notifications SET status='pending',recipient_email=${email},attempt_id=NULL,claimed_at=NULL,error_code=NULL WHERE id=${id}`
      return { status: 'pending' }
    })
  }
}
