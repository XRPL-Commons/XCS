// Copied from packages/core/src/lifecycle.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { fail } from './errors.js'

export type CredentialLifecycleState = 'pending' | 'active' | 'expired' | 'deleted'

export interface CredentialLifecycleInput {
  objectExists: boolean
  accepted: boolean
  expiration?: number | null
  closeTime: number
}

const UINT32_MAX = 0xffff_ffff

function requireRippleTime(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    return fail('INVALID_RIPPLE_TIME', 'Credential lifecycle time must be a uint32', '$time')
  }
}

/** Projects the state of a known Credential generation at a validated-ledger close time. */
export function projectCredentialLifecycle(
  input: CredentialLifecycleInput,
): CredentialLifecycleState {
  requireRippleTime(input.closeTime)
  if (input.expiration !== undefined && input.expiration !== null) {
    requireRippleTime(input.expiration)
  }

  if (!input.objectExists) return 'deleted'
  if (
    input.expiration !== undefined &&
    input.expiration !== null &&
    input.expiration <= input.closeTime
  )
    return 'expired'
  return input.accepted ? 'active' : 'pending'
}
