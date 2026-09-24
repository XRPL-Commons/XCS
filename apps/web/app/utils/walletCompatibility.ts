import { isWalletError, WalletErrorCode, type WalletAdapter } from 'xrpl-connect'

export const XCS_CREDENTIAL_TRANSACTION_TYPES = [
  'CredentialCreate',
  'CredentialAccept',
  'CredentialDelete',
] as const

export type XcsCredentialTransactionType = (typeof XCS_CREDENTIAL_TRANSACTION_TYPES)[number]
export type WalletCredentialSupport = 'supported' | 'raw' | 'unverified'

export interface WalletIdentity {
  readonly id: string
  readonly name?: string | undefined
}

export interface WalletCredentialTransactionErrorDetails {
  readonly walletId: string
  readonly walletName: string
  readonly transactionType: XcsCredentialTransactionType
}

type WalletErrorTranslator = (key: string, parameters?: Record<string, string>) => string

const ERROR_PREFIX = 'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED'
export const OTSU_SIGNING_ACCOUNT_UNAVAILABLE = 'OTSU_SIGNING_ACCOUNT_UNAVAILABLE'
const SAFE_WALLET_ID_PATTERN = /^[a-z0-9-]{1,64}$/u
const CREDENTIAL_TRANSACTION_TYPE_SET = new Set<string>(XCS_CREDENTIAL_TRANSACTION_TYPES)
const WALLET_NAMES: Readonly<Record<string, string>> = {
  crossmark: 'Crossmark',
  gemwallet: 'GemWallet',
  ledger: 'Ledger',
  'metamask-snap': 'MetaMask Snap',
  otsu: 'Otsu',
  walletconnect: 'WalletConnect',
  xaman: 'Xaman',
  xyra: 'Xyra',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeWalletId(value: string): string {
  const normalized = value.trim().toLowerCase()
  return SAFE_WALLET_ID_PATTERN.test(normalized) ? normalized : 'unknown-wallet'
}

function errorMessages(value: unknown): string[] {
  const messages: string[] = []
  const seen = new Set<object>()

  function visit(candidate: unknown, depth: number): void {
    if (depth > 4) return
    if (typeof candidate === 'string') {
      messages.push(candidate)
      return
    }
    if (!isRecord(candidate) || seen.has(candidate)) return
    seen.add(candidate)
    if (typeof candidate.message === 'string') messages.push(candidate.message)
    visit(candidate.originalError, depth + 1)
    visit(candidate.cause, depth + 1)
  }

  visit(value, 0)
  return messages
}

export function isXcsCredentialTransactionType(
  value: unknown,
): value is XcsCredentialTransactionType {
  return typeof value === 'string' && CREDENTIAL_TRANSACTION_TYPE_SET.has(value)
}

/**
 * This is deliberately conservative: `supported` means the wallet has native
 * source-level support, while `unverified` wallets still require a real-device
 * Testnet qualification before release.
 */
export function walletCredentialSupport(walletId: string): WalletCredentialSupport {
  const normalized = safeWalletId(walletId)
  if (normalized === 'gemwallet') return 'raw'
  if (normalized === 'xaman') return 'supported'
  return 'unverified'
}

export function walletDisplayName(walletId: string): string {
  const normalized = safeWalletId(walletId)
  return WALLET_NAMES[normalized] ?? 'Wallet'
}

export function walletCredentialTransactionError(
  wallet: WalletIdentity,
  transactionType: XcsCredentialTransactionType,
  cause?: unknown,
): Error {
  const code = `${ERROR_PREFIX}:${safeWalletId(wallet.id)}:${transactionType}`
  return cause === undefined ? new Error(code) : new Error(code, { cause })
}

/**
 * Some adapters wrap the wallet's original validation error. Map only the
 * exact pre-XLS-70 codec error for the transaction being signed so unrelated
 * wallet failures and user rejections retain their original diagnostics.
 */
export async function normalizeWalletTransactionError(
  error: unknown,
  wallet: WalletAdapter | null | undefined,
  transactionType: unknown,
): Promise<Error> {
  // xrpl-connect rc.2 maps every Otsu error containing "not found" to
  // WALLET_NOT_INSTALLED. Otsu also uses "Account not found" when its
  // persisted public account is no longer present in the unlocked keyring.
  // Prove that the provider is still installed before correcting that false
  // diagnostic; a genuinely missing extension keeps the upstream error.
  if (
    wallet?.id === 'otsu' &&
    isWalletError(error) &&
    error.code === WalletErrorCode.WALLET_NOT_INSTALLED
  ) {
    const installed = await wallet.isAvailable().catch(() => false)
    if (installed) {
      return new Error(OTSU_SIGNING_ACCOUNT_UNAVAILABLE, { cause: error })
    }
  }

  if (wallet && isXcsCredentialTransactionType(transactionType)) {
    const unsupportedMessage = `Invalid field TransactionType: ${transactionType}`
    if (errorMessages(error).some((message) => message.trim() === unsupportedMessage)) {
      return walletCredentialTransactionError(wallet, transactionType, error)
    }
  }
  return error instanceof Error ? error : new Error(String(error))
}

export function parseWalletCredentialTransactionError(
  value: string,
): WalletCredentialTransactionErrorDetails | null {
  const [prefix, walletId, transactionType, ...extra] = value.split(':')
  if (
    prefix !== ERROR_PREFIX ||
    extra.length > 0 ||
    !walletId ||
    !SAFE_WALLET_ID_PATTERN.test(walletId) ||
    !isXcsCredentialTransactionType(transactionType)
  ) {
    return null
  }
  return {
    walletId,
    walletName: walletDisplayName(walletId),
    transactionType,
  }
}

/** Return a user-facing message only for wallet errors XCS can identify exactly. */
export function walletTransactionErrorMessage(
  value: string,
  translate: WalletErrorTranslator,
): string | null {
  if (value === OTSU_SIGNING_ACCOUNT_UNAVAILABLE) {
    return translate('wallet.errors.otsuSigningAccountUnavailable')
  }
  const unsupported = parseWalletCredentialTransactionError(value)
  if (!unsupported) return null
  return translate('wallet.errors.credentialUnsupported', {
    wallet: unsupported.walletName,
    transactionType: unsupported.transactionType,
  })
}
