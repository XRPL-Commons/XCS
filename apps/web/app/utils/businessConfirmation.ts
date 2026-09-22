import {
  canReconfirmOperation,
  isConfirmableBusinessContext,
  validateOperationBusinessContext,
  type BusinessConfirmation,
  type BusinessDeletionCause,
  type BusinessEvidence,
  type OperationBusinessContext,
  type StoredOperation,
} from './operationJournal'

export type CompletedBusinessConfirmation = Exclude<BusinessConfirmation, 'pending'>

export interface IndexedBusinessConfirmation {
  readonly confirmation: 'confirmed' | 'rejected'
  readonly evidence: BusinessEvidence
}

interface WaitForIndexedBusinessEvidenceOptions {
  readonly business: OperationBusinessContext
  readonly txHash: string
  readonly loadEvidence: () => Promise<unknown>
  readonly timeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
}

interface ReconfirmValidatedBusinessOperationOptions {
  readonly operation: StoredOperation
  readonly loadEvidence: () => Promise<unknown>
  readonly persist: (
    confirmation: CompletedBusinessConfirmation,
    at: string,
    evidence?: BusinessEvidence,
  ) => Promise<void>
  readonly timeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly now?: (() => Date) | undefined
}

type InspectedEvidence = { readonly state: 'pending' | 'mismatch' } | IndexedBusinessConfirmation

const HASH = /^[0-9a-f]{64}$/i
const REASON_CODE = /^[A-Z0-9_]{1,128}$/
const DELETION_CAUSES = new Set<BusinessDeletionCause>([
  'issuer_revoked',
  'subject_rejected',
  'subject_removed',
  'expired_cleanup',
  'account_deleted',
  'self_deleted',
])

function isBusinessDeletionCause(input: unknown): input is BusinessDeletionCause {
  return typeof input === 'string' && DELETION_CAUSES.has(input as BusinessDeletionCause)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseHash(input: Record<string, unknown>, expectedHash: string): string {
  if (typeof input.transactionHash !== 'string' || !HASH.test(input.transactionHash)) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  const hash = input.transactionHash.toLowerCase()
  if (hash !== expectedHash.toLowerCase()) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  return hash
}

function requiredLedgerEvidence(
  input: Record<string, unknown>,
  transactionHash: string,
): Pick<BusinessEvidence, 'transactionHash' | 'ledgerIndex' | 'ledgerHash' | 'transactionIndex'> {
  if (
    !Number.isSafeInteger(input.ledgerIndex) ||
    (input.ledgerIndex as number) <= 0 ||
    typeof input.ledgerHash !== 'string' ||
    !HASH.test(input.ledgerHash) ||
    !Number.isSafeInteger(input.transactionIndex) ||
    (input.transactionIndex as number) < 0
  ) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  return {
    transactionHash,
    ledgerIndex: input.ledgerIndex as number,
    ledgerHash: input.ledgerHash.toLowerCase(),
    transactionIndex: input.transactionIndex as number,
  }
}

function inspectSchemaRegistration(
  input: unknown,
  business: Extract<OperationBusinessContext, { readonly action: 'schema-register' }>,
  txHash: string,
): InspectedEvidence {
  if (!isRecord(input)) throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  const transactionHash = responseHash(input, txHash)
  if (input.registration === null) return { state: 'pending' }
  if (!isRecord(input.registration)) throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  const registration = input.registration
  if (
    (registration.status !== 'accepted' && registration.status !== 'rejected') ||
    typeof registration.publisher !== 'string'
  ) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  if (registration.publisher !== business.publisher) return { state: 'mismatch' }
  const ledger = requiredLedgerEvidence(registration, transactionHash)

  if (registration.status === 'rejected') {
    if (
      registration.schemaUid !== null ||
      registration.schemaDigestHex !== null ||
      typeof registration.reasonCode !== 'string' ||
      !REASON_CODE.test(registration.reasonCode)
    ) {
      throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
    }
    return {
      confirmation: 'rejected',
      evidence: { ...ledger, reasonCode: registration.reasonCode },
    }
  }

  if (
    typeof registration.schemaUid !== 'string' ||
    !HASH.test(registration.schemaUid) ||
    typeof registration.schemaDigestHex !== 'string' ||
    !HASH.test(registration.schemaDigestHex) ||
    registration.reasonCode !== null
  ) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  if (registration.schemaDigestHex.toLowerCase() !== business.schemaDigestHex) {
    return { state: 'mismatch' }
  }
  return {
    confirmation: 'confirmed',
    evidence: { ...ledger, schemaUid: registration.schemaUid.toLowerCase() },
  }
}

function inspectCredentialEvent(
  input: unknown,
  business: Exclude<OperationBusinessContext, { readonly action: 'schema-register' }>,
  txHash: string,
): InspectedEvidence {
  if (!isRecord(input)) throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  const transactionHash = responseHash(input, txHash)
  if (input.event === null) return { state: 'pending' }
  if (!isRecord(input.event)) throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  const event = input.event
  if (
    typeof event.transactionHash !== 'string' ||
    !HASH.test(event.transactionHash) ||
    typeof event.issuer !== 'string' ||
    typeof event.subject !== 'string' ||
    typeof event.schemaUid !== 'string' ||
    !HASH.test(event.schemaUid) ||
    typeof event.generationId !== 'string' ||
    !HASH.test(event.generationId) ||
    (event.eventType !== 'created' &&
      event.eventType !== 'accepted' &&
      event.eventType !== 'deleted') ||
    typeof event.accepted !== 'boolean' ||
    (event.eventType === 'deleted'
      ? !isBusinessDeletionCause(event.deletionCause)
      : event.deletionCause !== null)
  ) {
    throw new Error('BUSINESS_EVIDENCE_RESPONSE_INVALID')
  }
  if (
    event.transactionHash.toLowerCase() !== transactionHash ||
    event.issuer !== business.issuer ||
    event.subject !== business.subject ||
    event.schemaUid.toLowerCase() !== business.schemaUid
  ) {
    return { state: 'mismatch' }
  }
  const generationId = event.generationId.toLowerCase()
  let confirmed: boolean
  if (business.action === 'credential-issue') {
    confirmed =
      event.eventType === 'created' &&
      generationId === transactionHash &&
      event.accepted === (business.issuer === business.subject)
  } else {
    const expectedEventType = business.action === 'credential-accept' ? 'accepted' : 'deleted'
    const expectedDeletionCause =
      business.action === 'credential-reject'
        ? 'subject_rejected'
        : business.action === 'credential-remove'
          ? business.issuer === business.subject
            ? 'issuer_revoked'
            : 'subject_removed'
          : business.action === 'credential-revoke'
            ? 'issuer_revoked'
            : undefined
    confirmed =
      generationId === business.generationId &&
      event.eventType === expectedEventType &&
      (business.action === 'credential-reject'
        ? event.accepted === false
        : (business.action !== 'credential-accept' && business.action !== 'credential-remove') ||
          event.accepted === true) &&
      (expectedDeletionCause === undefined || event.deletionCause === expectedDeletionCause)
  }
  if (!confirmed) return { state: 'mismatch' }
  return {
    confirmation: 'confirmed',
    evidence: {
      ...requiredLedgerEvidence(event, transactionHash),
      schemaUid: event.schemaUid.toLowerCase(),
      generationId,
      eventType: event.eventType,
      accepted: event.accepted,
      deletionCause: event.deletionCause as BusinessDeletionCause | null,
    },
  }
}

export function inspectIndexedBusinessEvidence(
  input: unknown,
  business: OperationBusinessContext,
  txHash: string,
): InspectedEvidence {
  if (!isConfirmableBusinessContext(business)) {
    throw new Error('OPERATION_BUSINESS_CONTEXT_INCOMPLETE')
  }
  return business.action === 'schema-register'
    ? inspectSchemaRegistration(input, business, txHash)
    : inspectCredentialEvent(input, business, txHash)
}

export async function waitForIndexedBusinessEvidence(
  options: WaitForIndexedBusinessEvidenceOptions,
): Promise<IndexedBusinessConfirmation> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('BUSINESS_EVIDENCE_TIMEOUT_INVALID')
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('BUSINESS_EVIDENCE_POLL_INTERVAL_INVALID')
  }
  const deadline = Date.now() + timeoutMs
  do {
    try {
      const inspected = inspectIndexedBusinessEvidence(
        await options.loadEvidence(),
        options.business,
        options.txHash,
      )
      if ('confirmation' in inspected) return inspected
      if (inspected.state === 'mismatch') throw new Error('BUSINESS_EVIDENCE_MISMATCH')
    } catch (error) {
      if (
        error instanceof Error &&
        ['BUSINESS_EVIDENCE_MISMATCH', 'BUSINESS_EVIDENCE_RESPONSE_INVALID'].includes(error.message)
      ) {
        throw error
      }
      // 503/readiness failures are expected while an authoritative indexer catches up.
    }
    if (Date.now() >= deadline) throw new Error('BUSINESS_EVIDENCE_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    // eslint-disable-next-line no-constant-condition -- intentional poll loop; exits via return/throw above.
  } while (true)
}

/** Reconciles indexed evidence only. This path has no XRPL client, blob or submit dependency. */
export async function reconfirmValidatedBusinessOperation(
  options: ReconfirmValidatedBusinessOperationOptions,
): Promise<CompletedBusinessConfirmation> {
  if (!canReconfirmOperation(options.operation)) {
    throw new Error('OPERATION_BUSINESS_RECONFIRM_NOT_ALLOWED')
  }
  const business = options.operation.business
    ? validateOperationBusinessContext(options.operation.business)
    : undefined
  if (!isConfirmableBusinessContext(business) || !options.operation.txHash) {
    throw new Error('OPERATION_BUSINESS_CONTEXT_REQUIRED')
  }

  let confirmation: CompletedBusinessConfirmation
  let evidence: BusinessEvidence | undefined
  try {
    const outcome = await waitForIndexedBusinessEvidence({
      business,
      txHash: options.operation.txHash,
      loadEvidence: options.loadEvidence,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    })
    confirmation = outcome.confirmation
    evidence = outcome.evidence
  } catch (error) {
    confirmation =
      error instanceof Error &&
      ['BUSINESS_EVIDENCE_MISMATCH', 'BUSINESS_EVIDENCE_RESPONSE_INVALID'].includes(error.message)
        ? 'mismatch'
        : 'timeout'
  }

  await options.persist(confirmation, (options.now?.() ?? new Date()).toISOString(), evidence)
  return confirmation
}
