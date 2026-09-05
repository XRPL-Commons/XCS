import type { CredentialGenerationRow } from '@xcs-protocol/db'
import { isValidClassicAddress } from 'xrpl'

import { IndexerUnavailableError } from './ledger-freshness.js'

const LOWERCASE_HASH = /^[0-9a-f]{64}$/u
const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})*$/u
const MAX_NODE_INDEX = 2_147_483_647
const MAX_UINT32 = 4_294_967_295

export const CREDENTIAL_DELETION_CAUSES: ReadonlySet<string> = new Set([
  'issuer_revoked',
  'subject_rejected',
  'subject_removed',
  'expired_cleanup',
  'account_deleted',
  'self_deleted',
])

export interface CredentialGenerationEvidenceExpectation {
  readonly profileId: string
  readonly activationLedgerIndex: number
  readonly checkpointLedgerIndex: number
  readonly generationId?: string
  readonly issuer?: string
  readonly subject?: string
  readonly schemaUid?: string
}

function invalidCredentialGenerationEvidence(): never {
  throw new IndexerUnavailableError(
    'INDEXER_EVIDENCE_INVALID',
    'The indexed credential generation is incomplete or inconsistent.',
  )
}

/**
 * Validates the complete lifecycle summary stored for one Credential generation.
 * Callers must supply the authoritative activation/checkpoint envelope so that a
 * structurally valid row cannot claim events outside the indexed ledger range.
 */
export function assertCredentialGenerationEvidence(
  generation: CredentialGenerationRow,
  expected: CredentialGenerationEvidenceExpectation,
): void {
  const validDeletionShape =
    (generation.deletedLedgerIndex === null && generation.deletionCause === null) ||
    (generation.deletedLedgerIndex !== null &&
      typeof generation.deletionCause === 'string' &&
      CREDENTIAL_DELETION_CAUSES.has(generation.deletionCause) &&
      generation.deletedLedgerIndex === generation.lastLedgerIndex)

  if (
    generation.profileId !== expected.profileId ||
    (expected.generationId !== undefined && generation.generationId !== expected.generationId) ||
    (expected.issuer !== undefined && generation.issuer !== expected.issuer) ||
    (expected.subject !== undefined && generation.subject !== expected.subject) ||
    (expected.schemaUid !== undefined && generation.schemaUid !== expected.schemaUid) ||
    !LOWERCASE_HASH.test(generation.generationId) ||
    !LOWERCASE_HASH.test(generation.ledgerObjectId) ||
    !LOWERCASE_HASH.test(generation.schemaUid) ||
    !isValidClassicAddress(generation.issuer) ||
    !isValidClassicAddress(generation.subject) ||
    (generation.uriHex !== null && !HEX_BYTES.test(generation.uriHex)) ||
    (generation.expiration !== null &&
      (!Number.isInteger(generation.expiration) ||
        generation.expiration < 0 ||
        generation.expiration > MAX_UINT32)) ||
    typeof generation.accepted !== 'boolean' ||
    !Number.isInteger(generation.createdLedgerIndex) ||
    generation.createdLedgerIndex < expected.activationLedgerIndex ||
    generation.createdLedgerIndex > expected.checkpointLedgerIndex ||
    !Number.isInteger(generation.createdTransactionIndex) ||
    generation.createdTransactionIndex < 0 ||
    generation.createdTransactionIndex > MAX_NODE_INDEX ||
    !Number.isInteger(generation.lastLedgerIndex) ||
    generation.lastLedgerIndex < generation.createdLedgerIndex ||
    generation.lastLedgerIndex > expected.checkpointLedgerIndex ||
    (generation.deletedLedgerIndex !== null &&
      (!Number.isInteger(generation.deletedLedgerIndex) ||
        generation.deletedLedgerIndex < generation.createdLedgerIndex ||
        generation.deletedLedgerIndex > expected.checkpointLedgerIndex)) ||
    !validDeletionShape
  ) {
    invalidCredentialGenerationEvidence()
  }
}
