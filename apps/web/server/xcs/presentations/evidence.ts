import { and, eq } from 'drizzle-orm'
import { credentialGenerations } from '#db/schema'
import type { appCredentialMetadata } from '#db/schema/app'
import { decodeHexUtf8, verifyCredentialPayload, XcsError } from '#xcs/core/index.js'
import type { XcsDatabase } from '../../lib/db/client.js'
import { PostgresApiRepository } from '../repository'
import { assertAuthoritativeLedgerEvidence } from '../indexer-status'
import { assertCredentialGenerationEvidence } from '../credential-generation-evidence'
import { credentialGenerationState } from '../credential-state'
import { DEFAULT_LEDGER_MAX_AGE_SECONDS, IndexerUnavailableError } from '../ledger-freshness'
import { authoritativeResolvedSchema, schemaProjectionEvidenceUids } from '../schema-projection'
import { StaticTrustPolicy, type VerificationReport } from '../verification'
import type { TrustPolicy } from '../types'
import type { ApiConfig } from '../config'

export type CredentialMetadata = typeof appCredentialMetadata.$inferSelect

export interface EvidencePolicy {
  trustPolicy?: TrustPolicy
  maxLedgerAgeSeconds?: number
}
export function evidencePolicyFromConfig(
  config: Pick<ApiConfig, 'trustedIssuers' | 'untrustedIssuers' | 'readinessMaxLedgerAgeSeconds'>,
): EvidencePolicy {
  return {
    trustPolicy: new StaticTrustPolicy({
      trusted: config.trustedIssuers,
      untrusted: config.untrustedIssuers,
    }),
    maxLedgerAgeSeconds: config.readinessMaxLedgerAgeSeconds,
  }
}

/** Caller supplies the same transaction used for authorization. No HTTP or external payload reads. */
export async function managedCredentialEvidence(
  db: XcsDatabase,
  metadata: CredentialMetadata,
  canonicalPayload?: string,
  checkSchema = true,
  policy: EvidencePolicy = {},
) {
  const repository = new PostgresApiRepository(db)
  const network = await repository.getNetwork(metadata.profileId)
  const [generation] = await db
    .select()
    .from(credentialGenerations)
    .where(
      and(
        eq(credentialGenerations.profileId, metadata.profileId),
        eq(credentialGenerations.generationId, metadata.generationId),
      ),
    )
  if (!network || !generation)
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'Credential generation unavailable',
    )
  const evidence = {
    expectedProfileId: metadata.profileId,
    status: await repository.getIndexerStatus(metadata.profileId),
    checkpoint: await repository.getLatestCheckpoint(metadata.profileId),
    now: await repository.getDatabaseTime(),
    maxLedgerAgeSeconds: policy.maxLedgerAgeSeconds ?? DEFAULT_LEDGER_MAX_AGE_SECONDS,
    minimumLedgerIndex: network.activationLedgerIndex,
    projectionLedgerIndexes: [generation.createdLedgerIndex, generation.lastLedgerIndex],
  }
  assertAuthoritativeLedgerEvidence(evidence)
  assertCredentialGenerationEvidence(generation, {
    profileId: metadata.profileId,
    generationId: metadata.generationId,
    issuer: metadata.issuerAddress,
    subject: metadata.subjectAddress,
    schemaUid: metadata.schemaUid,
    activationLedgerIndex: network.activationLedgerIndex,
    checkpointLedgerIndex: evidence.checkpoint.ledgerIndex,
  })
  const schemaRow = checkSchema
    ? await repository.getSchema(metadata.profileId, metadata.schemaUid)
    : undefined
  const schemaEvidence = schemaRow
    ? await repository.getSchemaProjectionEvidence({
        profileId: metadata.profileId,
        schemaUids: schemaProjectionEvidenceUids([schemaRow], metadata.profileId),
      })
    : []
  if (schemaEvidence.some((item) => item.schema.ledgerIndex > evidence.checkpoint.ledgerIndex))
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'Schema ahead of validated checkpoint',
    )
  const schema = schemaRow
    ? authoritativeResolvedSchema(schemaRow, schemaEvidence, {
        profileId: metadata.profileId,
        schemaUid: metadata.schemaUid,
        networkId: network.networkId,
        activationLedgerIndex: network.activationLedgerIndex,
      })
    : undefined
  const verification: VerificationReport = {
    onChain: credentialGenerationState(generation, evidence.checkpoint.closeTime),
    schema: schema ? 'valid' : 'unknown',
    payload: 'not_checked',
    // Portal approval is not a trust decision about an issuer or its claims.
    issuerTrust: policy.trustPolicy?.evaluate(metadata.issuerAddress) ?? 'unknown',
    generationId: metadata.generationId,
  }
  if (canonicalPayload !== undefined) {
    verification.payload = 'invalid'
    if (schema && generation.uriHex !== null) {
      try {
        verification.payload = verifyCredentialPayload(
          { status: 'retrieved', content: canonicalPayload },
          decodeHexUtf8(generation.uriHex),
          {
            issuer: metadata.issuerAddress,
            subject: metadata.subjectAddress,
            schemaUid: metadata.schemaUid,
            fields: schema.fields,
          },
        )
      } catch (error) {
        if (!(error instanceof XcsError)) throw error
      }
    }
  }
  return { generation, verification }
}
