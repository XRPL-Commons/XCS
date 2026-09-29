import { createHash } from 'node:crypto'

export type ApplicationRole = 'issuer' | 'verifier'
export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'suspended'
export type DecisionAction = 'approve' | 'reject' | 'suspend' | 'restore'
export interface DecisionInput {
  action: DecisionAction
  revision: number
  reason: string
  idempotencyKey: string
}
export class AdminError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly current?: unknown,
  ) {
    super(code)
  }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new AdminError(400, 'ADMIN_INPUT_INVALID')
  return value.toLowerCase()
}
export function role(value: unknown): ApplicationRole {
  if (value !== 'issuer' && value !== 'verifier') throw new AdminError(400, 'ADMIN_INPUT_INVALID')
  return value
}
export function decisionInput(value: unknown): DecisionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AdminError(400, 'ADMIN_INPUT_INVALID')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (k) => !['action', 'revision', 'reason', 'idempotencyKey'].includes(k),
    ) ||
    !['approve', 'reject', 'suspend', 'restore'].includes(String(input.action)) ||
    !Number.isSafeInteger(input.revision) ||
    Number(input.revision) < 0 ||
    Number(input.revision) > 2147483646 ||
    typeof input.reason !== 'string' ||
    input.reason.length > 2000
  )
    throw new AdminError(400, 'ADMIN_INPUT_INVALID')
  const reason = input.reason.trim()
  if (['reject', 'suspend'].includes(String(input.action)) && !reason)
    throw new AdminError(400, 'ADMIN_REASON_REQUIRED')
  return {
    action: input.action as DecisionAction,
    revision: Number(input.revision),
    reason,
    idempotencyKey: uuid(input.idempotencyKey),
  }
}
export function transition(
  status: ApplicationStatus,
  applicationRole: ApplicationRole,
  action: DecisionAction,
): ApplicationStatus {
  if (status === 'pending' && action === 'approve') return 'approved'
  if (status === 'pending' && action === 'reject') return 'rejected'
  if (applicationRole === 'verifier' && status === 'approved' && action === 'suspend')
    return 'suspended'
  if (applicationRole === 'verifier' && status === 'suspended' && action === 'restore')
    return 'approved'
  throw new AdminError(409, 'ADMIN_TRANSITION_INVALID')
}
export function requestHash(
  organizationId: string,
  applicationRole: ApplicationRole,
  input: DecisionInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([organizationId, applicationRole, input.action, input.revision, input.reason]),
    )
    .digest('hex')
}
export function verifiedEmail(email: unknown, verifiedAt: unknown): string | null {
  return verifiedAt &&
    typeof email === 'string' &&
    email.length <= 254 &&
    /^[^\s<>(),;:"\\@]+@[^\s<>(),;:"\\@]+\.[^\s<>(),;:"\\@]+$/.test(email)
    ? email
    : null
}
