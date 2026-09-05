import type {
  OperationJournal,
  SubmissionJournalEntry,
  SubmissionJournalStage,
} from '@xcs-protocol/sdk'
import { parsePayloadUri } from '@xcs-protocol/core'
import { isValidClassicAddress } from 'xrpl'

const DATABASE_NAME = 'xcs-wallet-journal'
const DATABASE_VERSION = 1
const OPERATIONS_STORE = 'operations'

export type BusinessConfirmation = 'pending' | 'confirmed' | 'rejected' | 'mismatch' | 'timeout'
export type BusinessDeletionCause =
  | 'issuer_revoked'
  | 'subject_rejected'
  | 'subject_removed'
  | 'expired_cleanup'
  | 'account_deleted'
  | 'self_deleted'

export interface BusinessEvidence {
  readonly transactionHash: string
  readonly ledgerIndex: number
  readonly ledgerHash: string
  readonly transactionIndex: number
  readonly schemaUid?: string | undefined
  readonly generationId?: string | undefined
  readonly reasonCode?: string | undefined
  readonly eventType?: 'created' | 'accepted' | 'deleted' | undefined
  readonly accepted?: boolean | undefined
  readonly deletionCause?: BusinessDeletionCause | null | undefined
}

export interface OperationSeed {
  readonly operationId: string
  readonly account: string
  readonly profileId: string
  readonly networkId: number
  readonly transactionType: string
  readonly createdAt: string
  readonly business?: OperationBusinessContext | undefined
}

export type OperationBusinessContext =
  | {
      readonly action: 'schema-register'
      /** Optional only so journals written by the v0.1 alpha remain readable. */
      readonly publisher?: string | undefined
      readonly schemaDigestHex?: string | undefined
      readonly memoByteLength?: number | undefined
    }
  | {
      readonly action: 'credential-issue'
      readonly issuer: string
      readonly subject: string
      readonly schemaUid: string
      /** Optional only so journals written by the v0.1 alpha remain readable. */
      readonly credentialUri?: string | undefined
      readonly payloadDigestHex?: string | undefined
      readonly expiration?: string | undefined
    }
  | {
      readonly action:
        'credential-accept' | 'credential-reject' | 'credential-remove' | 'credential-revoke'
      readonly issuer: string
      readonly subject: string
      readonly schemaUid: string
      /** Exact ledger generation reviewed before this tuple-only native action. */
      readonly generationId: string
      readonly payloadDigestHex?: string | undefined
    }

export interface StoredOperation extends OperationSeed {
  readonly updatedAt: string
  readonly stage: SubmissionJournalStage
  readonly txHash?: string | undefined
  readonly txBlob?: string | undefined
  readonly lastLedgerSequence?: number | undefined
  readonly engineResult?: string | undefined
  readonly ledgerIndex?: number | undefined
  readonly message?: string | undefined
  readonly businessConfirmation?: BusinessConfirmation | undefined
  readonly businessEvidence?: BusinessEvidence | undefined
}

export interface SignedOperationRecord {
  readonly operationId: string
  readonly txBlob: string
  readonly txHash: string
  readonly lastLedgerSequence: number
  readonly at: string
}

export interface OperationReceipt {
  readonly receiptVersion: '0.2'
  readonly operationId: string
  readonly account: string
  readonly profileId: string
  readonly networkId: number
  readonly transactionType: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly stage: SubmissionJournalStage
  readonly business?: OperationBusinessContext | undefined
  readonly txHash?: string | undefined
  readonly lastLedgerSequence?: number | undefined
  readonly engineResult?: string | undefined
  readonly ledgerIndex?: number | undefined
  readonly businessConfirmation?: BusinessConfirmation | undefined
  readonly businessEvidence?: BusinessEvidence | undefined
}

const CREDENTIAL_ACTIONS = new Set([
  'credential-issue',
  'credential-accept',
  'credential-reject',
  'credential-remove',
  'credential-revoke',
])
const TRANSACTION_HASH = /^[0-9a-f]{64}$/i
const REASON_CODE = /^[A-Z0-9_]{1,128}$/
const BUSINESS_DELETION_CAUSES = new Set<BusinessDeletionCause>([
  'issuer_revoked',
  'subject_rejected',
  'subject_removed',
  'expired_cleanup',
  'account_deleted',
  'self_deleted',
])

function isBusinessDeletionCause(input: unknown): input is BusinessDeletionCause {
  return typeof input === 'string' && BUSINESS_DELETION_CAUSES.has(input as BusinessDeletionCause)
}

function optionalDigest(input: unknown, errorCode: string): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || !TRANSACTION_HASH.test(input)) throw new Error(errorCode)
  return input.toLowerCase()
}

function optionalExpiration(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || input.length === 0 || !Number.isFinite(Date.parse(input))) {
    throw new Error('OPERATION_EXPIRATION_INVALID')
  }
  return input
}

export function validateOperationBusinessContext(input: unknown): OperationBusinessContext {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('OPERATION_BUSINESS_CONTEXT_INVALID')
  }
  const candidate = input as Record<string, unknown>
  const action = candidate.action
  if (action === 'schema-register') {
    const publisher = candidate.publisher
    if (
      publisher !== undefined &&
      (typeof publisher !== 'string' || !isValidClassicAddress(publisher))
    ) {
      throw new Error('OPERATION_PUBLISHER_INVALID')
    }
    const schemaDigestHex = optionalDigest(
      candidate.schemaDigestHex,
      'OPERATION_SCHEMA_DIGEST_INVALID',
    )
    const memoByteLength = candidate.memoByteLength
    if (
      memoByteLength !== undefined &&
      (!Number.isSafeInteger(memoByteLength) || (memoByteLength as number) <= 0)
    ) {
      throw new Error('OPERATION_MEMO_BYTE_LENGTH_INVALID')
    }
    return {
      action,
      ...(typeof publisher === 'string' ? { publisher } : {}),
      ...(schemaDigestHex ? { schemaDigestHex } : {}),
      ...(typeof memoByteLength === 'number' ? { memoByteLength } : {}),
    }
  }
  if (typeof action !== 'string' || !CREDENTIAL_ACTIONS.has(action)) {
    throw new Error('OPERATION_ACTION_INVALID')
  }
  if (typeof candidate.issuer !== 'string' || typeof candidate.subject !== 'string') {
    throw new Error('OPERATION_CREDENTIAL_ADDRESS_INVALID')
  }
  if (!isValidClassicAddress(candidate.issuer) || !isValidClassicAddress(candidate.subject)) {
    throw new Error('OPERATION_CREDENTIAL_ADDRESS_INVALID')
  }
  if (typeof candidate.schemaUid !== 'string') throw new Error('OPERATION_SCHEMA_UID_INVALID')
  const schemaUid = candidate.schemaUid.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(schemaUid)) throw new Error('OPERATION_SCHEMA_UID_INVALID')
  const payloadDigestHex = optionalDigest(
    candidate.payloadDigestHex,
    'OPERATION_PAYLOAD_DIGEST_INVALID',
  )
  const generationId =
    typeof candidate.generationId === 'string' ? candidate.generationId.toLowerCase() : undefined
  if (
    action !== 'credential-issue' &&
    (generationId === undefined || !/^[0-9a-f]{64}$/.test(generationId))
  ) {
    throw new Error('OPERATION_GENERATION_ID_INVALID')
  }
  if (action === 'credential-issue') {
    const credentialUri = candidate.credentialUri
    if (credentialUri !== undefined) {
      if (typeof credentialUri !== 'string') throw new Error('OPERATION_CREDENTIAL_URI_INVALID')
      try {
        parsePayloadUri(credentialUri)
      } catch {
        throw new Error('OPERATION_CREDENTIAL_URI_INVALID')
      }
    }
    const expiration = optionalExpiration(candidate.expiration)
    return {
      action,
      issuer: candidate.issuer,
      subject: candidate.subject,
      schemaUid,
      ...(typeof credentialUri === 'string' ? { credentialUri } : {}),
      ...(payloadDigestHex ? { payloadDigestHex } : {}),
      ...(expiration ? { expiration } : {}),
    }
  }
  return {
    action: action as
      'credential-accept' | 'credential-reject' | 'credential-remove' | 'credential-revoke',
    issuer: candidate.issuer,
    subject: candidate.subject,
    schemaUid,
    generationId: generationId!,
    ...(payloadDigestHex ? { payloadDigestHex } : {}),
  }
}

export function isConfirmableBusinessContext(
  input: OperationBusinessContext | undefined,
): input is OperationBusinessContext {
  if (input?.action === 'schema-register') {
    return (
      typeof input.publisher === 'string' &&
      typeof input.schemaDigestHex === 'string' &&
      typeof input.memoByteLength === 'number'
    )
  }
  if (input?.action === 'credential-issue') {
    return typeof input.credentialUri === 'string' && typeof input.payloadDigestHex === 'string'
  }
  return isGenerationBoundBusinessContext(input)
}

/** Stable business key used by the atomic IndexedDB cross-tab exclusion. */
export function operationBusinessKey(
  profileId: string,
  input: OperationBusinessContext | undefined,
): string | undefined {
  if (input?.action === 'schema-register') {
    if (!input.publisher || !input.schemaDigestHex) return undefined
    return `${profileId}|schema-register|${input.publisher}|${input.schemaDigestHex}`
  }
  if (input?.action === 'credential-issue') {
    return `${profileId}|credential|${input.issuer}|${input.subject}|${input.schemaUid}`
  }
  if (isGenerationBoundBusinessContext(input)) {
    return `${profileId}|credential|${input.issuer}|${input.subject}|${input.schemaUid}|${input.generationId}`
  }
  return undefined
}

export function isGenerationBoundBusinessContext(
  input: OperationBusinessContext | undefined,
): input is Extract<
  OperationBusinessContext,
  {
    readonly action:
      'credential-accept' | 'credential-reject' | 'credential-remove' | 'credential-revoke'
  }
> {
  return (
    input?.action === 'credential-accept' ||
    input?.action === 'credential-reject' ||
    input?.action === 'credential-remove' ||
    input?.action === 'credential-revoke'
  )
}

function sanitizeOperationBusinessContext(input: unknown): OperationBusinessContext | undefined {
  try {
    return validateOperationBusinessContext(input)
  } catch {
    return undefined
  }
}

function sanitizeBusinessConfirmation(input: unknown): BusinessConfirmation | undefined {
  return input === 'pending' ||
    input === 'confirmed' ||
    input === 'rejected' ||
    input === 'mismatch' ||
    input === 'timeout'
    ? input
    : undefined
}

export function validateBusinessEvidence(input: unknown): BusinessEvidence {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('OPERATION_BUSINESS_EVIDENCE_INVALID')
  }
  const candidate = input as Record<string, unknown>
  if (
    typeof candidate.transactionHash !== 'string' ||
    !TRANSACTION_HASH.test(candidate.transactionHash)
  ) {
    throw new Error('OPERATION_EVIDENCE_TRANSACTION_HASH_INVALID')
  }
  if (!Number.isSafeInteger(candidate.ledgerIndex) || (candidate.ledgerIndex as number) <= 0) {
    throw new Error('OPERATION_EVIDENCE_LEDGER_INDEX_INVALID')
  }
  if (typeof candidate.ledgerHash !== 'string' || !TRANSACTION_HASH.test(candidate.ledgerHash)) {
    throw new Error('OPERATION_EVIDENCE_LEDGER_HASH_INVALID')
  }
  if (
    !Number.isSafeInteger(candidate.transactionIndex) ||
    (candidate.transactionIndex as number) < 0
  ) {
    throw new Error('OPERATION_EVIDENCE_TRANSACTION_INDEX_INVALID')
  }
  const schemaUid = optionalDigest(candidate.schemaUid, 'OPERATION_EVIDENCE_SCHEMA_UID_INVALID')
  const generationId = optionalDigest(
    candidate.generationId,
    'OPERATION_EVIDENCE_GENERATION_ID_INVALID',
  )
  const reasonCode = candidate.reasonCode
  if (
    reasonCode !== undefined &&
    (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode))
  ) {
    throw new Error('OPERATION_EVIDENCE_REASON_CODE_INVALID')
  }
  const eventType = candidate.eventType
  if (
    eventType !== undefined &&
    eventType !== 'created' &&
    eventType !== 'accepted' &&
    eventType !== 'deleted'
  ) {
    throw new Error('OPERATION_EVIDENCE_EVENT_TYPE_INVALID')
  }
  if (candidate.accepted !== undefined && typeof candidate.accepted !== 'boolean') {
    throw new Error('OPERATION_EVIDENCE_ACCEPTED_INVALID')
  }
  const deletionCause = candidate.deletionCause
  if (
    (eventType === 'deleted' && !isBusinessDeletionCause(deletionCause)) ||
    (eventType !== undefined && eventType !== 'deleted' && deletionCause !== null) ||
    (eventType === undefined && deletionCause !== undefined)
  ) {
    throw new Error('OPERATION_EVIDENCE_DELETION_CAUSE_INVALID')
  }
  return {
    transactionHash: candidate.transactionHash.toLowerCase(),
    ledgerIndex: candidate.ledgerIndex as number,
    ledgerHash: candidate.ledgerHash.toLowerCase(),
    transactionIndex: candidate.transactionIndex as number,
    ...(schemaUid ? { schemaUid } : {}),
    ...(generationId ? { generationId } : {}),
    ...(typeof reasonCode === 'string' ? { reasonCode } : {}),
    ...(eventType ? { eventType } : {}),
    ...(typeof candidate.accepted === 'boolean' ? { accepted: candidate.accepted } : {}),
    ...(eventType !== undefined
      ? { deletionCause: deletionCause as BusinessDeletionCause | null }
      : {}),
  }
}

function sanitizeBusinessEvidence(input: unknown): BusinessEvidence | undefined {
  try {
    return validateBusinessEvidence(input)
  } catch {
    return undefined
  }
}

function evidenceSupportsBusinessResult(
  business: OperationBusinessContext,
  confirmation: 'confirmed' | 'rejected',
  evidence: BusinessEvidence,
  transactionHash: string,
): boolean {
  if (evidence.transactionHash !== transactionHash) return false
  if (business.action === 'schema-register') {
    return confirmation === 'confirmed'
      ? evidence.schemaUid !== undefined && evidence.reasonCode === undefined
      : evidence.reasonCode !== undefined && evidence.schemaUid === undefined
  }
  if (confirmation === 'rejected' || evidence.schemaUid !== business.schemaUid) return false
  const expectedEventType =
    business.action === 'credential-issue'
      ? 'created'
      : business.action === 'credential-accept'
        ? 'accepted'
        : 'deleted'
  const expectedDeletionCause =
    business.action === 'credential-reject'
      ? 'subject_rejected'
      : business.action === 'credential-remove'
        ? business.issuer === business.subject
          ? 'issuer_revoked'
          : 'subject_removed'
        : business.action === 'credential-revoke'
          ? 'issuer_revoked'
          : null
  return (
    evidence.eventType === expectedEventType &&
    (business.action === 'credential-issue'
      ? evidence.accepted === (business.issuer === business.subject)
      : business.action === 'credential-reject'
        ? evidence.accepted === false
        : (business.action !== 'credential-accept' && business.action !== 'credential-remove') ||
          evidence.accepted === true) &&
    (business.action === 'credential-issue'
      ? evidence.generationId === transactionHash
      : evidence.generationId === business.generationId) &&
    evidence.deletionCause === expectedDeletionCause
  )
}

export function operationBusinessConfirmation(
  operation: StoredOperation,
): BusinessConfirmation | undefined {
  const business = sanitizeOperationBusinessContext(operation.business)
  if (!isConfirmableBusinessContext(business)) return undefined
  const confirmation = sanitizeBusinessConfirmation(operation.businessConfirmation) ?? 'pending'
  if (
    confirmation !== 'pending' &&
    (operation.stage !== 'validated' ||
      operation.engineResult !== 'tesSUCCESS' ||
      !Number.isSafeInteger(operation.ledgerIndex) ||
      operation.ledgerIndex! <= 0)
  ) {
    return 'pending'
  }
  if (confirmation === 'confirmed' || confirmation === 'rejected') {
    const evidence = sanitizeBusinessEvidence(operation.businessEvidence)
    const txHash = operation.txHash?.toLowerCase()
    if (
      !evidence ||
      !txHash ||
      evidence.ledgerIndex !== operation.ledgerIndex ||
      !evidenceSupportsBusinessResult(business, confirmation, evidence, txHash)
    ) {
      return 'pending'
    }
  }
  return confirmation
}

export function operationBusinessEvidence(
  operation: StoredOperation,
): BusinessEvidence | undefined {
  const confirmation = operationBusinessConfirmation(operation)
  if (confirmation !== 'confirmed' && confirmation !== 'rejected') return undefined
  const evidence = sanitizeBusinessEvidence(operation.businessEvidence)
  if (
    !evidence ||
    !operation.txHash ||
    evidence.transactionHash !== operation.txHash.toLowerCase()
  ) {
    return undefined
  }
  return evidence
}

/** Creates a portable receipt without signed blobs, payloads, claims or free-form messages. */
export function toSanitizedOperationReceipt(operation: StoredOperation): OperationReceipt {
  const business = sanitizeOperationBusinessContext(operation.business)
  const businessConfirmation = operationBusinessConfirmation(operation)
  const businessEvidence = operationBusinessEvidence(operation)
  return {
    receiptVersion: '0.2',
    operationId: operation.operationId,
    account: operation.account,
    profileId: operation.profileId,
    networkId: operation.networkId,
    transactionType: operation.transactionType,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    stage: operation.stage,
    ...(business ? { business } : {}),
    ...(businessConfirmation ? { businessConfirmation } : {}),
    ...(businessEvidence ? { businessEvidence } : {}),
    ...(operation.txHash ? { txHash: operation.txHash } : {}),
    ...(operation.lastLedgerSequence !== undefined
      ? { lastLedgerSequence: operation.lastLedgerSequence }
      : {}),
    ...(operation.engineResult ? { engineResult: operation.engineResult } : {}),
    ...(operation.ledgerIndex !== undefined ? { ledgerIndex: operation.ledgerIndex } : {}),
  }
}

export function serializeOperationReceipts(
  operations: readonly StoredOperation[],
  exportedAt: string = new Date().toISOString(),
): string {
  return JSON.stringify(
    {
      receiptExportVersion: '0.2',
      exportedAt,
      receipts: operations.map(toSanitizedOperationReceipt),
    },
    null,
    2,
  )
}

export function applyJournalEntry(
  operation: StoredOperation,
  entry: SubmissionJournalEntry,
): StoredOperation {
  if (['validated', 'expired', 'failed'].includes(operation.stage)) return operation
  const terminal = ['validated', 'expired', 'failed'].includes(entry.stage)
  return {
    ...operation,
    updatedAt: entry.at,
    stage: entry.stage,
    txHash: entry.txHash ?? operation.txHash,
    txBlob: terminal ? undefined : operation.txBlob,
    lastLedgerSequence: entry.lastLedgerSequence ?? operation.lastLedgerSequence,
    engineResult: entry.engineResult ?? operation.engineResult,
    ledgerIndex: entry.ledgerIndex ?? operation.ledgerIndex,
    message: entry.message,
  }
}

export function canRetryOperation(operation: StoredOperation): boolean {
  const hasRecoveryMaterial =
    typeof operation.txBlob === 'string' &&
    operation.txBlob.length > 0 &&
    ['signed', 'submitted', 'pending'].includes(operation.stage)
  if (!hasRecoveryMaterial) return false
  if (!['CredentialAccept', 'CredentialDelete'].includes(operation.transactionType)) return true
  try {
    return isGenerationBoundBusinessContext(
      operation.business ? validateOperationBusinessContext(operation.business) : undefined,
    )
  } catch {
    return false
  }
}

export function canReconfirmOperation(operation: StoredOperation): boolean {
  if (
    operation.stage !== 'validated' ||
    operation.engineResult !== 'tesSUCCESS' ||
    typeof operation.txHash !== 'string' ||
    !TRANSACTION_HASH.test(operation.txHash)
  ) {
    return false
  }
  const confirmation = operationBusinessConfirmation(operation)
  if (!confirmation || confirmation === 'confirmed' || confirmation === 'rejected') return false
  try {
    const business = operation.business
      ? validateOperationBusinessContext(operation.business)
      : undefined
    if (!isConfirmableBusinessContext(business)) return false
    if (business.action === 'schema-register') {
      return operation.transactionType === 'Payment' && operation.account === business.publisher
    }
    if (business.action === 'credential-issue') {
      return (
        operation.transactionType === 'CredentialCreate' && operation.account === business.issuer
      )
    }
    if (business.action === 'credential-accept') {
      return (
        operation.transactionType === 'CredentialAccept' && operation.account === business.subject
      )
    }
    if (business.action === 'credential-reject') {
      return (
        operation.transactionType === 'CredentialDelete' && operation.account === business.subject
      )
    }
    if (business.action === 'credential-remove') {
      return (
        operation.transactionType === 'CredentialDelete' && operation.account === business.subject
      )
    }
    return (
      business.action === 'credential-revoke' &&
      operation.transactionType === 'CredentialDelete' &&
      operation.account === business.issuer
    )
  } catch {
    return false
  }
}

export function canAbandonOperation(operation: StoredOperation): boolean {
  return (
    operation.stage === 'prepared' &&
    operation.txHash === undefined &&
    operation.txBlob === undefined
  )
}

function holdsBusinessLock(operation: StoredOperation): boolean {
  if (['prepared', 'signed', 'submitted', 'pending'].includes(operation.stage)) return true
  if (operation.stage !== 'validated' || operation.engineResult !== 'tesSUCCESS') return false
  const confirmation = operationBusinessConfirmation(operation)
  return confirmation === 'pending' || confirmation === 'timeout'
}

export class IndexedDbOperationJournal implements OperationJournal {
  readonly #factory: IDBFactory
  #databasePromise: Promise<IDBDatabase> | undefined

  public constructor(factory: IDBFactory = globalThis.indexedDB) {
    if (!factory) throw new Error('INDEXED_DB_UNAVAILABLE')
    this.#factory = factory
  }

  public async create(seed: OperationSeed): Promise<void> {
    const business = seed.business ? validateOperationBusinessContext(seed.business) : undefined
    if (business && !isConfirmableBusinessContext(business)) {
      throw new Error('OPERATION_BUSINESS_CONTEXT_INCOMPLETE')
    }
    const normalizedSeed = { ...seed, ...(business ? { business } : {}) }
    const database = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readwrite')
      const store = transaction.objectStore(OPERATIONS_STORE)
      const request = store.getAll()
      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_READ_FAILED'))
      request.onsuccess = () => {
        try {
          const existing = request.result as StoredOperation[]
          if (existing.some((operation) => operation.operationId === seed.operationId)) {
            throw new Error('OPERATION_ID_ALREADY_EXISTS')
          }
          const businessKey = operationBusinessKey(seed.profileId, business)
          if (
            businessKey &&
            existing.some((operation) => {
              const existingBusiness = sanitizeOperationBusinessContext(operation.business)
              return (
                holdsBusinessLock(operation) &&
                operationBusinessKey(operation.profileId, existingBusiness) === businessKey
              )
            })
          ) {
            throw new Error('OPERATION_BUSINESS_LOCKED')
          }
          store.put({
            ...normalizedSeed,
            updatedAt: seed.createdAt,
            stage: 'prepared',
            ...(business ? { businessConfirmation: 'pending' as const } : {}),
          })
        } catch (error) {
          transaction.abort()
          reject(error)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_FAILED'))
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_ABORTED'))
    })
  }

  public async persistSigned(record: SignedOperationRecord): Promise<void> {
    const database = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readwrite')
      const store = transaction.objectStore(OPERATIONS_STORE)
      const request = store.getAll()
      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_READ_FAILED'))
      request.onsuccess = () => {
        try {
          const operations = request.result as StoredOperation[]
          const existing = operations.find(
            (operation) => operation.operationId === record.operationId,
          )
          if (!existing) throw new Error('OPERATION_NOT_FOUND')
          if (existing.stage !== 'prepared') throw new Error('OPERATION_LOCK_OWNERSHIP_LOST')
          const business = sanitizeOperationBusinessContext(existing.business)
          const businessKey = operationBusinessKey(existing.profileId, business)
          if (
            businessKey &&
            operations.some(
              (operation) =>
                operation.operationId !== existing.operationId &&
                holdsBusinessLock(operation) &&
                operationBusinessKey(
                  operation.profileId,
                  sanitizeOperationBusinessContext(operation.business),
                ) === businessKey,
            )
          ) {
            throw new Error('OPERATION_LOCK_OWNERSHIP_LOST')
          }
          store.put({
            ...existing,
            updatedAt: record.at,
            stage: 'signed',
            txHash: record.txHash,
            txBlob: record.txBlob,
            lastLedgerSequence: record.lastLedgerSequence,
            message: undefined,
          })
        } catch (error) {
          transaction.abort()
          reject(error)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_FAILED'))
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_ABORTED'))
    })
  }

  public async setBusinessConfirmation(
    operationId: string,
    confirmation: Exclude<BusinessConfirmation, 'pending'>,
    at: string,
    evidence?: BusinessEvidence,
  ): Promise<void> {
    await this.#mutate(operationId, (existing) => {
      if (!existing) throw new Error('OPERATION_NOT_FOUND')
      const business = existing.business
        ? validateOperationBusinessContext(existing.business)
        : undefined
      if (!isConfirmableBusinessContext(business)) {
        throw new Error('OPERATION_BUSINESS_CONTEXT_REQUIRED')
      }
      if (existing.stage !== 'validated' || existing.engineResult !== 'tesSUCCESS') {
        throw new Error('OPERATION_XRPL_SUCCESS_REQUIRED')
      }
      if (!Number.isSafeInteger(existing.ledgerIndex) || existing.ledgerIndex! <= 0) {
        throw new Error('OPERATION_XRPL_LEDGER_INDEX_REQUIRED')
      }
      const normalizedEvidence = evidence ? validateBusinessEvidence(evidence) : undefined
      if ((confirmation === 'confirmed' || confirmation === 'rejected') && !normalizedEvidence) {
        throw new Error('OPERATION_BUSINESS_EVIDENCE_REQUIRED')
      }
      if (
        normalizedEvidence &&
        existing.txHash &&
        normalizedEvidence.transactionHash !== existing.txHash.toLowerCase()
      ) {
        throw new Error('OPERATION_BUSINESS_EVIDENCE_MISMATCH')
      }
      if (normalizedEvidence && normalizedEvidence.ledgerIndex !== existing.ledgerIndex) {
        throw new Error('OPERATION_BUSINESS_EVIDENCE_MISMATCH')
      }
      if (
        normalizedEvidence &&
        (confirmation === 'confirmed' || confirmation === 'rejected') &&
        existing.txHash &&
        !evidenceSupportsBusinessResult(
          business,
          confirmation,
          normalizedEvidence,
          existing.txHash.toLowerCase(),
        )
      ) {
        throw new Error('OPERATION_BUSINESS_EVIDENCE_MISMATCH')
      }
      return {
        ...existing,
        updatedAt: at,
        businessConfirmation: confirmation,
        ...(normalizedEvidence ? { businessEvidence: normalizedEvidence } : {}),
      }
    })
  }

  public async abandon(operationId: string): Promise<void> {
    const database = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readwrite')
      const store = transaction.objectStore(OPERATIONS_STORE)
      const request = store.get(operationId)
      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_READ_FAILED'))
      request.onsuccess = () => {
        try {
          const existing = request.result as StoredOperation | undefined
          if (!existing) throw new Error('OPERATION_NOT_FOUND')
          if (!canAbandonOperation(existing)) throw new Error('OPERATION_ABANDON_NOT_ALLOWED')
          store.delete(operationId)
        } catch (error) {
          transaction.abort()
          reject(error)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_FAILED'))
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_ABORTED'))
    })
  }

  public async append(entry: SubmissionJournalEntry): Promise<void> {
    await this.#mutate(entry.operationId, (existing) => {
      if (!existing) throw new Error('OPERATION_NOT_FOUND')
      return applyJournalEntry(existing, entry)
    })
  }

  public async list(): Promise<StoredOperation[]> {
    const database = await this.#open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readonly')
      const request = transaction.objectStore(OPERATIONS_STORE).getAll()
      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_READ_FAILED'))
      request.onsuccess = () => {
        const operations = (request.result as StoredOperation[]).sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )
        resolve(operations)
      }
    })
  }

  public async assertBusinessLockOwned(operationId: string): Promise<void> {
    const operations = await this.list()
    const existing = operations.find((operation) => operation.operationId === operationId)
    if (!existing || !holdsBusinessLock(existing)) throw new Error('OPERATION_LOCK_OWNERSHIP_LOST')
    const businessKey = operationBusinessKey(
      existing.profileId,
      sanitizeOperationBusinessContext(existing.business),
    )
    if (
      businessKey &&
      operations.some(
        (operation) =>
          operation.operationId !== existing.operationId &&
          holdsBusinessLock(operation) &&
          operationBusinessKey(
            operation.profileId,
            sanitizeOperationBusinessContext(operation.business),
          ) === businessKey,
      )
    ) {
      throw new Error('OPERATION_LOCK_OWNERSHIP_LOST')
    }
  }

  async #mutate(
    operationId: string,
    mutate: (current: StoredOperation | undefined) => StoredOperation,
  ): Promise<void> {
    const database = await this.#open()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OPERATIONS_STORE, 'readwrite')
      const store = transaction.objectStore(OPERATIONS_STORE)
      const request = store.get(operationId)

      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_READ_FAILED'))
      request.onsuccess = () => {
        try {
          store.put(mutate(request.result as StoredOperation | undefined))
        } catch (error) {
          transaction.abort()
          reject(error)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_FAILED'))
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXED_DB_WRITE_ABORTED'))
    })
  }

  #open(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise((resolve, reject) => {
      const request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
          database.createObjectStore(OPERATIONS_STORE, { keyPath: 'operationId' })
        }
      }
      request.onerror = () => reject(request.error ?? new Error('INDEXED_DB_OPEN_FAILED'))
      request.onblocked = () => reject(new Error('INDEXED_DB_OPEN_BLOCKED'))
      request.onsuccess = () => resolve(request.result)
    })
    return this.#databasePromise
  }
}
