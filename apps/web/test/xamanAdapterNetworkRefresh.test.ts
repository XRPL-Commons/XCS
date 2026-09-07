import { decode, Wallet, type CredentialCreate, type Payment } from 'xrpl'
import { XamanAdapter, type NetworkInfo } from 'xrpl-connect'
import { describe, expect, it, vi } from 'vitest'

import { normalizeWalletSignature } from '../app/utils/walletSubmission'

const ACCOUNT = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const TESTNET: NetworkInfo = {
  id: 'testnet',
  name: 'Testnet',
  wss: 'wss://s.altnet.rippletest.net:51233',
  walletConnectId: 'xrpl:1',
}

function connectedAdapter(jwtData: Record<string, unknown>): XamanAdapter {
  const adapter = new XamanAdapter()

  Object.assign(adapter, {
    client: {
      ping: vi.fn().mockResolvedValue({ jwtData }),
    },
    currentAccount: {
      address: ACCOUNT,
      publicKey: undefined,
      network: TESTNET,
    },
  })

  return adapter
}

describe('Xaman live account refresh compatibility', () => {
  it('accepts the numeric-string network id emitted by the Xaman OAuth provider', async () => {
    const adapter = connectedAdapter({
      sub: ACCOUNT,
      network_endpoint: TESTNET.wss,
      network_id: '1',
    })

    await expect(adapter.fetchAccount()).resolves.toEqual({
      address: ACCOUNT,
      publicKey: undefined,
      network: TESTNET,
    })
  })

  it('keeps the already validated network when a later ping only confirms its id', async () => {
    const adapter = connectedAdapter({ sub: ACCOUNT, network_id: 1 })

    await expect(adapter.fetchAccount()).resolves.toMatchObject({ network: TESTNET })
  })

  it("rejects OAuth metadata from a network that contradicts XCS's target", async () => {
    const adapter = connectedAdapter({
      sub: ACCOUNT,
      network_endpoint: 'wss://xrplcluster.com',
      network_id: '0',
    })

    await expect(adapter.fetchAccount()).rejects.toThrow('inconsistent network information')
  })

  it('rejects malformed network ids instead of silently ignoring them', async () => {
    const adapter = connectedAdapter({ sub: ACCOUNT, network_id: '1e0' })

    await expect(adapter.fetchAccount()).rejects.toThrow('invalid network information')
  })
})

describe('Xaman signed payload compatibility', () => {
  it('retries the authoritative payload fetch after a sign-only request resolves', async () => {
    const resolvedPayload = { meta: { resolved: true, signed: true, submit: false } }
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('resolved payload is not readable yet'))
      .mockResolvedValue(resolvedPayload)
    const adapter = new XamanAdapter()
    const fetchResolvedPayload = (
      adapter as unknown as {
        getResolvedPayload: (
          client: { payload: { get: typeof get } },
          uuid: string,
          submit: boolean,
          signal: AbortSignal,
        ) => Promise<unknown>
      }
    ).getResolvedPayload.bind(adapter)

    await expect(
      fetchResolvedPayload(
        { payload: { get } },
        '00000000-0000-4000-8000-000000000000',
        false,
        new AbortController().signal,
      ),
    ).resolves.toBe(resolvedPayload)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('returns a verifiable CredentialCreate blob without submitting through Xaman', async () => {
    const issuer = Wallet.generate()
    const transaction: CredentialCreate = {
      TransactionType: 'CredentialCreate',
      Account: issuer.address,
      Subject: Wallet.generate().address,
      CredentialType: '12'.repeat(32),
      URI: Buffer.from('https://issuer.example/credential.json', 'utf8')
        .toString('hex')
        .toLowerCase(),
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
    }
    const signedTransaction = { ...transaction, LastLedgerSequence: 120 }
    const signed = issuer.sign(signedTransaction)
    const resolvedPayload = {
      meta: {
        resolved: true,
        signed: true,
        submit: false,
        multisign: false,
        signers: [issuer.address],
      },
      payload: { request_json: transaction },
      response: {
        hex: signed.tx_blob,
        txid: signed.hash,
        environment_networkid: 1,
        environment_nodetype: 'TESTNET',
        dispatched_nodetype: null,
        dispatched_to_node: false,
        account: issuer.address,
        multisign_account: null,
      },
    }
    const get = vi.fn().mockResolvedValue(resolvedPayload)
    const createAndSubscribe = vi
      .fn()
      .mockImplementation(
        async (
          _body: unknown,
          callback: (event: {
            data: { opened: boolean; signed: boolean }
            payload: { meta: { app_opened: boolean } }
          }) => unknown,
        ) => ({
          created: {
            uuid: '00000000-0000-4000-8000-000000000000',
            next: { always: 'https://xumm.app/sign/00000000-0000-4000-8000-000000000000' },
          },
          resolved: Promise.resolve(
            callback({
              data: { opened: true, signed: true },
              payload: { meta: { app_opened: true } },
            }),
          ),
          resolve: vi.fn(),
        }),
      )
    const adapter = new XamanAdapter()
    Object.assign(adapter, {
      client: { payload: { createAndSubscribe, get } },
      currentAccount: {
        address: issuer.address,
        publicKey: undefined,
        network: TESTNET,
      },
    })

    const walletResult = await adapter.sign(transaction)
    const normalized = normalizeWalletSignature(walletResult)

    expect(transaction.URI).toMatch(/[a-f]/)
    expect(decode(signed.tx_blob).URI).toBe(transaction.URI?.toUpperCase())
    expect(decode(signed.tx_blob).LastLedgerSequence).toBe(120)
    expect(normalized).toEqual({ hash: signed.hash, txBlob: signed.tx_blob })
    expect(createAndSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        txjson: transaction,
        options: expect.objectContaining({
          submit: false,
          force_network: 'TESTNET',
          signers: [issuer.address],
        }),
      }),
      expect.any(Function),
    )
  })

  it('rejects a valid signature over transaction fields that differ from the request', () => {
    const signer = Wallet.generate()
    const requested: Payment = {
      TransactionType: 'Payment',
      Account: signer.address,
      Destination: Wallet.generate().address,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
    }
    const changed = { ...requested, Amount: '2' } satisfies Payment
    const signed = signer.sign(changed)
    const adapter = new XamanAdapter()
    const validate = (
      adapter as unknown as {
        validateSignedTransactionRequest: (
          requested: Payment,
          signed: ReturnType<typeof decode>,
        ) => void
      }
    ).validateSignedTransactionRequest.bind(adapter)

    expect(() => validate(requested, decode(signed.tx_blob))).toThrow('different fields: Amount')
  })

  it('accepts an inapplicable multisign_account on a valid single-signed transaction', () => {
    const signer = Wallet.generate()
    const transaction: Payment = {
      TransactionType: 'Payment',
      Account: signer.address,
      Destination: Wallet.generate().address,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
    }
    const signed = signer.sign(transaction)
    const adapter = new XamanAdapter()
    const validate = (
      adapter as unknown as {
        validateSignedTransaction: (
          transaction: ReturnType<typeof decode>,
          txBlob: string,
          connectedAccount: string,
          isMultiSign: boolean,
          responseAccount: string,
          responseMultisignAccount: string | null | undefined,
          network: { networkId: number },
        ) => void
      }
    ).validateSignedTransaction.bind(adapter)

    expect(() =>
      validate(
        decode(signed.tx_blob),
        signed.tx_blob,
        signer.address,
        false,
        signer.address,
        undefined,
        { networkId: 1 },
      ),
    ).not.toThrow()
    expect(() =>
      validate(decode(signed.tx_blob), signed.tx_blob, signer.address, false, signer.address, '', {
        networkId: 1,
      }),
    ).not.toThrow()
    expect(() =>
      validate(
        decode(signed.tx_blob),
        signed.tx_blob,
        signer.address,
        false,
        signer.address,
        signer.address,
        { networkId: 1 },
      ),
    ).toThrow('unexpected multi-signing account data')
  })
})
