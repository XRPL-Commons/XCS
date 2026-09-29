import type { VerificationDimensions } from '~/utils/credentialReview'

export type PortalClaims = Record<string, unknown>

export type PersonalRole = 'admin' | 'recipient'
export type OrganizationRole = 'issuer' | 'verifier'
export type AppRole = PersonalRole | OrganizationRole

export interface PortalAccount {
  id: string
  email: string | null
  displayName: string | null
  roles: PersonalRole[]
  organizations: { id: string; name: string; roles: OrganizationRole[] }[]
  wallets: { id: string; address: string; networkId: number; verifiedAt: string }[]
}

export interface PortalOrganization {
  id: string
  name: string
  status: 'active' | 'suspended' | 'closed'
  applicationStatus: 'pending' | 'approved' | 'rejected' | 'suspended'
  reviewReason: string | null
  revision: number
}

export interface IssuerSchemaCard {
  profileId: string
  schemaUid: string
  displayName: string | null
  category: string | null
  name: string | null
  publisher: string | null
  registrationTransactionHash: string
}

export interface IssuerInvitationCard {
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

export interface IssuerCredentialCard {
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

export interface IssuerWorkspaceView {
  organizations: PortalOrganization[]
  selectedOrganizationId: string | null
  schemas: IssuerSchemaCard[]
  invites: IssuerInvitationCard[]
  credentials: IssuerCredentialCard[]
}

export interface RecipientCredentialCard {
  profileId: string
  generationId: string
  schemaUid: string
  schemaName: string | null
  organizationId: string
  organizationName: string
  issuerAddress: string
  subjectAddress: string
  networkId: number
  visibility: 'public' | 'private'
  createdAt: string
  creationTransactionHash: string
  status: {
    state: 'pending' | 'active' | 'expired' | 'deleted' | 'unknown'
    accepted: boolean | null
    expiration: number | null
    deletedLedgerIndex: number | null
    deletionCause: string | null
  }
}

export interface RecipientInvitationCard {
  id: string
  organizationId: string
  organizationName: string
  profileId: string
  schemaUid: string
  schemaName: string | null
  claimedAt: string
  expiresAt: string
  revokedAt: string | null
  generationId: string | null
}

export interface RecipientWorkspaceView {
  invitations: RecipientInvitationCard[]
  credentials: RecipientCredentialCard[]
  notifications: {
    id: string
    kind: 'issued' | 'revoked'
    profileId: string
    generationId: string
    organizationName: string
    createdAt: string
  }[]
}

export interface RecipientCredentialDetail extends RecipientCredentialCard {
  issuerAdmission: 'approved' | 'suspended' | 'not_approved' | 'unknown'
  disclosure: { publicFields: string[]; fields: string[] }
  events: {
    transactionHash: string
    eventType: 'created' | 'accepted' | 'deleted'
    ledgerIndex: number
    deletionCause: string | null
  }[]
}

export interface RecipientPayloadView {
  scope: 'full'
  claims: PortalClaims
  verification: VerificationDimensions
}

export interface PresentationView {
  id: string
  profileId: string
  generationId: string
  scope: 'public' | 'full'
  verifierOrganizationId: string | null
  verifierOrganizationName: string | null
  createdAt: string
  revokedAt: string | null
}

export interface CreatedPresentationView extends PresentationView {
  token: string
  url: string
}

export type HolderProofView =
  | { status: 'not_provided' | 'invalid' }
  | {
      status: 'verified'
      address: string
      networkId: number
      verifiedAt: string
      message: string
      purpose: 'presentation_authorization'
      keyAuthority: 'master_key_address_only'
      signature: string
      publicKey: string
      scheme: 'ripple' | 'otsu'
    }

export interface ResolvedPresentationView {
  presentation: PresentationView
  credential: RecipientCredentialCard
  scope: 'public' | 'full'
  claims: PortalClaims
  verification: VerificationDimensions
  requiresAuthorization: boolean
  issuerAdmission: {
    status: 'approved' | 'suspended' | 'not_approved' | 'unknown'
    organizationId: string
    checkedAt: string
    reviewedAt: string | null
  }
  holderProof: HolderProofView
}

export interface VerifierWorkspaceView {
  organizations: PortalOrganization[]
  selectedOrganizationId: string | null
  history: {
    id: string
    organizationId: string
    presentationId: string
    profileId: string
    generationId: string
    scope: 'public' | 'full'
    checkedAt: string
    verification: VerificationDimensions
  }[]
}

export type PortalNextAction =
  | { kind: 'apply'; to: '/issuer/apply' | '/verifier/apply' }
  | { kind: 'awaitApproval' }
  | { kind: 'linkWallet'; to: '/account'; returnTo: string }
  | { kind: 'createTemplate'; to: '/issuer/schemas/new'; organizationId: string }
  | { kind: 'invite'; to: '/issuer/recipients'; organizationId: string }
  | { kind: 'awaitRecipient' }
  | { kind: 'issue'; to: string; inviteId: string }
  | { kind: 'review'; to: string }
  | { kind: 'accept'; to: string }
  | { kind: 'share'; to: string }
  | { kind: 'done' }
