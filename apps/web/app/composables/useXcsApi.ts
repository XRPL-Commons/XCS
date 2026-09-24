import type { NetworkProfile, ResolvedSchema, SchemaDefinition } from '#xcs/core/index.js'
import type { VerificationDimensions } from '../utils/credentialReview'
import {
  exactCredentialEventPath,
  exactCredentialPath,
  exactSchemaRegistrationPath,
} from '../utils/transactions'
import { parseSigningReadiness, type SigningReadiness } from '../utils/signingReadiness'

export interface ApiSchemaSummary {
  uid: string
  name: string
  description: string
  publisher: string
  valid: boolean
  parentUid: string | null
  supersedesUid: string | null
  registrationTransactionHash: string
  ledgerIndex: number
  transactionIndex: number
}

export interface ApiSchemaDetail extends ApiSchemaSummary {
  definition: SchemaDefinition
  resolved: ResolvedSchema
}

interface SchemaRow {
  schemaUid: string
  name: string
  description: string
  publisher: string
  parentUid: string | null
  supersedesUid: string | null
  definition: SchemaDefinition
  resolvedDefinition: ResolvedSchema
  registrationTransactionHash: string
  ledgerIndex: number
  transactionIndex: number
}

export type ApiCredentialState = 'pending' | 'active' | 'expired' | 'deleted'

export interface ApiStats {
  network: string
  schemas: { total: number; publishers: number }
  credentialGenerations: {
    total: number
    pending: number
    active: number
    expired: number
    deleted: number
  }
  checkpoint: {
    ledgerIndex: number
    ledgerHash: string
    closeTime: number
    transactionRoot: string
  }
}

export interface ApiIndexerStatus {
  profileId: string
  state: 'starting' | 'catching_up' | 'ready' | 'halted'
  sourceTips: { primary: number | null; secondary: number | null }
  lastAgreedLedger: { index: number; hash: string } | null
  errorCode: string | null
  updatedAt: string
}

export interface ApiSchemaSearchResult {
  type: 'schema'
  schemaUid: string
  publisher: string
  name: string
  description: string
  parentUid: string | null
  supersedesUid: string | null
  registrationTransactionHash: string
  ledgerIndex: number
  transactionIndex: number
}

export interface ApiCredentialSearchResult {
  type: 'credential_generation'
  generationId: string
  issuer: string
  subject: string
  schemaUid: string
  state: ApiCredentialState
  createdLedgerIndex: number
  lastLedgerIndex: number
}

export interface ApiTransactionSearchResult {
  type: 'transaction'
  transactionHash: string
  ledgerIndex: number
  ledgerHash: string
  transactionIndex: number
  registrationStatus: 'accepted' | 'rejected' | null
  credentialEventCount: number
}

export type ApiSearchResult =
  ApiSchemaSearchResult | ApiCredentialSearchResult | ApiTransactionSearchResult

export interface ApiSchemaRegistrationEvidence {
  status: 'accepted' | 'rejected'
  publisher: string
  ledgerIndex: number
  ledgerHash: string
  transactionIndex: number
  schemaUid: string | null
  schemaDigestHex: string | null
  reasonCode: string | null
}

export interface ApiSchemaRegistration extends ApiSchemaRegistrationEvidence {
  transactionHash: string
}

export interface ApiCredentialEvent {
  transactionHash: string
  nodeIndex: number
  generationId: string
  ledgerIndex: number
  ledgerHash: string
  transactionIndex: number
  eventType: 'created' | 'accepted' | 'deleted'
  issuer: string
  subject: string
  schemaUid: string
  accepted: boolean
  deletionCause: string | null
}

export interface ApiSchemaActivityPage {
  items: ApiSchemaRegistration[]
  nextCursor?: string
}

export interface ApiCredentialGeneration {
  generationId: string
  ledgerObjectId: string
  issuer: string
  subject: string
  schemaUid: string
  uriHex: string | null
  expiration: number | null
  accepted: boolean
  createdLedgerIndex: number
  createdTransactionIndex: number
  lastLedgerIndex: number
  deletedLedgerIndex: number | null
  deletionCause: string | null
}

export interface ApiCredentialGenerationDetail {
  generation: ApiCredentialGeneration
  state: ApiCredentialState
  timeline: ApiCredentialEvent[]
}

export interface ApiTransactionDetail {
  transactionHash: string
  ledgerIndex: number
  ledgerHash: string
  transactionIndex: number
  registration: ApiSchemaRegistrationEvidence | null
  credentialEvents: { items: ApiCredentialEvent[]; nextCursor?: string }
}

export type VerificationResponse = VerificationDimensions

export function useXcsApi() {
  const config = useRuntimeConfig()
  // The read API is served by this application's own server routes, so the same
  // relative paths work in the browser and, in process, during server rendering.
  const baseURL = ''
  const apiFetch = $fetch

  function listNetworks() {
    return apiFetch<{ items: NetworkProfile[] }>('/v1/networks', { baseURL })
  }

  async function getActiveNetworkProfile(): Promise<NetworkProfile> {
    const response = await listNetworks()
    const configuredProfileId = config.public.profileId.trim()
    const candidates = configuredProfileId
      ? response.items.filter((profile) => profile.profileId === configuredProfileId)
      : response.items.filter((profile) => profile.networkId === 1)

    if (candidates.length === 0) throw new Error('NETWORK_PROFILE_UNAVAILABLE')
    if (candidates.length > 1) throw new Error('NETWORK_PROFILE_AMBIGUOUS')
    const profile = candidates[0]!
    if (profile.networkId !== 1) throw new Error('ALPHA_REQUIRES_XRPL_TESTNET')
    return profile
  }

  async function resolveNetworkId(network?: string): Promise<string> {
    if (network) return network
    return (await getActiveNetworkProfile()).profileId
  }

  async function listSchemas(
    options: {
      network?: string
      cursor?: string
      publisher?: string
      limit?: number
    } = {},
  ) {
    const profileId = await resolveNetworkId(options.network)
    const response = await apiFetch<{ items: SchemaRow[]; nextCursor?: string }>(
      `/v1/networks/${encodeURIComponent(profileId)}/schemas`,
      {
        baseURL,
        query: {
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
      },
    )
    return {
      items: response.items.map((row) => ({
        uid: row.schemaUid,
        name: row.name,
        description: row.description,
        publisher: row.publisher,
        valid: true,
        parentUid: row.parentUid,
        supersedesUid: row.supersedesUid,
        registrationTransactionHash: row.registrationTransactionHash,
        ledgerIndex: row.ledgerIndex,
        transactionIndex: row.transactionIndex,
      })),
      ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
    }
  }

  async function getSchema(uid: string, network?: string): Promise<ApiSchemaDetail> {
    const profileId = await resolveNetworkId(network)
    const row = await apiFetch<SchemaRow>(
      `/v1/networks/${encodeURIComponent(profileId)}/schemas/${encodeURIComponent(uid.toLowerCase())}`,
      { baseURL },
    )
    return {
      uid: row.schemaUid,
      name: row.name,
      description: row.description,
      publisher: row.publisher,
      valid: true,
      parentUid: row.parentUid,
      supersedesUid: row.supersedesUid,
      registrationTransactionHash: row.registrationTransactionHash,
      ledgerIndex: row.ledgerIndex,
      transactionIndex: row.transactionIndex,
      definition: row.definition,
      resolved: row.resolvedDefinition,
    }
  }

  async function getStats(network?: string): Promise<ApiStats> {
    const profileId = await resolveNetworkId(network)
    return apiFetch<ApiStats>(`/v1/networks/${encodeURIComponent(profileId)}/stats`, { baseURL })
  }

  async function getNetworkStatus(network?: string): Promise<ApiIndexerStatus> {
    const profileId = await resolveNetworkId(network)
    return apiFetch<ApiIndexerStatus>(`/v1/networks/${encodeURIComponent(profileId)}/status`, {
      baseURL,
    })
  }

  async function getNetworkReadiness(network?: string): Promise<SigningReadiness> {
    const profileId = await resolveNetworkId(network)
    let response: unknown
    try {
      response = await apiFetch<unknown>(
        `/v1/networks/${encodeURIComponent(profileId)}/readiness`,
        {
          baseURL,
          cache: 'no-store',
          retry: 0,
          timeout: 5_000,
        },
      )
    } catch {
      throw new Error('INDEXER_SIGNING_READINESS_UNAVAILABLE')
    }
    return parseSigningReadiness(response, profileId)
  }

  async function search(query: string, limit = 20, network?: string) {
    const profileId = await resolveNetworkId(network)
    return apiFetch<{ items: ApiSearchResult[]; hasMore: boolean }>(
      `/v1/networks/${encodeURIComponent(profileId)}/search`,
      { baseURL, query: { q: query, limit } },
    )
  }

  async function getSchemaActivity(
    options: { network?: string; cursor?: string; limit?: number } = {},
  ): Promise<ApiSchemaActivityPage> {
    const profileId = await resolveNetworkId(options.network)
    return apiFetch<ApiSchemaActivityPage>(
      `/v1/networks/${encodeURIComponent(profileId)}/activity`,
      {
        baseURL,
        query: {
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
      },
    )
  }

  async function getCredentialGeneration(
    generationId: string,
    network?: string,
  ): Promise<ApiCredentialGenerationDetail> {
    const profileId = await resolveNetworkId(network)
    return apiFetch<ApiCredentialGenerationDetail>(
      `/v1/networks/${encodeURIComponent(profileId)}/credential-generations/${encodeURIComponent(generationId.toLowerCase())}`,
      { baseURL },
    )
  }

  async function getTransaction(
    transactionHash: string,
    options: { network?: string; cursor?: string; limit?: number } = {},
  ): Promise<ApiTransactionDetail> {
    const profileId = await resolveNetworkId(options.network)
    return apiFetch<ApiTransactionDetail>(
      `/v1/networks/${encodeURIComponent(profileId)}/transactions/${encodeURIComponent(transactionHash.toLowerCase())}`,
      {
        baseURL,
        query: {
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
      },
    )
  }

  function verify(
    input: {
      issuer: string
      subject: string
      schemaUid: string
      resolvePayload?: boolean
      payload?: unknown
    },
    network?: string,
  ) {
    return resolveNetworkId(network).then((profileId) =>
      apiFetch<VerificationResponse>('/v1/verify', {
        baseURL,
        method: 'POST',
        body: { network: profileId, ...input, schemaUid: input.schemaUid.toLowerCase() },
      }),
    )
  }

  async function getCredential(
    issuer: string,
    subject: string,
    schemaUid: string,
    network?: string,
  ) {
    const profileId = await resolveNetworkId(network)
    return apiFetch<unknown>(exactCredentialPath(profileId, issuer, subject, schemaUid), {
      baseURL,
    })
  }

  async function getCredentialEventByTransaction(
    issuer: string,
    subject: string,
    schemaUid: string,
    transactionHash: string,
    network?: string,
  ) {
    const profileId = await resolveNetworkId(network)
    return apiFetch<unknown>(
      exactCredentialEventPath(profileId, issuer, subject, schemaUid, transactionHash),
      {
        baseURL,
        timeout: 5_000,
      },
    )
  }

  async function getSchemaRegistrationByTransaction(transactionHash: string, network?: string) {
    const profileId = await resolveNetworkId(network)
    return apiFetch<unknown>(exactSchemaRegistrationPath(profileId, transactionHash), {
      baseURL,
      timeout: 5_000,
    })
  }

  return {
    listNetworks,
    getActiveNetworkProfile,
    listSchemas,
    getSchema,
    getStats,
    getNetworkStatus,
    getNetworkReadiness,
    search,
    getSchemaActivity,
    getCredentialGeneration,
    getTransaction,
    getCredential,
    getCredentialEventByTransaction,
    getSchemaRegistrationByTransaction,
    verify,
  }
}
