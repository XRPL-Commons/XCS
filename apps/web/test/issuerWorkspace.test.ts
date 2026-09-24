import { describe, expect, it } from 'vitest'
import { issuerCredentialState, issuerInvitationState } from '../app/utils/issuerWorkspace'
import type { IssuerCredential, IssuerInvite } from '../server/xcs/issuer/types'

describe('issuer observed lifecycle', () => {
  const credential = (status: Partial<IssuerCredential['status']>) =>
    ({
      status: {
        accepted: true,
        expiration: null,
        deletedLedgerIndex: null,
        deletionCause: null,
        ...status,
      },
    }) as IssuerCredential
  it('does not report acceptance when the projection is missing', () => {
    expect(issuerCredentialState(credential({ accepted: null }))).toBe('unavailable')
  })
  it('shows expiry even for an accepted credential', () => {
    expect(issuerCredentialState(credential({ expiration: 1000 }), 946685800000)).toBe('expired')
  })
  it.each([
    ['issuer_revoked', 'revoked'],
    ['subject_rejected', 'declined'],
    [null, 'inactive'],
  ])('preserves deletion cause %s', (deletionCause, expected) => {
    expect(
      issuerCredentialState(credential({ deletedLedgerIndex: 200, deletionCause, expiration: 1 })),
    ).toBe(expected)
  })
  it('requires explicit recipient acceptance', () => {
    expect(issuerCredentialState(credential({ accepted: false }))).toBe('issued')
  })
  it('does not expire a claimed invitation retroactively', () => {
    const invite = {
      claimedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-02T00:00:00Z',
      revokedAt: null,
    } as IssuerInvite
    expect(issuerInvitationState(invite, Date.parse('2026-01-03'))).toBe('claimed')
    expect(issuerInvitationState({ ...invite, claimedAt: null }, Date.parse('2026-01-03'))).toBe(
      'expired',
    )
  })
})
