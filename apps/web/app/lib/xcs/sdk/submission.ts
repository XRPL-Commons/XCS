// Copied from packages/sdk/src/submission.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import {
  decode,
  encode,
  hashes,
  verifySignature,
  type Client,
  type SubmittableTransaction,
} from 'xrpl'

import { XcsSdkError } from './errors.js'

export interface SignerResult {
  /** Uppercase or lowercase XRPL transaction hash. */
  readonly hash: string
  /** Fully signed XRPL binary transaction. */
  readonly txBlob: string
}

/**
 * Wallet integrations implement this interface. XCS deliberately has no seed-based signer.
 */
export interface Signer {
  sign(transaction: Readonly<SubmittableTransaction>): Promise<SignerResult>
}

export type SubmissionJournalStage =
  'prepared' | 'signed' | 'submitted' | 'validated' | 'expired' | 'pending' | 'failed'

export interface SubmissionJournalEntry {
  readonly operationId: string
  readonly at: string
  readonly stage: SubmissionJournalStage
  readonly txHash?: string | undefined
  readonly lastLedgerSequence?: number | undefined
  readonly engineResult?: string | undefined
  readonly ledgerIndex?: number | undefined
  readonly message?: string | undefined
}

export interface OperationJournal {
  append(entry: SubmissionJournalEntry): Promise<void>
}

export class MemoryOperationJournal implements OperationJournal {
  public readonly entries: SubmissionJournalEntry[] = []

  public async append(entry: SubmissionJournalEntry): Promise<void> {
    this.entries.push(entry)
  }
}

export interface PreparedTransaction<T extends SubmittableTransaction = SubmittableTransaction> {
  readonly transaction: T
  readonly lastLedgerSequence: number
}

export interface ValidatedSignature {
  /** Host-generated identifier shared with the operation journal. */
  readonly operationId: string
  /** The exact unsigned fields recovered from the validated signed blob. */
  readonly transaction: Readonly<SubmittableTransaction>
  readonly txBlob: string
  readonly txHash: string
  readonly lastLedgerSequence: number
}

export interface ReliableSubmissionOptions {
  readonly journal: OperationJournal
  readonly operationId?: string | undefined
  readonly failHard?: boolean | undefined
  readonly pollIntervalMs?: number | undefined
  readonly timeoutMs?: number | undefined
  /**
   * Permit the wallet to refresh only LastLedgerSequence before signing.
   * All other non-signature fields remain byte-for-byte bound to the review.
   */
  readonly allowSignerLastLedgerSequenceRefresh?: boolean | undefined
  /**
   * Runs after the signer hash/blob and exact transaction fields have been
   * validated, but before the first submission side effect. Hosts can use this
   * boundary to durably persist recovery material and repeat business guards.
   */
  readonly onValidatedSignature?:
    ((signature: ValidatedSignature) => void | Promise<void>) | undefined
  /**
   * Final online guard executed after recovery material is journaled and
   * immediately before the first submission side effect.
   */
  readonly beforeSubmit?: ((signature: ValidatedSignature) => void | Promise<void>) | undefined
}

export interface TransactionStatus {
  readonly status: 'validated' | 'pending' | 'expired' | 'not_found'
  readonly txHash: string
  readonly lastLedgerSequence?: number | undefined
  readonly ledgerIndex?: number | undefined
  readonly transactionResult?: string | undefined
}

export interface ReliableSubmissionResult extends TransactionStatus {
  readonly operationId: string
  readonly submitEngineResult?: string | undefined
}

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/u
const BLOB_PATTERN = /^(?:[0-9a-fA-F]{2})+$/u
const XRPL_JS_5_MAX_URI_HEX_CHARACTERS = 256

export async function autofillXcsTransaction<T extends SubmittableTransaction>(
  client: Client,
  transaction: T,
): Promise<PreparedTransaction<T>> {
  if (!client.isConnected()) {
    throw new XcsSdkError(
      'XCS_SDK_CLIENT_NOT_CONNECTED',
      'Connect and validate the XRPL client before autofilling a transaction.',
    )
  }
  assertXrplJs5Compatibility(transaction)

  const prepared = await client.autofill(transaction)
  const lastLedgerSequence = prepared.LastLedgerSequence
  const sequence = prepared.Sequence
  if (
    typeof lastLedgerSequence !== 'number' ||
    !Number.isInteger(lastLedgerSequence) ||
    lastLedgerSequence <= 0 ||
    typeof sequence !== 'number' ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    prepared.Fee === undefined
  ) {
    throw new XcsSdkError(
      'XCS_SDK_AUTOFILL_INCOMPLETE',
      'XRPL autofill did not provide Fee, Sequence, and LastLedgerSequence.',
    )
  }

  return {
    transaction: prepared,
    lastLedgerSequence,
  }
}

export async function prepareSignAndSubmit<T extends SubmittableTransaction>(
  client: Client,
  transaction: T,
  signer: Signer,
  options: ReliableSubmissionOptions,
): Promise<ReliableSubmissionResult> {
  const prepared = await autofillXcsTransaction(client, transaction)
  return signPreparedAndSubmit(client, prepared.transaction, signer, options)
}

/**
 * Signs an already-autofilled transaction after the user has reviewed its final
 * Fee, Sequence, and LastLedgerSequence. This is the browser-safe counterpart to
 * prepareSignAndSubmit when the UI must display the exact transaction first.
 */
export async function signPreparedAndSubmit<T extends SubmittableTransaction>(
  client: Client,
  transaction: T,
  signer: Signer,
  options: ReliableSubmissionOptions,
): Promise<ReliableSubmissionResult> {
  if (!client.isConnected()) {
    throw new XcsSdkError(
      'XCS_SDK_CLIENT_NOT_CONNECTED',
      'Connect and validate the XRPL client before signing a transaction.',
    )
  }
  assertXrplJs5Compatibility(transaction)
  const lastLedgerSequence = transaction.LastLedgerSequence
  const sequence = transaction.Sequence
  if (
    typeof lastLedgerSequence !== 'number' ||
    !Number.isInteger(lastLedgerSequence) ||
    lastLedgerSequence <= 0 ||
    typeof sequence !== 'number' ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    transaction.Fee === undefined
  ) {
    throw new XcsSdkError(
      'XCS_SDK_AUTOFILL_INCOMPLETE',
      'Prepared transaction must contain Fee, Sequence, and LastLedgerSequence.',
    )
  }

  const operationId = options.operationId ?? crypto.randomUUID()
  await append(options.journal, {
    operationId,
    stage: 'prepared',
    lastLedgerSequence,
  })

  let signed: SignerResult
  let derivedHash: string
  let signedTransaction: SubmittableTransaction
  let signedLastLedgerSequence = lastLedgerSequence
  try {
    signed = await signer.sign(transaction)
    assertSignerResult(signed)
    derivedHash = hashes.hashSignedTx(signed.txBlob).toUpperCase()
    if (derivedHash !== signed.hash.toUpperCase()) {
      throw new XcsSdkError(
        'XCS_SDK_INVALID_SIGNER_RESULT',
        'Signer transaction hash does not match the signed transaction blob.',
      )
    }
    signedTransaction = assertSignedTransactionMatches(transaction, signed.txBlob, {
      allowLastLedgerSequenceRefresh: options.allowSignerLastLedgerSequenceRefresh,
    })
    signedLastLedgerSequence = signedTransaction.LastLedgerSequence as number
    await options.onValidatedSignature?.({
      operationId,
      transaction: signedTransaction,
      txBlob: signed.txBlob,
      txHash: derivedHash,
      lastLedgerSequence: signedLastLedgerSequence,
    })
  } catch (error) {
    await append(options.journal, {
      operationId,
      stage: 'failed',
      lastLedgerSequence: signedLastLedgerSequence,
      message: 'Wallet signing or pre-submission validation failed.',
    })
    throw error
  }

  return submitSignedTransaction(client, signed.txBlob, {
    ...options,
    operationId,
  })
}

export async function submitSignedTransaction(
  client: Client,
  txBlob: string,
  options: ReliableSubmissionOptions,
): Promise<ReliableSubmissionResult> {
  if (!client.isConnected()) {
    throw new XcsSdkError(
      'XCS_SDK_CLIENT_NOT_CONNECTED',
      'Connect and validate the XRPL client before submitting a transaction.',
    )
  }
  if (!BLOB_PATTERN.test(txBlob)) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'Signed transaction input must be non-empty hexadecimal data.',
    )
  }

  const operationId = options.operationId ?? crypto.randomUUID()
  let decoded: Record<string, unknown>
  let txHash: string
  try {
    decoded = decode(txBlob)
    txHash = hashes.hashSignedTx(txBlob).toUpperCase()
  } catch {
    throw new XcsSdkError('XCS_SDK_INVALID_SIGNED_BLOB', 'Cannot decode signed transaction.')
  }
  assertValidSingleSignature(decoded, txBlob)

  const lastLedgerSequence = asPositiveInteger(decoded.LastLedgerSequence)
  if (lastLedgerSequence === undefined) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'Reliable submission requires a signed transaction with LastLedgerSequence.',
    )
  }

  // Persist the recovery identifiers before the first network side effect.
  await append(options.journal, {
    operationId,
    stage: 'signed',
    txHash,
    lastLedgerSequence,
  })

  if (options.beforeSubmit !== undefined) {
    try {
      await options.beforeSubmit({
        operationId,
        transaction: withoutSignatureFields(decoded) as unknown as SubmittableTransaction,
        txBlob,
        txHash,
        lastLedgerSequence,
      })
    } catch (error) {
      await append(options.journal, {
        operationId,
        stage: 'signed',
        txHash,
        lastLedgerSequence,
        message: 'Final pre-submission validation failed; signed transaction retained for retry.',
      })
      throw error
    }
  }

  let submitEngineResult: string | undefined
  try {
    const response = await client.submit(txBlob, {
      autofill: false,
      failHard: options.failHard ?? false,
    })
    submitEngineResult = readString(response.result, 'engine_result')
    await append(options.journal, {
      operationId,
      stage: 'submitted',
      txHash,
      lastLedgerSequence,
      engineResult: submitEngineResult,
    })
    if (submitEngineResult?.startsWith('tem') === true) {
      await append(options.journal, {
        operationId,
        stage: 'failed',
        txHash,
        lastLedgerSequence,
        engineResult: submitEngineResult,
        message: 'rippled rejected the malformed transaction before relay.',
      })
      return {
        operationId,
        status: 'not_found',
        txHash,
        lastLedgerSequence,
        submitEngineResult,
      }
    }
  } catch {
    // Submission acknowledgement can be lost after rippled accepted the blob. Reconcile by hash.
    await append(options.journal, {
      operationId,
      stage: 'pending',
      txHash,
      lastLedgerSequence,
      message: 'Submission acknowledgement unavailable; reconciling by transaction hash.',
    })
  }

  const status = await waitForTransaction(client, txHash, lastLedgerSequence, options)
  await append(options.journal, {
    operationId,
    stage: status.status === 'not_found' ? 'pending' : status.status,
    txHash,
    lastLedgerSequence,
    ledgerIndex: status.ledgerIndex,
    engineResult: status.transactionResult,
  })

  return { ...status, operationId, submitEngineResult }
}

export async function getTransactionStatus(
  client: Client,
  txHash: string,
  lastLedgerSequence?: number,
): Promise<TransactionStatus> {
  if (!HASH_PATTERN.test(txHash)) {
    throw new XcsSdkError(
      'XCS_SDK_SUBMISSION_FAILED',
      'Transaction hash must be 64 hex characters.',
    )
  }

  try {
    const response = await client.request({
      command: 'tx',
      transaction: txHash.toUpperCase(),
      binary: false,
    })
    const result = response.result as unknown as Record<string, unknown>
    if (result.validated === true) {
      return {
        status: 'validated',
        txHash: txHash.toUpperCase(),
        lastLedgerSequence,
        ledgerIndex: asPositiveInteger(result.ledger_index),
        transactionResult: readTransactionResult(result.meta),
      }
    }

    return { status: 'pending', txHash: txHash.toUpperCase(), lastLedgerSequence }
  } catch (error) {
    if (!isTransactionNotFound(error)) {
      throw error
    }
  }

  if (lastLedgerSequence !== undefined) {
    const currentLedger = await getCurrentLedgerIndex(client)
    if (currentLedger > lastLedgerSequence) {
      return {
        status: 'expired',
        txHash: txHash.toUpperCase(),
        lastLedgerSequence,
      }
    }
  }

  return { status: 'not_found', txHash: txHash.toUpperCase(), lastLedgerSequence }
}

/**
 * Prove that a prepared transaction can still be accepted before attempting a
 * submission. This check deliberately happens at the final online boundary so
 * an offline-reviewed blob is never relayed after its ledger window closed.
 */
export async function assertTransactionNotExpired(
  client: Client,
  lastLedgerSequence: number,
): Promise<number> {
  if (!client.isConnected()) {
    throw new XcsSdkError(
      'XCS_SDK_CLIENT_NOT_CONNECTED',
      'Connect and validate the XRPL client before checking transaction expiry.',
    )
  }
  if (!Number.isInteger(lastLedgerSequence) || lastLedgerSequence <= 0) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'LastLedgerSequence must be a positive integer.',
    )
  }
  const currentLedgerIndex = await getCurrentLedgerIndex(client)
  if (currentLedgerIndex > lastLedgerSequence) {
    throw new XcsSdkError(
      'XCS_SDK_TRANSACTION_EXPIRED',
      'Prepared transaction expired before submission.',
      { currentLedgerIndex, lastLedgerSequence },
    )
  }
  return currentLedgerIndex
}

async function waitForTransaction(
  client: Client,
  txHash: string,
  lastLedgerSequence: number,
  options: ReliableSubmissionOptions,
): Promise<TransactionStatus> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs

  do {
    const status = await getTransactionStatus(client, txHash, lastLedgerSequence)
    if (status.status === 'validated' || status.status === 'expired') {
      return status
    }
    if (Date.now() >= deadline) {
      return { ...status, status: status.status === 'not_found' ? 'pending' : status.status }
    }
    await delay(pollIntervalMs)
  } while (true)
}

async function getCurrentLedgerIndex(client: Client): Promise<number> {
  const response = await client.request({ command: 'ledger_current' })
  const ledgerIndex = response.result.ledger_current_index
  if (
    typeof ledgerIndex !== 'number' ||
    !Number.isInteger(ledgerIndex) ||
    ledgerIndex <= 0 ||
    ledgerIndex > 0xffff_ffff
  ) {
    throw new XcsSdkError(
      'XCS_SDK_LEDGER_CURRENT_INVALID',
      'XRPL ledger_current returned an invalid ledger index.',
    )
  }
  return ledgerIndex
}

async function append(
  journal: OperationJournal,
  entry: Omit<SubmissionJournalEntry, 'at'>,
): Promise<void> {
  const materialized: SubmissionJournalEntry = { ...entry, at: new Date().toISOString() }
  await journal.append(materialized)
}

function assertSignerResult(result: SignerResult): void {
  if (!HASH_PATTERN.test(result.hash) || !BLOB_PATTERN.test(result.txBlob)) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNER_RESULT',
      'Signer must return a 64-character transaction hash and a signed hexadecimal blob.',
    )
  }
}

/**
 * Decode a signed blob and prove that the signer changed no reviewed field.
 * XRPL signature fields are always permitted additions. Callers may explicitly
 * allow a wallet to refresh LastLedgerSequence while every other field remains bound.
 */
export function assertSignedTransactionMatches(
  prepared: Readonly<SubmittableTransaction>,
  txBlob: string,
  options: { readonly allowLastLedgerSequenceRefresh?: boolean | undefined } = {},
): SubmittableTransaction {
  let signed: Record<string, unknown>
  try {
    signed = decode(txBlob)
  } catch {
    throw new XcsSdkError('XCS_SDK_INVALID_SIGNED_BLOB', 'Cannot decode signed transaction.')
  }
  assertValidSingleSignature(signed, txBlob)
  const preparedFields = withoutSignatureFields(prepared as unknown as Record<string, unknown>)
  const signedFields = withoutSignatureFields(signed)
  if (options.allowLastLedgerSequenceRefresh === true) {
    if (asPositiveInteger(signedFields.LastLedgerSequence) === undefined) {
      throw new XcsSdkError(
        'XCS_SDK_INVALID_SIGNED_BLOB',
        'Wallet-refreshed LastLedgerSequence must be a positive integer.',
      )
    }
    delete preparedFields.LastLedgerSequence
    delete signedFields.LastLedgerSequence
  }
  if (
    encode(preparedFields as SubmittableTransaction) !==
    encode(signedFields as SubmittableTransaction)
  ) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNER_RESULT',
      'Signer changed transaction fields that were not explicitly allowed.',
    )
  }
  return withoutSignatureFields(signed) as unknown as SubmittableTransaction
}

function assertValidSingleSignature(signed: Record<string, unknown>, txBlob: string): void {
  if (Object.hasOwn(signed, 'Signers')) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'Multisigned transactions are not supported by the XCS v0.1 submission flow.',
    )
  }
  if (
    typeof signed.SigningPubKey !== 'string' ||
    signed.SigningPubKey.length === 0 ||
    typeof signed.TxnSignature !== 'string' ||
    signed.TxnSignature.length === 0
  ) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'Transaction blob must contain a single XRPL signature.',
    )
  }
  try {
    if (!verifySignature(txBlob)) {
      throw new Error('invalid signature')
    }
  } catch {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_SIGNED_BLOB',
      'Transaction blob contains an invalid XRPL signature.',
    )
  }
}

function assertXrplJs5Compatibility(transaction: Readonly<SubmittableTransaction>): void {
  if (
    transaction.TransactionType === 'CredentialCreate' &&
    typeof transaction.URI === 'string' &&
    transaction.URI.length > XRPL_JS_5_MAX_URI_HEX_CHARACTERS
  ) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_URI',
      'xrpl.js 5.0.0 submission supports at most 128 URI bytes; use a shorter HTTPS URL or an IPFS CID.',
      {
        byteLength: transaction.URI.length / 2,
        protocolMaxByteLength: 256,
        xrplJsMaxByteLength: 128,
      },
    )
  }
}

function withoutSignatureFields(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = { ...input }
  delete result.Signers
  delete result.SigningPubKey
  delete result.TxnSignature
  return result
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function readTransactionResult(meta: unknown): string | undefined {
  if (typeof meta === 'string') return undefined
  return readString(meta, 'TransactionResult')
}

function isTransactionNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>
    if (data.error === 'txnNotFound') return true
  }
  return readString(error, 'message')?.includes('txnNotFound') === true
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
