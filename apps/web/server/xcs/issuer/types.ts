import { validatePublicFields } from '../../lib/db/index.js'
import { isNotificationEmail } from '../admin/notifications'
import {
  ApplicationError,
  parseApplicationInput,
  type ApplicationInput,
  type OrganizationApplication,
} from '../applications/domain'

export type IssuerOrganization = OrganizationApplication
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
export type { ApplicationInput }
export function applicationInput(value: unknown): ApplicationInput {
  try {
    return parseApplicationInput(value)
  } catch (error) {
    if (error instanceof ApplicationError)
      throw new IssuerError(error.statusCode, error.code.replace('APPLICATION_', 'ISSUER_'))
    throw error
  }
}
