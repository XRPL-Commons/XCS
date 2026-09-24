import { validatePublicFields } from '../../lib/db/index.js'
import { isNotificationEmail } from '../admin/notifications'

export interface IssuerOrganization {
  id: string
  name: string
  status: 'active' | 'suspended' | 'closed'
  applicationStatus: 'pending' | 'approved' | 'rejected' | 'suspended'
  reviewReason: string | null
  revision: number
}
export interface IssuerSchema {
  profileId: string
  schemaUid: string
  displayName: string | null
  category: string | null
  name: string | null
  publisher: string | null
  registrationTransactionHash: string
}
export interface IssuerInvite {
  id: string
  organizationId: string
  profileId: string
  schemaUid: string
  email: string | null
  createdAt: string
  expiresAt: string
  claimedBy: string | null
  claimedAt: string | null
  revokedAt: string | null
  deliveryStatus: 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled' | null
  deliveryError: string | null
  recipientStatus?: 'invited' | 'wallet_required' | 'ready' | 'issued' | 'unavailable'
  recipientDisplayName?: string | null
  recipientWalletVerifiedAt?: string | null
}
export interface IssuerCredential {
  profileId: string
  generationId: string
  schemaUid: string
  organizationId: string
  inviteId: string | null
  recipientUserId: string
  issuerAddress: string
  subjectAddress: string
  visibility: 'public' | 'private'
  publicFields: string[]
  payloadId: string | null
  creationTransactionHash: string
  createdAt: string
  status: {
    accepted: boolean | null
    expiration: number | null
    deletedLedgerIndex: number | null
    deletionCause: string | null
  }
}
export interface IssuerWorkspace {
  organizations: IssuerOrganization[]
  selectedOrganizationId: string | null
  schemas: IssuerSchema[]
  invites: IssuerInvite[]
  credentials: IssuerCredential[]
}

export class IssuerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code)
  }
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
  return value as Record<string, unknown>
}
export function text(value: unknown, max: number, required = true): string {
  if (value === undefined && !required) return ''
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim()) ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
  )
    throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
  return value.trim()
}
export function uuid(value: unknown): string {
  const id = text(value, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
  return id.toLowerCase()
}
export function hash(value: unknown): string {
  const result = text(value, 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(result)) throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
  return result
}
export function email(value: unknown): string {
  if (!isNotificationEmail(value)) throw new IssuerError(400, 'ISSUER_EMAIL_INVALID')
  return value
}
export function disclosure(input: Record<string, unknown>): {
  visibility: 'public' | 'private'
  publicFields: string[]
} {
  if (
    !['public', 'private'].includes(String(input.visibility)) ||
    !Array.isArray(input.publicFields)
  )
    throw new IssuerError(400, 'ISSUER_INPUT_INVALID')
  try {
    validatePublicFields(input.publicFields)
  } catch {
    throw new IssuerError(400, 'ISSUER_PUBLIC_FIELDS_INVALID')
  }
  return {
    visibility: input.visibility as 'public' | 'private',
    publicFields: input.publicFields as string[],
  }
}
export interface ApplicationInput {
  name: string
  website: string
  contact: string
  jurisdiction: string
  description: string
  purpose: string
  documents: { mimeType: string; base64: string }[]
}
export function applicationInput(value: unknown): ApplicationInput {
  const input = object(value, [
    'name',
    'website',
    'contact',
    'jurisdiction',
    'description',
    'purpose',
    'documents',
  ])
  const website = text(input.website, 2048)
  try {
    const url = new URL(website)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error()
  } catch {
    throw new IssuerError(400, 'ISSUER_WEBSITE_INVALID')
  }
  if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 3)
    throw new IssuerError(400, 'ISSUER_DOCUMENT_REQUIRED')
  return {
    name: text(input.name, 200),
    website,
    contact: text(input.contact, 1000),
    jurisdiction: text(input.jurisdiction, 200),
    description: text(input.description, 5000),
    purpose: text(input.purpose, 5000),
    documents: input.documents.map((value) => {
      const document = object(value, ['mimeType', 'base64'])
      return {
        mimeType: text(document.mimeType, 100),
        base64: text(document.base64, Math.ceil((5 * 1024 * 1024) / 3) * 4),
      }
    }),
  }
}
