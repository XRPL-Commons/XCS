import type { ReliableSubmissionResult, Signer, SignerResult } from '#xcs/sdk/index.js'
import { decode, encode, hashes, verifySignature } from 'xrpl'
import type { SignedTransaction, Transaction } from 'xrpl-connect'

interface WalletSignOnly {
  sign(transaction: Transaction): Promise<SignedTransaction>
}

const HASH_PATTERN = /^[0-9A-F]{64}$/u

export interface StoredRecoveryMaterial {
  readonly txBlob: string
  readonly txHash: string
  readonly lastLedgerSequence: number
  readonly account: string
  readonly transactionType: string
  readonly networkId: number
}

/**
 * Xaman may autofill LastLedgerSequence while signing. Do not ask it to retain
 * an application-filled value that its signing service is documented to own;
 * XCS still validates the returned blob and permits only that field to change.
 */
export function transactionForWalletSigning(
  transaction: Transaction,
  walletId: string | undefined,
): Transaction {
  if (walletId !== 'xaman' || transaction.LastLedgerSequence === undefined) return transaction
  const { LastLedgerSequence: _lastLedgerSequence, ...request } = transaction
  return request as Transaction
}

/**
 * Treat persisted browser recovery state as untrusted input before it can
 * influence terminal reconciliation or create a new XRPL side effect.
 */
export function validateStoredRecoveryMaterial(material: StoredRecoveryMaterial): void {
  let decoded: Record<string, unknown>
  let derivedHash: string
  try {
    decoded = decode(material.txBlob)
    derivedHash = hashes.hashSignedTx(material.txBlob).toUpperCase()
    if (
      Object.hasOwn(decoded, 'Signers') ||
      typeof decoded.SigningPubKey !== 'string' ||
      decoded.SigningPubKey.length === 0 ||
      typeof decoded.TxnSignature !== 'string' ||
      decoded.TxnSignature.length === 0 ||
      !verifySignature(material.txBlob)
    ) {
      throw new Error('invalid single signature')
    }
  } catch {
    throw new Error('OPERATION_RECOVERY_BLOB_INVALID')
  }

  if (!HASH_PATTERN.test(material.txHash) || derivedHash !== material.txHash) {
    throw new Error('OPERATION_RECOVERY_HASH_MISMATCH')
  }

  const decodedLastLedgerSequence = decoded.LastLedgerSequence
  if (
    !Number.isSafeInteger(material.lastLedgerSequence) ||
    material.lastLedgerSequence <= 0 ||
    !Number.isSafeInteger(decodedLastLedgerSequence) ||
    (decodedLastLedgerSequence as number) <= 0
  ) {
    throw new Error('OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_INVALID')
  }
  if (decodedLastLedgerSequence !== material.lastLedgerSequence) {
    throw new Error('OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_MISMATCH')
  }
  if (decoded.Account !== material.account) {
    throw new Error('OPERATION_RECOVERY_ACCOUNT_MISMATCH')
  }
  if (decoded.TransactionType !== material.transactionType) {
    throw new Error('OPERATION_RECOVERY_TRANSACTION_TYPE_MISMATCH')
  }
  if (decoded.NetworkID !== undefined && decoded.NetworkID !== material.networkId) {
    throw new Error('OPERATION_RECOVERY_NETWORK_ID_MISMATCH')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeAssertedHash(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new Error('WALLET_SIGNED_HASH_INVALID')
  const normalized = value.trim().toUpperCase()
  if (!HASH_PATTERN.test(normalized)) throw new Error('WALLET_SIGNED_HASH_INVALID')
  return normalized
}

/**
 * Normalize every XRPL Connect sign-only result into the complete signed blob
 * required by the XCS SDK. Most adapters return `tx_blob`; WalletConnect 1.0
 * returns signed `tx_json`, which is encoded locally before the same validation
 * and application-owned submission pipeline is used.
 */
export function normalizeWalletSignature(signed: SignedTransaction): SignerResult {
  if (signed.tx_blob !== undefined && typeof signed.tx_blob !== 'string') {
    throw new Error('WALLET_SIGNED_BLOB_INVALID')
  }
  const suppliedBlob = typeof signed.tx_blob === 'string' ? signed.tx_blob.trim() : ''

  let encodedJson = ''
  let jsonHash = ''
  if (signed.tx_json !== undefined) {
    if (!isRecord(signed.tx_json)) throw new Error('WALLET_SIGNED_JSON_INVALID')
    const txJson = { ...signed.tx_json }
    jsonHash = normalizeAssertedHash(txJson.hash)
    delete txJson.hash
    try {
      encodedJson = encode(txJson)
      if (encodedJson.length === 0) throw new Error('empty signed transaction')
    } catch {
      throw new Error('WALLET_SIGNED_JSON_INVALID')
    }
  }

  if (suppliedBlob.length === 0 && encodedJson.length === 0) {
    throw new Error('WALLET_SIGNED_BLOB_MISSING')
  }
  if (
    suppliedBlob.length > 0 &&
    encodedJson.length > 0 &&
    suppliedBlob.toUpperCase() !== encodedJson.toUpperCase()
  ) {
    throw new Error('WALLET_SIGNED_ARTIFACT_MISMATCH')
  }
  const txBlob = suppliedBlob || encodedJson

  let decoded: Record<string, unknown>
  let derivedHash: string
  try {
    decoded = decode(txBlob)
    derivedHash = hashes.hashSignedTx(txBlob).toUpperCase()
  } catch {
    throw new Error('WALLET_SIGNED_BLOB_INVALID')
  }

  for (const suppliedHash of [normalizeAssertedHash(signed.hash), jsonHash]) {
    if (suppliedHash.length > 0 && suppliedHash !== derivedHash) {
      throw new Error('WALLET_SIGNED_HASH_MISMATCH')
    }
  }

  if (signed.signature !== undefined) {
    if (
      typeof signed.signature !== 'string' ||
      typeof decoded.TxnSignature !== 'string' ||
      signed.signature.trim().toUpperCase() !== decoded.TxnSignature.toUpperCase()
    ) {
      throw new Error('WALLET_SIGNED_SIGNATURE_MISMATCH')
    }
  }

  if (signed.signerAddress !== undefined) {
    if (
      typeof signed.signerAddress !== 'string' ||
      signed.signerAddress.trim() !== decoded.Account
    ) {
      throw new Error('WALLET_SIGNER_ADDRESS_MISMATCH')
    }
  }

  return { hash: derivedHash, txBlob }
}

/** Adapts a sign-only browser wallet without persisting unverified output. */
export function createWalletSigner(wallet: WalletSignOnly): Signer {
  return {
    async sign(transaction) {
      const signed = await wallet.sign(transaction as Transaction)
      return normalizeWalletSignature(signed)
    },
  }
}

export function assertValidatedTesSuccess(result: ReliableSubmissionResult): void {
  if (result.status !== 'validated') {
    throw new Error(`TRANSACTION_${result.status.toUpperCase()}:${result.txHash}`)
  }
  if (result.transactionResult !== 'tesSUCCESS') {
    throw new Error(`TRANSACTION_FAILED:${result.transactionResult ?? 'UNKNOWN'}`)
  }
  if (!Number.isSafeInteger(result.ledgerIndex) || (result.ledgerIndex as number) <= 0) {
    throw new Error('TRANSACTION_LEDGER_INDEX_INVALID')
  }
}
