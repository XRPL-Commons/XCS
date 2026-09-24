import type {
  IssuerCredentialDetail,
  IssuerEngineRecord,
  IssuerIssuanceContext,
  IssuerPayloadReceipt,
  IssuerVisibility,
} from '../utils/issuerEngine'

export function useIssuerEngineApi() {
  const request = useRequestFetch()
  const { mutateApplication } = useAuth()
  return {
    issuance: (inviteId: string) =>
      request<IssuerIssuanceContext>(
        `/api/issuer/invites/${encodeURIComponent(inviteId)}/issuance`,
        { cache: 'no-store' },
      ),
    credential: (profileId: string, generationId: string) =>
      request<IssuerCredentialDetail>(
        `/api/issuer/credentials/${encodeURIComponent(profileId)}/${encodeURIComponent(generationId)}`,
        { cache: 'no-store' },
      ),
    preparePayload: (
      inviteId: string,
      subjectAddress: string,
      canonicalPayload: string,
      setting: IssuerVisibility,
    ) =>
      mutateApplication<IssuerPayloadReceipt>('/api/issuer/payloads', {
        inviteId,
        subjectAddress,
        canonicalPayload,
        ...setting,
      }),
    recordCredential: (inviteId: string, receipt: IssuerEngineRecord) =>
      mutateApplication<{
        profileId: string
        generationId: string
        organizationId: string
        inviteId: string
      }>('/api/issuer/credentials', { inviteId, ...receipt }),
    recordSchema: (organizationId: string, profileId: string, receipt: IssuerEngineRecord) =>
      mutateApplication('/api/issuer/schemas', {
        organizationId,
        profileId,
        transactionHash: receipt.transactionHash,
      }),
    reconcileRevocation: (profileId: string, generationId: string, transactionHash: string) =>
      mutateApplication(
        `/api/issuer/credentials/${encodeURIComponent(profileId)}/${encodeURIComponent(generationId)}/reconcile`,
        { transactionHash },
      ),
  }
}
