import {
  classifySmtpFailure,
  DEFAULT_NOTIFICATION_SENDER,
  isNotificationEmail,
  type NotificationMessage,
  type NotificationSender,
  type NotificationTransport,
} from '../notifications/smtp'

export interface IssuerNotification {
  id: string
  kind: 'invitation' | 'issued' | 'revoked'
  recipientEmail: string
  organizationName: string
  claimUrl?: string
  schemaName?: string
  expiresAt?: string
  message?: string | null
}

export interface IssuerNotificationResult {
  status: 'sent' | 'failed' | 'uncertain'
  errorCode: string | null
}

const SMTP_DEADLINE_MS = 60_000

function hasControlCharacters(value: string, allowWhitespace = false): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || code === 127
  })
}

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

export function createIssuerNotificationMessage(
  input: IssuerNotification,
  sender: NotificationSender = DEFAULT_NOTIFICATION_SENDER,
): NotificationMessage {
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
        hasControlCharacters(input.message, true))) ||
    (input.schemaName != null &&
      (input.schemaName.length < 1 ||
        input.schemaName.length > 200 ||
        hasControlCharacters(input.schemaName)))
  )
    throw new Error('ISSUER_NOTIFICATION_INVALID')
  let subject: string
  let text: string[]
  let htmlBody: string | undefined
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
    if (!input.schemaName || !input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt)))
      throw new Error('ISSUER_NOTIFICATION_INVALID')
    const expiration = new Date(input.expiresAt).toISOString()
    subject = 'XCS — Credential invitation / Invitation à recevoir une attestation'
    text = [
      `${input.organizationName} invites you to receive a credential.`,
      `Attestation: ${input.schemaName}`,
      `Link expires: ${expiration}`,
      `${input.organizationName} vous invite à recevoir une attestation.`,
      `Attestation : ${input.schemaName}`,
      `Expiration du lien : ${expiration}`,
      '',
      'Open my invitation / Ouvrir mon invitation:',
      url.href,
      '',
      'This link is personal. Do not forward it. XCS will never ask for a recovery phrase or private key.',
      'Ce lien est personnel. Ne le transférez pas. XCS ne demandera jamais de phrase de récupération ni de clé privée.',
    ]
    if (input.message) text.push('', input.message)
    htmlBody = [
      `<p><strong>${html(input.organizationName)}</strong> invites you to receive / vous invite à recevoir :</p>`,
      `<p>${html(input.schemaName)}</p>`,
      `<p>Expires / Expire : ${html(expiration)}</p>`,
      `<p><a href="${html(url.href)}">Open my invitation / Ouvrir mon invitation</a></p>`,
      '<p>This link is personal; do not forward it. XCS will never ask for a recovery phrase or private key.<br>Ce lien est personnel ; ne le transférez pas. XCS ne demandera jamais de phrase de récupération ni de clé privée.</p>',
      input.message ? `<p>${html(input.message).replace(/\n/g, '<br>')}</p>` : '',
    ].join('')
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
    from: { name: sender.name, address: sender.address },
    to: { name: '', address: input.recipientEmail },
    envelope: { from: sender.envelopeFrom, to: [input.recipientEmail] },
    messageId: `<issuer-${input.id}@${sender.messageIdDomain}>`,
    subject,
    text: text.join('\n'),
    ...(htmlBody ? { html: htmlBody } : {}),
  }
}

/** Call exactly once after claiming a delivery in PostgreSQL. Never retries SMTP. */
export async function sendIssuerNotification(
  transport: NotificationTransport,
  input: IssuerNotification,
  sender?: NotificationSender,
): Promise<IssuerNotificationResult> {
  let message: NotificationMessage
  try {
    message = createIssuerNotificationMessage(input, sender)
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
