import type { IssuerOrganization } from '../issuer/types'
import type { VerificationReport } from '../verification'

export type VerifierOrganization = IssuerOrganization

export interface VerifierHistoryEntry {
  id: string
  organizationId: string
  presentationId: string
  profileId: string
  generationId: string
  scope: 'public' | 'full'
  checkedAt: string
  verification: VerificationReport
}

export interface VerifierWorkspace {
  organizations: VerifierOrganization[]
  selectedOrganizationId: string | null
  history: VerifierHistoryEntry[]
}

export class VerifierError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code)
  }
}
