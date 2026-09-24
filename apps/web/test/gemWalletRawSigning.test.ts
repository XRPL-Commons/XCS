import { afterEach, describe, expect, it, vi } from 'vitest'
import { decode, ECDSA, encodeForSigning, hashes, verifySignature, Wallet } from 'xrpl'
import { GemWalletAPI, type Transaction } from 'xrpl-connect'
import {
  requiresGemWalletRawSigning,
  signGemWalletCredential,
} from '../app/utils/gemWalletRawSigning'

// Unit-only wallet boundary; live extension qualification is recorded separately.
vi.mock('xrpl-connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('xrpl-connect')>()
  return { ...actual, GemWalletAPI: { ...actual.GemWalletAPI, signMessage: vi.fn() } }
})

function fixture(algorithm = ECDSA.ed25519, type = 'CredentialCreate') {
  const wallet = Wallet.generate(algorithm)
  const peer = Wallet.generate().address
  const account = {
    address: wallet.address,
    publicKey: wallet.publicKey,
    network: { id: 'testnet', name: 'Testnet', wss: 'wss://testnet.xrpl-labs.com' },
  }
  const transaction = {
    TransactionType: type,
    Account: wallet.address,
    CredentialType: 'AB'.repeat(32),
    ...(type === 'CredentialCreate'
      ? { Subject: peer, URI: '68747470733A2F2F6578616D706C652E636F6D' }
      : { Issuer: peer }),
    Fee: '12',
    Sequence: 1,
    LastLedgerSequence: 100,
  } as Transaction
  return { wallet, account, transaction }
}

describe('GemWallet credential raw signing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([ECDSA.ed25519, ECDSA.secp256k1])(
    'assembles real %s signatures for each credential action',
    async (algorithm) => {
      for (const type of ['CredentialCreate', 'CredentialAccept', 'CredentialDelete']) {
        const { wallet, account, transaction } = fixture(algorithm, type)
        const original = structuredClone(transaction)
        const signature = decode(wallet.sign(transaction).tx_blob).TxnSignature as string
        const sign = vi
          .spyOn(GemWalletAPI, 'signMessage')
          .mockResolvedValue({ type: 'response', result: { signedMessage: signature } })
        const result = await signGemWalletCredential(transaction, account)
        expect(sign).toHaveBeenLastCalledWith(
          encodeForSigning({ ...transaction, SigningPubKey: wallet.publicKey }),
          true,
        )
        expect(verifySignature(result.txBlob)).toBe(true)
        expect(result.hash).toBe(hashes.hashSignedTx(result.txBlob))
        expect(transaction).toEqual(original)
      }
    },
  )

  it('rejects another account’s signature', async () => {
    const { account, transaction } = fixture()
    const wrong = Wallet.generate()
    const signature = decode(wrong.sign({ ...transaction, Account: wrong.address }).tx_blob)
      .TxnSignature as string
    vi.spyOn(GemWalletAPI, 'signMessage').mockResolvedValue({
      type: 'response',
      result: { signedMessage: signature },
    })
    await expect(signGemWalletCredential(transaction, account)).rejects.toThrow(
      'invalid XRPL signature',
    )
  })

  it('rejects a signature over changed fields', async () => {
    const { account, transaction, wallet } = fixture()
    const signature = decode(wallet.sign({ ...transaction, Fee: '1000' }).tx_blob)
      .TxnSignature as string
    vi.spyOn(GemWalletAPI, 'signMessage').mockResolvedValue({
      type: 'response',
      result: { signedMessage: signature },
    })
    await expect(signGemWalletCredential(transaction, account)).rejects.toThrow(
      'invalid XRPL signature',
    )
  })

  it('preserves rejection without retrying or falling back', async () => {
    const { account, transaction } = fixture()
    const sign = vi
      .spyOn(GemWalletAPI, 'signMessage')
      .mockResolvedValue({ type: 'reject', result: undefined })
    await expect(signGemWalletCredential(transaction, account)).rejects.toMatchObject({
      code: 'SIGN_REJECTED',
    })
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it('bounds a missing extension response', async () => {
    vi.useFakeTimers()
    const { account, transaction } = fixture()
    vi.spyOn(GemWalletAPI, 'signMessage').mockReturnValue(new Promise(() => {}))
    const rejected = expect(signGemWalletCredential(transaction, account)).rejects.toThrow(
      'timed out',
    )
    await vi.advanceTimersByTimeAsync(90_000)
    await rejected
  })

  it('preserves extension errors rather than labelling them as timeouts', async () => {
    const { account, transaction } = fixture()
    const error = new Error('Wallet is locked')
    vi.spyOn(GemWalletAPI, 'signMessage').mockRejectedValue(error)
    await expect(signGemWalletCredential(transaction, account)).rejects.toBe(error)
  })

  it('rejects invalid identity, network, unprepared and already-signed requests before opening the wallet', async () => {
    const { account, transaction } = fixture()
    const sign = vi.spyOn(GemWalletAPI, 'signMessage')
    await expect(
      signGemWalletCredential(transaction, { ...account, publicKey: Wallet.generate().publicKey }),
    ).rejects.toThrow('SIGNER_MISMATCH')
    await expect(
      signGemWalletCredential(transaction, {
        ...account,
        network: { ...account.network, id: 'mainnet' },
      }),
    ).rejects.toThrow('TESTNET_REQUIRED')
    await expect(
      signGemWalletCredential({ ...transaction, LastLedgerSequence: undefined }, account),
    ).rejects.toThrow('PREPARED_TRANSACTION_REQUIRED')
    await expect(
      signGemWalletCredential({ ...transaction, TxnSignature: 'AB' }, account),
    ).rejects.toThrow('UNSIGNED_TRANSACTION_REQUIRED')
    await expect(
      signGemWalletCredential(
        { ...transaction, TransactionType: 'Payment' } as Transaction,
        account,
      ),
    ).rejects.toThrow('TRANSACTION_UNSUPPORTED')
    expect(sign).not.toHaveBeenCalled()
  })

  it('never routes other wallets or schema Payments through raw signing', () => {
    expect(requiresGemWalletRawSigning('gemwallet', 'CredentialCreate')).toBe(true)
    expect(requiresGemWalletRawSigning('gemwallet', 'Payment')).toBe(false)
    expect(requiresGemWalletRawSigning('otsu', 'CredentialCreate')).toBe(false)
  })
})
