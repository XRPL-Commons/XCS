import {
  classifySmtpFailure,
  isNotificationEmail,
  type NotificationMessage,
  type NotificationTransport,
} from '../admin/notifications'

export { createLocalSmtpTransport } from '../admin/notifications'

export interface IssuerNotification {
  id: string
  kind: 'invitation' | 'issued' | 'revoked'
  recipientEmail: string
  organizationName: string
  claimUrl?: string
  message?: string | null
}

export interface IssuerNotificationResult {
  status: 'sent' | 'failed' | 'uncertain'
  errorCode: string | null
}

const SENDER = 'notifications@xcs.test'
const SMTP_DEADLINE_MS = 60_000

function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || code === 127
  })
}

export function createIssuerNotificationMessage(input: IssuerNotification): NotificationMessage {
  if (
    !isNotificationEmail(input.recipientEmail) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
    typeof input.organizationName !== 'string' ||
    input.organizationName.length < 1 ||
    input.organizationName.length > 200 ||
    hasControlCharacters(input.organizationName) ||
    (input.message != null &&
      (typeof input.message !== 'string' ||
        input.message.length > 2000 ||
        hasControlCharacters(input.message, true)))
  )
    throw new Error('ISSUER_NOTIFICATION_INVALID')
  let subject: string
  let text: string[]
  if (input.kind === 'invitation') {
    let url: URL
    try {
      url = new URL(input.claimUrl ?? '')
    } catch {
      throw new Error('ISSUER_NOTIFICATION_INVALID')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/recipient/invitations' ||
      url.search ||
      !/^#[A-Za-z0-9_-]{43}$/.test(url.hash) ||
      (input.claimUrl?.length ?? 0) > 4096
    )
      throw new Error('ISSUER_NOTIFICATION_INVALID')
    subject = 'XCS — Credential invitation / Invitation à recevoir une attestation'
    text = [
      `${input.organizationName} invites you to receive a credential.`,
      `${input.organizationName} vous invite à recevoir une attestation.`,
      '',
      'Personal invitation link — do not forward / Lien personnel — ne pas transférer :',
      url.href,
    ]
    if (input.message) text.push('', input.message)
  } else if (input.kind === 'issued') {
    subject = 'XCS — Credential issued / Attestation émise'
    text = [
      `${input.organizationName} has issued your credential.`,
      `${input.organizationName} a émis votre attestation.`,
      '',
      'Sign in to your XCS account to view its status.',
      'Connectez-vous à votre compte XCS pour consulter son état.',
    ]
  } else if (input.kind === 'revoked') {
    subject = 'XCS — Credential revoked / Attestation révoquée'
    text = [
      `${input.organizationName} has revoked your credential.`,
      `${input.organizationName} a révoqué votre attestation.`,
      '',
      'Sign in to your XCS account to view its status.',
      'Connectez-vous à votre compte XCS pour consulter son état.',
    ]
  } else {
    throw new Error('ISSUER_NOTIFICATION_INVALID')
  }
  return {
    from: { name: 'XCS', address: SENDER },
    to: { name: '', address: input.recipientEmail },
    envelope: { from: SENDER, to: [input.recipientEmail] },
    messageId: `<issuer-${input.id}@xcs.test>`,
    subject,
    text: text.join('\n'),
  }
}

/** Call exactly once after claiming a delivery in PostgreSQL. Never retries SMTP. */
export async function sendIssuerNotification(
  transport: NotificationTransport,
  input: IssuerNotification,
): Promise<IssuerNotificationResult> {
  let message: NotificationMessage
  try {
    message = createIssuerNotificationMessage(input)
  } catch {
    return { status: 'failed', errorCode: 'ISSUER_NOTIFICATION_INVALID' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      transport.sendMail(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SMTP_DEADLINE')), SMTP_DEADLINE_MS)
      }),
    ])
    return result.accepted.length === 1 &&
      result.accepted[0] === input.recipientEmail &&
      result.rejected.length === 0
      ? { status: 'sent', errorCode: null }
      : { status: 'uncertain', errorCode: 'SMTP_ACCEPTANCE_UNCERTAIN' }
  } catch (error) {
    const status = classifySmtpFailure(error)
    // SMTP exception text may contain the invitation URL or recipient. Never retain
    // it in the database or logs, including when the server accepted before a reset.
    return {
      status,
      errorCode: status === 'failed' ? 'SMTP_REJECTED' : 'SMTP_ACCEPTANCE_UNCERTAIN',
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
