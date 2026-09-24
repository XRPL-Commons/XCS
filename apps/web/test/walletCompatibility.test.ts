import { CrossmarkAdapter, OtsuAdapter, WalletError, WalletErrorCode } from 'xrpl-connect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  normalizeWalletTransactionError,
  OTSU_SIGNING_ACCOUNT_UNAVAILABLE,
  parseWalletCredentialTransactionError,
  walletCredentialSupport,
} from '../app/utils/walletCompatibility'

const crossmark = new CrossmarkAdapter()

describe('wallet Credential transaction compatibility', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not claim that unqualified adapters have native Credential support', () => {
    expect(walletCredentialSupport('xaman')).toBe('supported')
    expect(walletCredentialSupport('gemwallet')).toBe('raw')
    expect(walletCredentialSupport('crossmark')).toBe('unverified')
  })

  it('maps the exact nested pre-Credentials codec error to an actionable stable code', async () => {
    const original = new Error('Invalid field TransactionType: CredentialCreate')
    const wrapped = Object.assign(new Error('Failed to sign transaction.'), {
      originalError: original,
    })

    const normalized = await normalizeWalletTransactionError(wrapped, crossmark, 'CredentialCreate')

    expect(normalized.message).toBe(
      'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED:crossmark:CredentialCreate',
    )
    expect(normalized.cause).toBe(wrapped)
  })

  it('preserves unrelated wallet errors and transaction types', async () => {
    const rejected = new Error('User rejected the request')
    const broaderDiagnostic = new Error(
      'Retry failed after Invalid field TransactionType: CredentialCreate while loading the account',
    )

    await expect(
      normalizeWalletTransactionError(rejected, crossmark, 'CredentialCreate'),
    ).resolves.toBe(rejected)
    await expect(
      normalizeWalletTransactionError(broaderDiagnostic, crossmark, 'CredentialCreate'),
    ).resolves.toBe(broaderDiagnostic)
    expect(
      (
        await normalizeWalletTransactionError(
          new Error('Invalid field TransactionType: CredentialCreate'),
          crossmark,
          'Payment',
        )
      ).message,
    ).toBe('Invalid field TransactionType: CredentialCreate')
  })

  it('distinguishes an installed Otsu signing-account failure from a missing extension', async () => {
    const otsu = new OtsuAdapter()
    const original = new WalletError(
      WalletErrorCode.WALLET_NOT_INSTALLED,
      'Otsu Wallet is not installed',
    )
    vi.stubGlobal('window', { xrpl: { isOtsu: true } })
    await expect(
      normalizeWalletTransactionError(original, otsu, 'CredentialCreate'),
    ).resolves.toMatchObject({
      message: OTSU_SIGNING_ACCOUNT_UNAVAILABLE,
      cause: original,
    })
    vi.stubGlobal('window', { xrpl: {} })
    await expect(normalizeWalletTransactionError(original, otsu, 'CredentialCreate')).resolves.toBe(
      original,
    )
  })

  it('parses only complete, safe compatibility codes for localized display', () => {
    expect(
      parseWalletCredentialTransactionError(
        'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED:gemwallet:CredentialDelete',
      ),
    ).toEqual({
      walletId: 'gemwallet',
      walletName: 'GemWallet',
      transactionType: 'CredentialDelete',
    })
    expect(
      parseWalletCredentialTransactionError(
        'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED:gemwallet:Payment',
      ),
    ).toBeNull()
    expect(
      parseWalletCredentialTransactionError(
        'WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED:<script>:CredentialCreate',
      ),
    ).toBeNull()
  })
})
