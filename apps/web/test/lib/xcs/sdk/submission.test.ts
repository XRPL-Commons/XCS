// Copied from packages/sdk/test/submission.test.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { decode, encode, hashes, Wallet, type Client, type SubmittableTransaction } from 'xrpl'
import { describe, expect, it, vi } from 'vitest'

import {
  assertTransactionNotExpired,
  autofillXcsTransaction,
  getTransactionStatus,
  MemoryOperationJournal,
  prepareSignAndSubmit,
  signPreparedAndSubmit,
  submitSignedTransaction,
  XcsSdkError,
} from '#xcs/sdk/index.js'

const TEST_WALLET = Wallet.fromEntropy(Uint8Array.from({ length: 16 }, (_, index) => index + 1))
const ACCOUNT = TEST_WALLET.classicAddress
const DESTINATION = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'

function signedBlob(lastLedgerSequence = 50): string {
  return TEST_WALLET.sign({
    TransactionType: 'Payment',
    Account: ACCOUNT,
    Destination: DESTINATION,
    Amount: '1',
    Fee: '12',
    Sequence: 1,
    LastLedgerSequence: lastLedgerSequence,
  }).tx_blob
}

function mockClient(overrides: Record<string, unknown> = {}): Client {
  return {
    isConnected: () => true,
    autofill: vi.fn(async (transaction: SubmittableTransaction) => ({
      ...transaction,
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 50,
    })),
    submit: vi.fn(async () => ({ result: { engine_result: 'tesSUCCESS' } })),
    request: vi.fn(async (request: { command: string }) => {
      if (request.command === 'tx') {
        return {
          result: {
            validated: true,
            ledger_index: 49,
            meta: { TransactionResult: 'tesSUCCESS' },
          },
        }
      }
      return { result: { ledger_current_index: 49 } }
    }),
    ...overrides,
  } as unknown as Client
}

describe('reliable submission', () => {
  it('autofills Fee, Sequence and LastLedgerSequence', async () => {
    const transaction = {
      TransactionType: 'Payment' as const,
      Account: ACCOUNT,
      Destination: DESTINATION,
      Amount: '1',
    }
    const prepared = await autofillXcsTransaction(mockClient(), transaction)
    expect(prepared.lastLedgerSequence).toBe(50)
    expect(prepared.transaction).toMatchObject({ Fee: '12', Sequence: 1, LastLedgerSequence: 50 })
  })

  it('fails clearly above the temporary xrpl.js 5 URI interoperability limit', async () => {
    const base = {
      TransactionType: 'CredentialCreate' as const,
      Account: ACCOUNT,
      Subject: DESTINATION,
      CredentialType: '12'.repeat(32),
    }
    await expect(
      autofillXcsTransaction(mockClient(), { ...base, URI: '61'.repeat(128) }),
    ).resolves.toMatchObject({ lastLedgerSequence: 50 })
    await expect(
      autofillXcsTransaction(mockClient(), { ...base, URI: '61'.repeat(129) }),
    ).rejects.toMatchObject({
      code: 'XCS_SDK_INVALID_URI',
      details: { xrplJsMaxByteLength: 128, protocolMaxByteLength: 256 },
    })
  })

  it('submits a signed blob, reconciles by hash, and journals no blob', async () => {
    const journal = new MemoryOperationJournal()
    const result = await submitSignedTransaction(mockClient(), signedBlob(), {
      journal,
      pollIntervalMs: 1,
      timeoutMs: 10,
      operationId: 'operation-1',
    })

    expect(result).toMatchObject({
      status: 'validated',
      operationId: 'operation-1',
      transactionResult: 'tesSUCCESS',
    })
    expect(journal.entries.map((entry) => entry.stage)).toEqual([
      'signed',
      'submitted',
      'validated',
    ])
    expect(JSON.stringify(journal.entries)).not.toContain(signedBlob())
  })

  it('signs a reviewed prepared transaction without autofilling it again', async () => {
    const blob = signedBlob()
    const autofill = vi.fn()
    const client = mockClient({ autofill })
    const result = await signPreparedAndSubmit(
      client,
      {
        TransactionType: 'Payment',
        Account: ACCOUNT,
        Destination: DESTINATION,
        Amount: '1',
        Fee: '12',
        Sequence: 1,
        LastLedgerSequence: 50,
      },
      {
        sign: async () => ({ txBlob: blob, hash: hashes.hashSignedTx(blob) }),
      },
      { journal: new MemoryOperationJournal(), pollIntervalMs: 1, timeoutMs: 10 },
    )

    expect(result).toMatchObject({ status: 'validated', transactionResult: 'tesSUCCESS' })
    expect(autofill).not.toHaveBeenCalled()
  })

  it('accepts an explicitly allowed LastLedgerSequence refresh and tracks the signed value', async () => {
    const journal = new MemoryOperationJournal()
    const blob = signedBlob(75)
    const onValidatedSignature = vi.fn()
    const result = await signPreparedAndSubmit(
      mockClient(),
      {
        TransactionType: 'Payment',
        Account: ACCOUNT,
        Destination: DESTINATION,
        Amount: '1',
        Fee: '12',
        Sequence: 1,
        LastLedgerSequence: 50,
      },
      {
        sign: async () => ({ txBlob: blob, hash: hashes.hashSignedTx(blob) }),
      },
      {
        journal,
        pollIntervalMs: 1,
        timeoutMs: 10,
        allowSignerLastLedgerSequenceRefresh: true,
        onValidatedSignature,
      },
    )

    expect(result).toMatchObject({ status: 'validated', lastLedgerSequence: 75 })
    expect(onValidatedSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: expect.objectContaining({ LastLedgerSequence: 75 }),
        lastLedgerSequence: 75,
      }),
    )
    expect(
      journal.entries.map(({ stage, lastLedgerSequence }) => [stage, lastLedgerSequence]),
    ).toEqual([
      ['prepared', 50],
      ['signed', 75],
      ['submitted', 75],
      ['validated', 75],
    ])
  })

  it('rejects a LastLedgerSequence refresh unless the caller explicitly allows it', async () => {
    const blob = signedBlob(75)
    const submit = vi.fn()

    await expect(
      signPreparedAndSubmit(
        mockClient({ submit }),
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: '1',
          Fee: '12',
          Sequence: 1,
          LastLedgerSequence: 50,
        },
        { sign: async () => ({ txBlob: blob, hash: hashes.hashSignedTx(blob) }) },
        { journal: new MemoryOperationJournal() },
      ),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNER_RESULT' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('runs the validated-signature hook after exact comparison and before submit', async () => {
    const calls: string[] = []
    const blob = signedBlob()
    const prepared = {
      TransactionType: 'Payment' as const,
      Account: ACCOUNT,
      Destination: DESTINATION,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 50,
    }
    const client = mockClient({
      submit: vi.fn(async () => {
        calls.push('submit')
        return { result: { engine_result: 'tesSUCCESS' } }
      }),
    })

    await signPreparedAndSubmit(
      client,
      prepared,
      { sign: async () => ({ txBlob: blob, hash: hashes.hashSignedTx(blob) }) },
      {
        journal: new MemoryOperationJournal(),
        pollIntervalMs: 1,
        timeoutMs: 10,
        onValidatedSignature: async (signature) => {
          calls.push('persist')
          expect(signature).toMatchObject({
            txBlob: blob,
            txHash: hashes.hashSignedTx(blob),
            lastLedgerSequence: 50,
          })
        },
        beforeSubmit: async (signature) => {
          calls.push('guard')
          expect(signature.transaction).toEqual(prepared)
        },
      },
    )

    expect(calls).toEqual(['persist', 'guard', 'submit'])
  })

  it('keeps a validated signed transaction recoverable when the final guard fails', async () => {
    const journal = new MemoryOperationJournal()
    const blob = signedBlob()
    const submit = vi.fn()

    await expect(
      signPreparedAndSubmit(
        mockClient({ submit }),
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: '1',
          Fee: '12',
          Sequence: 1,
          LastLedgerSequence: 50,
        },
        { sign: async () => ({ txBlob: blob, hash: hashes.hashSignedTx(blob) }) },
        {
          journal,
          beforeSubmit: async () => {
            throw new Error('READINESS_UNAVAILABLE')
          },
        },
      ),
    ).rejects.toThrow('READINESS_UNAVAILABLE')

    expect(submit).not.toHaveBeenCalled()
    expect(journal.entries.at(-1)).toMatchObject({
      stage: 'signed',
      txHash: hashes.hashSignedTx(blob),
      message: 'Final pre-submission validation failed; signed transaction retained for retry.',
    })
  })

  it('still reconciles after an ambiguous submit acknowledgement failure', async () => {
    const journal = new MemoryOperationJournal()
    const client = mockClient({
      submit: vi.fn(async () => Promise.reject(new Error('socket lost'))),
    })
    const result = await submitSignedTransaction(client, signedBlob(), {
      journal,
      pollIntervalMs: 1,
      timeoutMs: 10,
    })

    expect(result.status).toBe('validated')
    expect(journal.entries.map((entry) => entry.stage)).toEqual(['signed', 'pending', 'validated'])
  })

  it('does not poll a transaction rejected as malformed', async () => {
    const journal = new MemoryOperationJournal()
    const request = vi.fn()
    const client = mockClient({
      submit: vi.fn(async () => ({ result: { engine_result: 'temMALFORMED' } })),
      request,
    })
    const result = await submitSignedTransaction(client, signedBlob(), {
      journal,
      pollIntervalMs: 1,
      timeoutMs: 10,
    })

    expect(result).toMatchObject({ status: 'not_found', submitEngineResult: 'temMALFORMED' })
    expect(journal.entries.map((entry) => entry.stage)).toEqual(['signed', 'submitted', 'failed'])
    expect(request).not.toHaveBeenCalled()
  })

  it('reports expiration only after the last ledger sequence passes', async () => {
    const notFound = Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound' } })
    const client = mockClient({
      request: vi
        .fn()
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({ result: { ledger_current_index: 51 } }),
    })

    await expect(getTransactionStatus(client, 'AB'.repeat(32), 50)).resolves.toMatchObject({
      status: 'expired',
    })
  })

  it('rejects an expired prepared transaction before any submit side effect', async () => {
    const submit = vi.fn()
    const client = mockClient({
      submit,
      request: vi.fn(async () => ({ result: { ledger_current_index: 51 } })),
    })

    await expect(assertTransactionNotExpired(client, 50)).rejects.toMatchObject({
      code: 'XCS_SDK_TRANSACTION_EXPIRED',
      details: { currentLedgerIndex: 51, lastLedgerSequence: 50 },
    })
    expect(submit).not.toHaveBeenCalled()
  })

  it('fails closed when ledger_current omits or corrupts its ledger index', async () => {
    for (const ledger_current_index of [undefined, Number.NaN, 0, 1.5, 0x1_0000_0000]) {
      const client = mockClient({
        request: vi.fn(async () => ({ result: { ledger_current_index } })),
      })

      await expect(assertTransactionNotExpired(client, 50)).rejects.toMatchObject({
        code: 'XCS_SDK_LEDGER_CURRENT_INVALID',
      })
    }
  })

  it('rejects unsigned and cryptographically invalid blobs before submission', async () => {
    const unsigned = encode({
      TransactionType: 'Payment',
      Account: ACCOUNT,
      Destination: DESTINATION,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 50,
      SigningPubKey: '',
    })
    const decoded = decode(signedBlob())
    const signature = decoded.TxnSignature as string
    const invalidSignature = encode({
      ...decoded,
      TxnSignature: `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`,
    } as unknown as SubmittableTransaction)
    const submit = vi.fn()

    await expect(
      submitSignedTransaction(mockClient({ submit }), unsigned, {
        journal: new MemoryOperationJournal(),
      }),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNED_BLOB' })
    await expect(
      submitSignedTransaction(mockClient({ submit }), invalidSignature, {
        journal: new MemoryOperationJournal(),
      }),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNED_BLOB' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('rejects incomplete autofill and mismatched signer hashes', async () => {
    const incomplete = mockClient({ autofill: vi.fn(async (transaction) => transaction) })
    await expect(
      autofillXcsTransaction(incomplete, {
        TransactionType: 'Payment',
        Account: ACCOUNT,
        Destination: DESTINATION,
        Amount: '1',
      }),
    ).rejects.toBeInstanceOf(XcsSdkError)

    const blob = signedBlob()
    await expect(
      prepareSignAndSubmit(
        mockClient(),
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: '1',
        },
        { sign: async () => ({ txBlob: blob, hash: 'FF'.repeat(32) }) },
        { journal: new MemoryOperationJournal() },
      ),
    ).rejects.toBeInstanceOf(XcsSdkError)

    expect(hashes.hashSignedTx(blob)).toMatch(/^[A-F0-9]{64}$/u)
  })

  it('rejects a correctly hashed blob when the signer changed transaction fields', async () => {
    const changedBlob = TEST_WALLET.sign({
      TransactionType: 'Payment',
      Account: ACCOUNT,
      Destination: ACCOUNT,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 50,
      Flags: 0,
    }).tx_blob
    const onValidatedSignature = vi.fn()
    const submit = vi.fn()
    await expect(
      prepareSignAndSubmit(
        mockClient({ submit }),
        {
          TransactionType: 'Payment',
          Account: ACCOUNT,
          Destination: DESTINATION,
          Amount: '1',
        },
        {
          sign: async () => ({
            txBlob: changedBlob,
            hash: hashes.hashSignedTx(changedBlob),
          }),
        },
        {
          journal: new MemoryOperationJournal(),
          onValidatedSignature,
          allowSignerLastLedgerSequenceRefresh: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNER_RESULT' })
    expect(onValidatedSignature).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})
