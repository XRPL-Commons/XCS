import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '../../lib/db/index.js'
import {
  classifySmtpFailure,
  DEFAULT_NOTIFICATION_SENDER,
  isNotificationEmail,
  type NotificationMessage,
  type NotificationSender,
  type NotificationTransport,
} from '../notifications/smtp'

export {
  classifySmtpFailure,
  createSmtpDelivery,
  createSmtpTransport,
  isNotificationEmail,
  loadSmtpConfiguration,
} from '../notifications/smtp'
export type {
  NotificationMessage,
  NotificationSender,
  NotificationTransport,
  SmtpConfiguration,
} from '../notifications/smtp'

const SMTP_DEADLINE_MS = 60_000
const STALE_CLAIM_SECONDS = 300

export interface ClaimedNotification {
  id: string
  attemptId: string
  decisionId: string
  recipientEmail: string
  organizationName: string
  role: string
  status: string
  reason: string | null
}

export type NotificationOutcome = 'idle' | 'sent' | 'failed' | 'blocked' | 'uncertain'
export type ClaimResult =
  { kind: 'idle' | 'blocked' } | { kind: 'claimed'; notification: ClaimedNotification }

export interface NotificationRepository {
  recoverStale(): Promise<void>
  claim(): Promise<ClaimResult>
  finish(
    notification: ClaimedNotification,
    outcome: 'sent' | 'failed' | 'uncertain',
    errorCode: string | null,
  ): Promise<void>
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly client: DatabaseClient) {}

  async recoverStale(): Promise<void> {
    // The previous process may have delivered before losing its acknowledgement.
    // Never automatically send these claims again, even after a worker restart.
    await this.client.sql`UPDATE app_admin_notifications
      SET status = 'uncertain', error_code = 'WORKER_INTERRUPTED'
      WHERE status = 'sending' AND claimed_at < statement_timestamp() - ${STALE_CLAIM_SECONDS} * interval '1 second'`
  }

  async claim(): Promise<ClaimResult> {
    const result = await this.client.sql.begin(async (sql): Promise<ClaimResult> => {
      const [row] = await sql`SELECT n.id, n.decision_id, n.recipient_email,
        u.email AS current_email, u.email_verified_at, u.status AS user_status,
        d.role, d.after_status, d.reason, o.name AS organization_name
        FROM app_admin_notifications n
        JOIN app_users u ON u.id = n.recipient_user_id
        JOIN app_admin_decisions d ON d.id = n.decision_id
        JOIN app_organizations o ON o.id = d.organization_id
        WHERE n.status = 'pending' ORDER BY n.created_at, n.id
        LIMIT 1 FOR UPDATE OF n SKIP LOCKED`
      if (!row) return { kind: 'idle' }
      if (
        row.user_status !== 'active' ||
        !row.email_verified_at ||
        !isNotificationEmail(row.recipient_email) ||
        row.current_email !== row.recipient_email
      ) {
        await sql`UPDATE app_admin_notifications SET status = 'blocked', error_code = 'RECIPIENT_UNAVAILABLE'
          WHERE id = ${row.id}`
        return { kind: 'blocked' }
      }
      const attemptId = randomUUID()
      await sql`UPDATE app_admin_notifications SET status = 'sending', attempts = attempts + 1,
        attempt_id = ${attemptId}, claimed_at = statement_timestamp(), error_code = NULL
        WHERE id = ${row.id}`
      return {
        kind: 'claimed',
        notification: {
          id: row.id,
          attemptId,
          decisionId: row.decision_id,
          recipientEmail: row.recipient_email,
          organizationName: row.organization_name,
          role: row.role,
          status: row.after_status,
          reason: row.reason,
        },
      }
    })
    return result as ClaimResult
  }

  async finish(
    notification: ClaimedNotification,
    outcome: 'sent' | 'failed' | 'uncertain',
    errorCode: string | null,
  ): Promise<void> {
    await this.client
      .sql`UPDATE app_admin_notifications SET status = ${outcome}, error_code = ${errorCode},
      sent_at = CASE WHEN ${outcome} = 'sent' THEN statement_timestamp() ELSE NULL END
      WHERE id = ${notification.id} AND attempt_id = ${notification.attemptId} AND status = 'sending'`
  }
}

export function createNotificationMessage(
  notification: ClaimedNotification,
  sender: NotificationSender = DEFAULT_NOTIFICATION_SENDER,
  portalOrigin?: string,
): NotificationMessage {
  const statuses: Record<string, [string, string]> = {
    approved: ['approved', 'approuvé'],
    rejected: ['rejected', 'refusé'],
    suspended: ['suspended', 'suspendu'],
  }
  const [english, french] = statuses[notification.status] ?? [
    notification.status,
    notification.status,
  ]
  const destination = portalOrigin
    ? `${new URL(portalOrigin).origin}/${notification.role === 'issuer' ? 'issuer' : 'verifier'}`
    : undefined
  const reason = notification.reason?.trim()
  const escapeHtml = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    )
  const text = [
    `The ${notification.role} access for ${notification.organizationName} is now ${english}.`,
    ...(reason ? [`Reason: ${reason}`] : []),
    ...(destination ? [`Open your space: ${destination}`] : []),
    '',
    `L’accès ${notification.role} de ${notification.organizationName} est maintenant ${french}.`,
    ...(reason ? [`Motif : ${reason}`] : []),
    ...(destination ? [`Ouvrir votre espace : ${destination}`] : []),
  ]
  return {
    from: { name: sender.name, address: sender.address },
    to: { name: '', address: notification.recipientEmail },
    envelope: { from: sender.envelopeFrom, to: [notification.recipientEmail] },
    messageId: `<admin-decision-${notification.decisionId}@${sender.messageIdDomain}>`,
    subject: 'XCS — Access decision / Décision concernant votre accès',
    // No profile, document, wallet, private claim, token, or protocol identifier is sent.
    text: text.join('\n'),
    ...(destination
      ? {
          html: [
            `<p>The ${escapeHtml(notification.role)} access for <strong>${escapeHtml(notification.organizationName)}</strong> is now ${escapeHtml(english)}.<br>`,
            `L’accès ${escapeHtml(notification.role)} de <strong>${escapeHtml(notification.organizationName)}</strong> est maintenant ${escapeHtml(french)}.</p>`,
            reason ? `<p>Reason / Motif: ${escapeHtml(reason).replace(/\n/g, '<br>')}</p>` : '',
            `<p><a href="${escapeHtml(destination)}">Open your space / Ouvrir votre espace</a></p>`,
          ].join(''),
        }
      : {}),
  }
}

export async function processNextNotification(
  repository: NotificationRepository,
  transport: NotificationTransport,
  sender?: NotificationSender,
  portalOrigin?: string,
): Promise<NotificationOutcome> {
  await repository.recoverStale()
  const result = await repository.claim()
  if (result.kind !== 'claimed') return result.kind
  const notification = result.notification
  let outcome: 'sent' | 'failed' | 'uncertain'
  let errorCode: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const info = await Promise.race([
      transport.sendMail(createNotificationMessage(notification, sender, portalOrigin)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SMTP_DEADLINE')), SMTP_DEADLINE_MS)
      }),
    ])
    outcome = info.accepted.length === 1 && info.rejected.length === 0 ? 'sent' : 'uncertain'
    if (outcome === 'uncertain') errorCode = 'SMTP_ACCEPTANCE_UNCERTAIN'
  } catch (error) {
    outcome = classifySmtpFailure(error)
    // Persist a fixed code only: SMTP errors can contain addresses and message content.
    errorCode = outcome === 'failed' ? 'SMTP_REJECTED' : 'SMTP_ACCEPTANCE_UNCERTAIN'
  } finally {
    if (timer) clearTimeout(timer)
  }
  // A database failure here must leave the claim sending, later becoming uncertain.
  // It must not be mistaken for a definitive SMTP failure and offered for retry.
  await repository.finish(notification, outcome, errorCode)
  return outcome
}
