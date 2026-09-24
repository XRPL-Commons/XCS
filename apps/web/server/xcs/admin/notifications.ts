import { randomUUID } from 'node:crypto'
import type { DatabaseClient } from '../../lib/db/index.js'
import nodemailer from 'nodemailer'

const SMTP_DEADLINE_MS = 60_000
const STALE_CLAIM_SECONDS = 300
const SENDER = 'notifications@xcs.test'

export interface ClaimedNotification {
  id: string
  attemptId: string
  decisionId: string
  recipientEmail: string
  organizationName: string
  role: string
  status: string
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

export interface NotificationMessage {
  from: { name: string; address: string }
  to: { name: string; address: string }
  envelope: { from: string; to: string[] }
  messageId: string
  subject: string
  text: string
}

export interface NotificationTransport {
  sendMail(message: NotificationMessage): Promise<{ accepted: unknown[]; rejected: unknown[] }>
  close(): void
}

export function isNotificationEmail(email: unknown): email is string {
  // A single plain mailbox only: provider claims must never create extra recipients.
  return (
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(email)
  )
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
        d.role, d.after_status, o.name AS organization_name
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

export function createNotificationMessage(notification: ClaimedNotification): NotificationMessage {
  const statuses: Record<string, [string, string]> = {
    approved: ['approved', 'approuvé'],
    rejected: ['rejected', 'refusé'],
    suspended: ['suspended', 'suspendu'],
  }
  const [english, french] = statuses[notification.status] ?? [
    notification.status,
    notification.status,
  ]
  return {
    from: { name: 'XCS', address: SENDER },
    to: { name: '', address: notification.recipientEmail },
    envelope: { from: SENDER, to: [notification.recipientEmail] },
    messageId: `<admin-decision-${notification.decisionId}@xcs.test>`,
    subject: 'XCS — Access decision / Décision concernant votre accès',
    // No profile, document, wallet, private claim, or internal moderation reason is sent.
    text: [
      `The ${notification.role} access for ${notification.organizationName} is now ${english}.`,
      `Decision reference: ${notification.decisionId}`,
      '',
      `L’accès ${notification.role} de ${notification.organizationName} est maintenant ${french}.`,
      `Référence de la décision : ${notification.decisionId}`,
    ].join('\n'),
  }
}

export function classifySmtpFailure(error: unknown): 'failed' | 'uncertain' {
  if (!error || typeof error !== 'object') return 'uncertain'
  const details = error as {
    command?: unknown
    responseCode?: unknown
    syscall?: unknown
    code?: unknown
  }
  // Nodemailer labels socket failures CONN even after DATA was transmitted.
  // Only DNS or an actual connect() failure proves that no message was accepted.
  if (details.command === 'CONN' && (details.syscall === 'connect' || details.code === 'EDNS'))
    return 'failed'
  // A negative SMTP reply is definitive, including a rejection after DATA.
  if (
    typeof details.responseCode === 'number' &&
    details.responseCode >= 400 &&
    details.responseCode <= 599 &&
    typeof details.command === 'string' &&
    /^(EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO|DATA)$/i.test(details.command)
  )
    return 'failed'
  if (
    typeof details.command === 'string' &&
    /^(EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO)$/i.test(details.command)
  )
    return 'failed'
  // A reset/timeout during DATA may have followed acceptance by the server.
  return 'uncertain'
}

export async function processNextNotification(
  repository: NotificationRepository,
  transport: NotificationTransport,
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
      transport.sendMail(createNotificationMessage(notification)),
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

export function createLocalSmtpTransport(
  environment: Record<string, string | undefined>,
): NotificationTransport {
  const host = environment.XCS_SMTP_HOST ?? '127.0.0.1'
  if (!['127.0.0.1', 'localhost', 'mailpit'].includes(host)) {
    throw new Error('XCS_SMTP_HOST must select local Mailpit')
  }
  const configuredPort = environment.XCS_SMTP_PORT ?? '1025'
  const port = Number(configuredPort)
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('XCS_SMTP_PORT must be a valid port')
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    name: 'xcs.test',
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    dnsTimeout: 10_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
}
