import { assertSignedTransactionMatches, type SignerResult } from '#xcs/sdk/index.js'
import { deriveAddress, encode, encodeForSigning, hashes, validate } from 'xrpl'
import {
  GemWalletAPI,
  WalletError,
  WalletErrorCode,
  type AccountInfo,
  type Transaction,
} from 'xrpl-connect'
import { isXcsCredentialTransactionType } from './walletCompatibility'

export function requiresGemWalletRawSigning(walletId: string | undefined, type: unknown): boolean {
  return walletId === 'gemwallet' && isXcsCredentialTransactionType(type)
}

/**
 * GemWallet 3.8 cannot decode Credentials, but its public hex-message API signs
 * XRPL signing bytes. Never call this without explicit raw-signing consent.
 * Connection and network checks remain owned by XRPL Connect / useWallet.
 */
export async function signGemWalletCredential(
  transaction: Transaction,
  account: AccountInfo,
): Promise<SignerResult> {
  const prepared = structuredClone(transaction)
  if (!isXcsCredentialTransactionType(prepared.TransactionType)) {
    throw new Error('GEMWALLET_RAW_TRANSACTION_UNSUPPORTED')
  }
  if (account.network.id !== 'testnet') throw new Error('WALLET_TESTNET_REQUIRED')
  if (
    !account.publicKey ||
    !/^(?:02|03|ED)[0-9A-F]{64}$/iu.test(account.publicKey) ||
    deriveAddress(account.publicKey) !== account.address ||
    prepared.Account !== account.address
  ) {
    throw new Error('GEMWALLET_RAW_SIGNER_MISMATCH')
  }
  if (
    prepared.Signers !== undefined ||
    prepared.TxnSignature !== undefined ||
    prepared.SigningPubKey
  ) {
    throw new Error('GEMWALLET_RAW_UNSIGNED_TRANSACTION_REQUIRED')
  }
  if (
    !Number.isSafeInteger(prepared.Sequence) ||
    prepared.Sequence! < 0 ||
    !Number.isSafeInteger(prepared.LastLedgerSequence) ||
    prepared.LastLedgerSequence! <= 0 ||
    prepared.Fee === undefined
  ) {
    throw new Error('GEMWALLET_RAW_PREPARED_TRANSACTION_REQUIRED')
  }
  const unsigned = { ...prepared, SigningPubKey: account.publicKey }
  validate(unsigned)
  // rc.2's adapter.signMessage converts bytes to UTF-8 and drops isHex. Use
  // the official API exported by that same package, not a replacement provider.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error('GemWallet signing timed out. Close its pending request before retrying.'),
        ),
      90_000,
    )
  })
  let response: Awaited<ReturnType<typeof GemWalletAPI.signMessage>>
  try {
    response = await Promise.race([
      GemWalletAPI.signMessage(encodeForSigning(unsigned), true),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
  }
  if (response.type === 'reject' || !response.result?.signedMessage) {
    throw new WalletError(WalletErrorCode.SIGN_REJECTED, 'GemWallet raw signing was rejected.')
  }
  const txBlob = encode({ ...unsigned, TxnSignature: response.result.signedMessage })
  assertSignedTransactionMatches(prepared, txBlob)
  return { txBlob, hash: hashes.hashSignedTx(txBlob) }
}
