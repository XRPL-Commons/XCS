import { isIP } from 'node:net'
import nodemailer from 'nodemailer'

export interface NotificationMessage {
  from: { name: string; address: string }
  to: { name: string; address: string }
  envelope: { from: string; to: string[] }
  messageId: string
  subject: string
  text: string
  html?: string
}

export interface NotificationTransport {
  sendMail(message: NotificationMessage): Promise<{ accepted: unknown[]; rejected: unknown[] }>
  close(): void
}

export interface NotificationSender {
  name: string
  address: string
  envelopeFrom: string
  messageIdDomain: string
}

export interface SmtpConfiguration {
  host: string
  port: number
  secure: boolean
  requireTls: boolean
  ignoreTls: boolean
  username?: string
  password?: string
  sender: NotificationSender
}

const LOCAL_SMTP_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', 'mailpit'])
export const DEFAULT_NOTIFICATION_SENDER: NotificationSender = Object.freeze({
  name: 'XCS',
  address: 'notifications@xcs.test',
  envelopeFrom: 'notifications@xcs.test',
  messageIdDomain: 'xcs.test',
})

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function isHostname(value: string): boolean {
  if (isIP(value)) return true
  if (value.length < 1 || value.length > 253 || value.endsWith('.')) return false
  return value
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
}

export function isNotificationEmail(email: unknown): email is string {
  if (typeof email !== 'string' || email.length > 254) return false
  const separator = email.lastIndexOf('@')
  if (separator < 1 || separator === email.length - 1) return false
  const local = email.slice(0, separator)
  const domain = email.slice(separator + 1)
  return (
    local.length <= 64 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    isHostname(domain)
  )
}

function readOptional(
  environment: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = environment[name]
  return value === undefined ? undefined : value
}

function loadSender(
  environment: Record<string, string | undefined>,
  localTransport: boolean,
): NotificationSender {
  const configuredAddress = readOptional(environment, 'XCS_SMTP_FROM_ADDRESS')
  if (!localTransport && configuredAddress === undefined)
    throw new Error('XCS_SMTP_FROM_ADDRESS is required for external SMTP')
  const address = configuredAddress ?? DEFAULT_NOTIFICATION_SENDER.address
  if (!isNotificationEmail(address))
    throw new Error('XCS_SMTP_FROM_ADDRESS must be a valid mailbox')

  const name = readOptional(environment, 'XCS_SMTP_FROM_NAME') ?? DEFAULT_NOTIFICATION_SENDER.name
  if (name.length < 1 || name.length > 100 || hasControlCharacters(name))
    throw new Error('XCS_SMTP_FROM_NAME must be a valid display name')

  const envelopeFrom = readOptional(environment, 'XCS_SMTP_ENVELOPE_FROM') ?? address
  if (!isNotificationEmail(envelopeFrom))
    throw new Error('XCS_SMTP_ENVELOPE_FROM must be a valid mailbox')

  return {
    name,
    address,
    envelopeFrom,
    messageIdDomain: address.slice(address.lastIndexOf('@') + 1).toLowerCase(),
  }
}

export function loadSmtpConfiguration(
  environment: Record<string, string | undefined>,
): SmtpConfiguration {
  const host = environment.XCS_SMTP_HOST ?? '127.0.0.1'
  if (!isHostname(host)) throw new Error('XCS_SMTP_HOST must be a valid hostname or IP address')
  const localTransport = LOCAL_SMTP_HOSTS.has(host.toLowerCase())

  const configuredPort = environment.XCS_SMTP_PORT ?? '1025'
  const port = Number(configuredPort)
  if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('XCS_SMTP_PORT must be a valid port')

  const tlsMode = environment.XCS_SMTP_TLS_MODE ?? (localTransport ? 'disabled' : '')
  if (!['disabled', 'starttls', 'tls'].includes(tlsMode))
    throw new Error('XCS_SMTP_TLS_MODE must be disabled, starttls, or tls')
  if (!localTransport && tlsMode === 'disabled')
    throw new Error('XCS_SMTP_TLS_MODE must enable TLS for external SMTP')

  const username = readOptional(environment, 'XCS_SMTP_USERNAME')
  const password = readOptional(environment, 'XCS_SMTP_PASSWORD')
  if ((username === undefined) !== (password === undefined))
    throw new Error('XCS_SMTP_USERNAME and XCS_SMTP_PASSWORD must be configured together')
  if (
    username !== undefined &&
    (username.length < 1 || username.length > 512 || hasControlCharacters(username))
  )
    throw new Error('XCS_SMTP_USERNAME is invalid')
  if (
    password !== undefined &&
    (password.length < 1 || password.length > 16_384 || hasControlCharacters(password))
  )
    throw new Error('XCS_SMTP_PASSWORD is invalid')

  return {
    host,
    port,
    secure: tlsMode === 'tls',
    requireTls: tlsMode === 'starttls',
    ignoreTls: tlsMode === 'disabled',
    ...(username === undefined ? {} : { username, password }),
    sender: loadSender(environment, localTransport),
  }
}

export function createSmtpTransport(configuration: SmtpConfiguration): NotificationTransport {
  return nodemailer.createTransport({
    host: configuration.host,
    port: configuration.port,
    secure: configuration.secure,
    requireTLS: configuration.requireTls,
    ignoreTLS: configuration.ignoreTls,
    ...(configuration.username === undefined
      ? {}
      : { auth: { user: configuration.username, pass: configuration.password } }),
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

export function createSmtpDelivery(environment: Record<string, string | undefined>): {
  transport: NotificationTransport
  sender: NotificationSender
} {
  const configuration = loadSmtpConfiguration(environment)
  return { transport: createSmtpTransport(configuration), sender: configuration.sender }
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
