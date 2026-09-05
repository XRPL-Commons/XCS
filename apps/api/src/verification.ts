import {
  verifyCredentialPayload,
  XcsError,
  type CredentialLifecycleState,
  type CredentialPayloadStatus,
  type ResolvedSchema,
} from '@xcs-protocol/core'
import type { CredentialGenerationRow, SchemaRow } from '@xcs-protocol/db'

import { assertCredentialGenerationEvidence } from './credential-generation-evidence.js'
import { credentialGenerationState } from './credential-state.js'
import { DEFAULT_LEDGER_MAX_AGE_SECONDS } from './ledger-freshness.js'
import { assertAuthoritativeLedgerEvidence, assertIndexerReady } from './indexer-status.js'
import { PayloadInvalidError, PayloadUnavailableError } from './payload-resolver.js'
import { authoritativeResolvedSchema, schemaProjectionEvidenceUids } from './schema-projection.js'
import { canonicalJson, decodeHexUtf8 } from './serialization.js'
import type { ApiRepository, PayloadResolver, TrustPolicy } from './types.js'

export interface VerificationReport {
  onChain: CredentialLifecycleState | 'not_found'
  schema: 'valid' | 'unknown'
  payload: CredentialPayloadStatus | 'not_checked'
  issuerTrust: 'trusted' | 'untrusted' | 'unknown'
  generationId?: string
}

export interface VerifyRequest {
  network: string
  issuer: string
  subject: string
  schemaUid: string
  payload?: unknown
  resolvePayload?: boolean
}

export class VerificationNetworkNotFoundError extends Error {
  readonly code = 'NETWORK_NOT_FOUND'
  readonly statusCode = 404

  constructor() {
    super('Network not found')
    this.name = 'VerificationNetworkNotFoundError'
  }
}

function onChainStatus(
  generation: CredentialGenerationRow | undefined,
  closeTime: number,
): VerificationReport['onChain'] {
  if (generation === undefined) return 'not_found'
  return credentialGenerationState(generation, closeTime)
}

function decodeCredentialUri(generation: CredentialGenerationRow): string | undefined {
  if (generation.uriHex === null) return undefined
  try {
    return decodeHexUtf8(generation.uriHex)
  } catch {
    return undefined
  }
}

async function payloadStatus(input: {
  request: VerifyRequest
  generation: CredentialGenerationRow | undefined
  schema: ResolvedSchema | undefined
  resolver: PayloadResolver
}): Promise<VerificationReport['payload']> {
  const { request, generation, schema, resolver } = input
  if (request.payload === undefined && request.resolvePayload !== true) return 'not_checked'
  if (generation === undefined || schema === undefined) return 'invalid'
  const uri = decodeCredentialUri(generation)
  if (uri === undefined) return 'invalid'

  const context = {
    issuer: request.issuer,
    subject: request.subject,
    schemaUid: request.schemaUid,
    fields: schema.fields,
  }

  if (request.payload !== undefined) {
    try {
      return verifyCredentialPayload(
        { status: 'retrieved', content: canonicalJson(request.payload) },
        uri,
        context,
      )
    } catch (error) {
      if (error instanceof XcsError) return 'invalid'
      throw error
    }
  }

  try {
    const content = await resolver.resolve(uri)
    return verifyCredentialPayload({ status: 'retrieved', content }, uri, context)
  } catch (error) {
    if (error instanceof PayloadUnavailableError) {
      return verifyCredentialPayload({ status: 'unavailable' }, uri, context)
    }
    if (error instanceof PayloadInvalidError || error instanceof XcsError) return 'invalid'
    throw error
  }
}

export async function verifyCredential(
  request: VerifyRequest,
  dependencies: {
    repository: ApiRepository
    resolver: PayloadResolver
    trustPolicy: TrustPolicy
    maxLedgerAgeSeconds?: number
    now?: () => Date
  },
): Promise<VerificationReport> {
  const { generation, schema, checkpoint } = await dependencies.repository.withConsistentSnapshot(
    async (repository) => {
      const network = await repository.getNetwork(request.network)
      if (network === undefined) throw new VerificationNetworkNotFoundError()

      const now = dependencies.now?.() ?? (await repository.getDatabaseTime())
      const status = await repository.getIndexerStatus(request.network)
      assertIndexerReady(status, now)

      const [generation, schemaRow] = await Promise.all([
        repository.getCredential({
          profileId: request.network,
          issuer: request.issuer,
          subject: request.subject,
          schemaUid: request.schemaUid,
        }),
        repository.getSchema(request.network, request.schemaUid),
      ])
      const schemaEvidence =
        schemaRow === undefined
          ? []
          : await repository.getSchemaProjectionEvidence({
              profileId: request.network,
              schemaUids: schemaProjectionEvidenceUids([schemaRow], request.network),
            })
      const checkpoint = await repository.getLatestCheckpoint(request.network)
      const evidence = {
        expectedProfileId: request.network,
        status,
        checkpoint,
        now,
        maxLedgerAgeSeconds: dependencies.maxLedgerAgeSeconds ?? DEFAULT_LEDGER_MAX_AGE_SECONDS,
        minimumLedgerIndex: network.activationLedgerIndex,
        projectionLedgerIndexes: [
          ...(generation === undefined
            ? []
            : [generation.createdLedgerIndex, generation.lastLedgerIndex]),
          ...schemaEvidence.map((item) => item.schema.ledgerIndex),
        ],
      }
      assertAuthoritativeLedgerEvidence(evidence)
      if (generation !== undefined) {
        assertCredentialGenerationEvidence(generation, {
          profileId: request.network,
          activationLedgerIndex: network.activationLedgerIndex,
          checkpointLedgerIndex: evidence.checkpoint.ledgerIndex,
          issuer: request.issuer,
          subject: request.subject,
          schemaUid: request.schemaUid,
        })
      }
      const schema =
        schemaRow === undefined
          ? undefined
          : authoritativeResolvedSchema(schemaRow, schemaEvidence, {
              profileId: request.network,
              schemaUid: request.schemaUid,
              networkId: network.networkId,
              activationLedgerIndex: network.activationLedgerIndex,
            })
      return { generation, schema, checkpoint: evidence.checkpoint }
    },
  )

  const schemaStatus: VerificationReport['schema'] = schema === undefined ? 'unknown' : 'valid'

  const report: VerificationReport = {
    onChain: onChainStatus(generation, checkpoint.closeTime),
    schema: schemaStatus,
    payload: await payloadStatus({ request, generation, schema, resolver: dependencies.resolver }),
    issuerTrust: dependencies.trustPolicy.evaluate(request.issuer),
    ...(generation === undefined ? {} : { generationId: generation.generationId }),
  }
  return report
}

export class StaticTrustPolicy implements TrustPolicy {
  private readonly trusted: ReadonlySet<string>
  private readonly untrusted: ReadonlySet<string>

  constructor(input: { trusted?: Iterable<string>; untrusted?: Iterable<string> } = {}) {
    this.trusted = new Set(input.trusted ?? [])
    this.untrusted = new Set(input.untrusted ?? [])
  }

  evaluate(issuer: string): 'trusted' | 'untrusted' | 'unknown' {
    if (this.untrusted.has(issuer)) return 'untrusted'
    if (this.trusted.has(issuer)) return 'trusted'
    return 'unknown'
  }
}
