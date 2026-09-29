import type {
  IssuerInvitationCard,
  IssuerWorkspaceView,
  PortalAccount,
  PortalNextAction,
  RecipientCredentialCard,
} from '~/types/portal'

export interface InvitationProgress {
  email: 'complete' | 'attention'
  claimed: 'complete' | 'current' | 'pending'
  wallet: 'complete' | 'current' | 'pending'
  issuance: 'complete' | 'current' | 'pending'
}

export function issuerNextAction(
  workspace: IssuerWorkspaceView,
  account: Pick<PortalAccount, 'wallets'> | null,
): PortalNextAction {
  const organization = workspace.organizations.find(
    (item) => item.id === workspace.selectedOrganizationId,
  )
  if (!organization) return { kind: 'apply', to: '/issuer/apply' }
  if (organization.status !== 'active' || organization.applicationStatus !== 'approved') {
    return { kind: 'awaitApproval' }
  }
  if (!account?.wallets.some((wallet) => wallet.networkId === 1)) {
    return { kind: 'linkWallet', to: '/account', returnTo: '/issuer' }
  }
  if (workspace.schemas.length === 0) {
    return {
      kind: 'createTemplate',
      to: '/issuer/schemas/new',
      organizationId: organization.id,
    }
  }
  if (workspace.invites.length === 0) {
    return { kind: 'invite', to: '/issuer/recipients', organizationId: organization.id }
  }
  const ready = workspace.invites.find(
    (invite) => !invite.revokedAt && invite.recipientStatus === 'ready',
  )
  if (ready) return { kind: 'issue', to: `/issuer/issue/${ready.id}`, inviteId: ready.id }
  if (
    workspace.invites.some(
      (invite) =>
        !invite.revokedAt &&
        (invite.recipientStatus === 'invited' || invite.recipientStatus === 'wallet_required'),
    )
  ) {
    return { kind: 'awaitRecipient' }
  }
  return { kind: 'done' }
}

export function invitationProgress(invite: IssuerInvitationCard): InvitationProgress {
  const email = invite.deliveryStatus === 'sent' ? 'complete' : 'attention'
  const claimed = invite.claimedAt ? 'complete' : 'current'
  const wallet = invite.recipientWalletVerifiedAt
    ? 'complete'
    : invite.claimedAt
      ? 'current'
      : 'pending'
  const issuance =
    invite.recipientStatus === 'issued'
      ? 'complete'
      : invite.recipientStatus === 'ready'
        ? 'current'
        : 'pending'
  return { email, claimed, wallet, issuance }
}

export function recipientNextAction(credential: RecipientCredentialCard): PortalNextAction {
  if (credential.status.state === 'pending') {
    return {
      kind: 'review',
      to: `/recipient/credentials/${credential.generationId}?profile=${encodeURIComponent(credential.profileId)}`,
    }
  }
  if (credential.status.state === 'active') {
    return {
      kind: 'share',
      to: `/recipient/credentials/${credential.generationId}/present?profile=${encodeURIComponent(credential.profileId)}`,
    }
  }
  return { kind: 'done' }
}
