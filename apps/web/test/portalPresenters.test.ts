import { describe, expect, it } from 'vitest'
import type { IssuerWorkspaceView, PortalAccount } from '../app/types/portal'
import { invitationProgress, issuerNextAction } from '../app/utils/portalPresenters'

const workspace: IssuerWorkspaceView = {
  organizations: [],
  selectedOrganizationId: null,
  schemas: [],
  invites: [],
  credentials: [],
}
const account: PortalAccount = {
  id: 'user',
  email: null,
  displayName: null,
  roles: ['recipient'],
  organizations: [],
  wallets: [],
}

describe('issuer next action', () => {
  it('moves through application, approval, wallet, template and invitation gates', () => {
    expect(issuerNextAction(workspace, account).kind).toBe('apply')
    const pending = {
      ...workspace,
      selectedOrganizationId: 'org',
      organizations: [
        {
          id: 'org',
          name: 'Org',
          status: 'active' as const,
          applicationStatus: 'pending' as const,
          reviewReason: null,
          revision: 0,
        },
      ],
    }
    expect(issuerNextAction(pending, account).kind).toBe('awaitApproval')
    const approved = {
      ...pending,
      organizations: [{ ...pending.organizations[0]!, applicationStatus: 'approved' as const }],
    }
    expect(issuerNextAction(approved, account).kind).toBe('linkWallet')
    const walletAccount = {
      ...account,
      wallets: [{ id: 'wallet', address: 'rAddress', networkId: 1, verifiedAt: '' }],
    }
    expect(issuerNextAction(approved, walletAccount).kind).toBe('createTemplate')
    const modeled = {
      ...approved,
      schemas: [
        {
          profileId: 'testnet',
          schemaUid: 'a'.repeat(64),
          displayName: 'Course',
          category: 'Education',
          name: 'Course',
          publisher: null,
          registrationTransactionHash: 'b'.repeat(64),
        },
      ],
    }
    expect(issuerNextAction(modeled, walletAccount).kind).toBe('invite')
  })

  it('prioritizes a recipient ready for issuance over waiting invitations', () => {
    const invite = {
      id: '00000000-0000-4000-8000-000000000001',
      organizationId: 'org',
      profileId: 'testnet',
      schemaUid: 'a'.repeat(64),
      email: 'recipient@example.test',
      createdAt: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      claimedBy: 'recipient',
      claimedAt: '2026-01-01T00:00:00.000Z',
      revokedAt: null,
      deliveryStatus: 'sent' as const,
      deliveryError: null,
      recipientStatus: 'ready' as const,
      recipientWalletVerifiedAt: '2026-01-01T00:00:00.000Z',
    }
    const modeled = {
      ...workspace,
      selectedOrganizationId: 'org',
      organizations: [
        {
          id: 'org',
          name: 'Org',
          status: 'active' as const,
          applicationStatus: 'approved' as const,
          reviewReason: null,
          revision: 0,
        },
      ],
      schemas: [{}] as IssuerWorkspaceView['schemas'],
      invites: [invite],
    }
    const readyAccount = {
      ...account,
      wallets: [{ id: '', address: '', networkId: 1, verifiedAt: '' }],
    }
    expect(issuerNextAction(modeled, readyAccount)).toMatchObject({
      kind: 'issue',
      inviteId: invite.id,
    })
    expect(invitationProgress(invite)).toEqual({
      email: 'complete',
      claimed: 'complete',
      wallet: 'complete',
      issuance: 'current',
    })
  })
})
