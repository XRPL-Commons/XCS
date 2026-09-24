import type { IssuerCredential, IssuerInvite } from '../../server/xcs/issuer/types'

export function issuerCredentialState(credential: IssuerCredential, now = Date.now()): string {
  const state = credential.status
  if (state.accepted === null) return 'unavailable'
  if (state.deletedLedgerIndex !== null) {
    return state.deletionCause === 'issuer_revoked'
      ? 'revoked'
      : state.deletionCause === 'subject_rejected'
        ? 'declined'
        : 'inactive'
  }
  if (state.expiration !== null && (state.expiration + 946684800) * 1000 <= now) return 'expired'
  return state.accepted ? 'accepted' : 'issued'
}

export function issuerInvitationState(invite: IssuerInvite, now = Date.now()): string {
  if (invite.revokedAt) return 'revoked'
  // Expiry bounds claiming; it does not erase an already-bound recipient.
  if (invite.claimedAt) return 'claimed'
  return new Date(invite.expiresAt).getTime() <= now ? 'expired' : 'unclaimed'
}
