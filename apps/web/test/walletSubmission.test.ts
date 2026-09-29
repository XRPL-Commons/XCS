import { createHttpsPayloadUri } from '#xcs/core/index.js'
import {
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
  signPreparedAndSubmit,
  type OperationJournal,
  type ReliableSubmissionResult,
  type SubmissionJournalEntry,
} from '#xcs/sdk/index.js'
import {
  decode,
  encode,
  hashes,
  Wallet,
  type Client,
  type Payment,
  type SubmittableTransaction,
} from 'xrpl'
import { describe, expect, it, vi } from 'vitest'

import {
  assertCredentialAcceptanceReviewCurrent,
  createIssuerTrustAcknowledgementToken,
  type CredentialReview,
} from '../app/utils/credentialReview'
import {
  applyJournalEntry,
  canAbandonOperation,
  canRetryOperation,
  completeOperationPublication,
  operationBusinessKey,
  operationConflictsWith,
  serializeOperationReceipts,
  toSanitizedOperationReceipt,
  validateOperationBusinessContext,
  type StoredOperation,
} from '../app/utils/operationJournal'
import {
  assertValidatedTesSuccess,
  createWalletSigner,
  normalizeWalletSignature,
  validateStoredRecoveryMaterial,
} from '../app/utils/walletSubmission'

function signedPayment() {
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
  return { transaction, signed: signer.sign(transaction) }
}

function storedOperation(overrides: Partial<StoredOperation> = {}): StoredOperation {
  return {
    operationId: 'operation-1',
    account: Wallet.generate().address,
    profileId: 'xrpl-testnet-xcs-v0.1',
    networkId: 1,
    transactionType: 'Payment',
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    stage: 'prepared',
    ...overrides,
  }
}

describe('wallet sign-only normalization', () => {
  it('releases the business lock when a fresh wallet signature expires before persistence or relay', async () => {
    const wallet = Wallet.generate()
    const subject = Wallet.generate().address
    const schemaUid = '12'.repeat(32)
    const transaction = {
      TransactionType: 'CredentialCreate' as const,
      Account: wallet.address,
      Subject: subject,
      CredentialType: schemaUid,
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
    }
    const signed = wallet.sign(transaction)
    const initial = storedOperation({
      account: wallet.address,
      transactionType: 'CredentialCreate',
      business: { action: 'credential-issue', issuer: wallet.address, subject, schemaUid },
    })
    const entries: SubmissionJournalEntry[] = []
    const submit = vi.fn()
    const persist = vi.fn()
    await expect(
      signPreparedAndSubmit(
        {
          isConnected: () => true,
          submit,
          request: async () => ({ result: { ledger_current_index: 101 } }),
        } as unknown as Client,
        transaction,
        createWalletSigner({ sign: async () => ({ hash: '', tx_blob: signed.tx_blob }) }),
        {
          journal: {
            append: async (entry) => {
              entries.push(entry)
            },
          },
          onValidatedSignature: persist,
        },
      ),
    ).rejects.toMatchObject({ code: 'XCS_SDK_TRANSACTION_EXPIRED' })
    const failed = entries.reduce(applyJournalEntry, initial)
    expect(failed.stage).toBe('failed')
    expect(failed.txBlob).toBeUndefined()
    expect(failed.txHash).toBeUndefined()
    expect(persist).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(operationConflictsWith(initial, { ...initial, operationId: 'fresh-review' })).toBe(true)
    expect(operationConflictsWith(failed, { ...initial, operationId: 'fresh-review' })).toBe(false)
  })

  it('derives the XRPL hash when the wallet returns an empty hash', () => {
    const { signed } = signedPayment()
    const normalized = normalizeWalletSignature({ hash: '', tx_blob: signed.tx_blob })

    expect(normalized.hash).toBe(hashes.hashSignedTx(signed.tx_blob).toUpperCase())
    expect(normalized.txBlob).toBe(signed.tx_blob)
  })

  it('accepts a matching wallet hash regardless of case', () => {
    const { signed } = signedPayment()
    const normalized = normalizeWalletSignature({
      hash: signed.hash.toLowerCase(),
      tx_blob: signed.tx_blob,
    })

    expect(normalized.hash).toBe(signed.hash.toUpperCase())
  })

  it('rejects a non-empty wallet hash that does not match the signed blob', () => {
    const { signed } = signedPayment()
    expect(() =>
      normalizeWalletSignature({ hash: '0'.repeat(64), tx_blob: signed.tx_blob }),
    ).toThrow('WALLET_SIGNED_HASH_MISMATCH')
  })

  it('requires a complete signed blob', () => {
    expect(() => normalizeWalletSignature({ hash: '' })).toThrow('WALLET_SIGNED_BLOB_MISSING')
  })

  it('encodes a WalletConnect-style signed transaction JSON', () => {
    const { signed } = signedPayment()
    const txJson = { ...decode(signed.tx_blob), hash: signed.hash }
    const normalized = normalizeWalletSignature({
      hash: '',
      tx_json: txJson as unknown as SubmittableTransaction,
    })

    expect(normalized.hash).toBe(signed.hash.toUpperCase())
    expect(normalized.txBlob).toBe(signed.tx_blob)
  })

  it('accepts matching signed blob and signed transaction JSON artifacts', () => {
    const { signed } = signedPayment()
    const decoded = decode(signed.tx_blob)
    const normalized = normalizeWalletSignature({
      hash: signed.hash,
      tx_blob: signed.tx_blob,
      tx_json: decoded,
      signature: String(decoded.TxnSignature),
      signerAddress: String(decoded.Account),
    })

    expect(normalized.txBlob).toBe(signed.tx_blob)
  })

  it('rejects conflicting signed blob and transaction JSON artifacts', () => {
    const { signed } = signedPayment()
    const changedJson = { ...decode(signed.tx_blob), Amount: '2' }

    expect(() =>
      normalizeWalletSignature({
        hash: signed.hash,
        tx_blob: signed.tx_blob,
        tx_json: changedJson,
      }),
    ).toThrow('WALLET_SIGNED_ARTIFACT_MISMATCH')
  })

  it('rejects a transaction JSON hash that differs from the encoded transaction', () => {
    const { signed } = signedPayment()
    const txJson = { ...decode(signed.tx_blob), hash: '0'.repeat(64) }

    expect(() =>
      normalizeWalletSignature({
        hash: '',
        tx_json: txJson as unknown as SubmittableTransaction,
      }),
    ).toThrow('WALLET_SIGNED_HASH_MISMATCH')
  })

  it('rejects signature and signer assertions that differ from the signed transaction', () => {
    const { signed } = signedPayment()

    expect(() =>
      normalizeWalletSignature({
        hash: signed.hash,
        tx_blob: signed.tx_blob,
        signature: '00',
      }),
    ).toThrow('WALLET_SIGNED_SIGNATURE_MISMATCH')
    expect(() =>
      normalizeWalletSignature({
        hash: signed.hash,
        tx_blob: signed.tx_blob,
        signerAddress: Wallet.generate().address,
      }),
    ).toThrow('WALLET_SIGNER_ADDRESS_MISMATCH')
  })

  it('rejects malformed signed transaction JSON', () => {
    expect(() =>
      normalizeWalletSignature({
        hash: '',
        tx_json: [] as unknown as SubmittableTransaction,
      }),
    ).toThrow('WALLET_SIGNED_JSON_INVALID')
    expect(() =>
      normalizeWalletSignature({
        hash: '',
        tx_json: { unsupportedField: true } as unknown as SubmittableTransaction,
      }),
    ).toThrow('WALLET_SIGNED_JSON_INVALID')
  })

  it('normalizes real xrpl.js blobs for every native XCS credential transaction', () => {
    const issuer = Wallet.generate()
    const subject = Wallet.generate()
    const schemaUid = '12'.repeat(32)
    const uri = createHttpsPayloadUri('https://issuer.example/c.json', '{}')
    const transactions: Array<{ transaction: SubmittableTransaction; signer: Wallet }> = [
      {
        transaction: buildCredentialCreate({
          issuer: issuer.address,
          subject: subject.address,
          schemaUid,
          uri,
        }),
        signer: issuer,
      },
      {
        transaction: buildCredentialAccept({
          subject: subject.address,
          issuer: issuer.address,
          schemaUid,
        }),
        signer: subject,
      },
      {
        transaction: buildCredentialDelete({
          account: issuer.address,
          issuer: issuer.address,
          subject: subject.address,
          schemaUid,
        }),
        signer: issuer,
      },
    ]

    for (const [index, item] of transactions.entries()) {
      const prepared = {
        ...item.transaction,
        Fee: '12',
        Sequence: index + 1,
        LastLedgerSequence: 100,
      }
      const signed = item.signer.sign(prepared)
      const normalized = normalizeWalletSignature({ hash: '', tx_blob: signed.tx_blob })
      expect(normalized.hash).toBe(signed.hash.toUpperCase())
    }
  })

  it('normalizes a wallet signature without persisting unverified output', async () => {
    const { transaction, signed } = signedPayment()
    const signer = createWalletSigner({
      sign: async () => ({ hash: '', tx_blob: signed.tx_blob }),
    })

    await expect(signer.sign(transaction)).resolves.toMatchObject({ hash: signed.hash })
  })

  it('never persists or submits a wallet blob that differs from the reviewed transaction', async () => {
    const { transaction } = signedPayment()
    const attacker = Wallet.generate()
    const changed = attacker.sign({
      ...transaction,
      Account: attacker.address,
    })
    const persist = vi.fn()
    const submit = vi.fn()
    const entries: SubmissionJournalEntry[] = []
    const client = {
      isConnected: () => true,
      submit,
      request: async () => ({ result: { ledger_current_index: 99 } }),
    } as unknown as Client

    await expect(
      signPreparedAndSubmit(
        client,
        transaction,
        createWalletSigner({ sign: async () => ({ hash: '', tx_blob: changed.tx_blob }) }),
        {
          journal: { append: async (entry) => void entries.push(entry) },
          onValidatedSignature: persist,
        },
      ),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNER_RESULT' })
    expect(persist).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    const failed = entries.reduce(applyJournalEntry, storedOperation())
    expect(entries.map((entry) => entry.stage)).toEqual(['prepared', 'failed'])
    expect(failed.txBlob).toBeUndefined()
    expect(canRetryOperation(failed)).toBe(false)
  })

  it('never persists or submits a signed JSON transaction that differs from the review', async () => {
    const { transaction } = signedPayment()
    const attacker = Wallet.generate()
    const changed = attacker.sign({ ...transaction, Account: attacker.address })
    const persist = vi.fn()
    const submit = vi.fn()
    const client = {
      isConnected: () => true,
      submit,
      request: async () => ({ result: { ledger_current_index: 99 } }),
    } as unknown as Client

    await expect(
      signPreparedAndSubmit(
        client,
        transaction,
        createWalletSigner({
          sign: async () => ({ hash: '', tx_json: decode(changed.tx_blob) }),
        }),
        {
          journal: { append: async () => undefined },
          onValidatedSignature: persist,
        },
      ),
    ).rejects.toMatchObject({ code: 'XCS_SDK_INVALID_SIGNER_RESULT' })
    expect(persist).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('persists the blob before the SDK makes its first submit call', async () => {
    const { transaction, signed } = signedPayment()
    const events: string[] = []
    const journal: OperationJournal = {
      append: async (entry) => {
        events.push(`journal:${entry.stage}`)
      },
    }
    const signer = createWalletSigner({
      sign: async () => {
        events.push('wallet:sign')
        return { hash: '', tx_blob: signed.tx_blob }
      },
    })
    const client = {
      isConnected: () => true,
      submit: async () => {
        events.push('network:submit')
        return { result: { engine_result: 'tesSUCCESS' } }
      },
      request: async () => ({
        result: {
          validated: true,
          ledger_current_index: 99,
          ledger_index: 99,
          meta: { TransactionResult: 'tesSUCCESS' },
        },
      }),
    } as unknown as Client

    await expect(
      signPreparedAndSubmit(client, transaction, signer, {
        journal,
        operationId: 'operation-1',
        pollIntervalMs: 1,
        timeoutMs: 10,
        onValidatedSignature: async () => {
          events.push('indexeddb:persisted')
        },
      }),
    ).resolves.toMatchObject({ status: 'validated', transactionResult: 'tesSUCCESS' })
    expect(events.indexOf('indexeddb:persisted')).toBeLessThan(events.indexOf('network:submit'))
    expect(events).toEqual([
      'journal:prepared',
      'wallet:sign',
      'indexeddb:persisted',
      'journal:signed',
      'network:submit',
      'journal:submitted',
      'journal:validated',
    ])
  })

  it('retains publication recovery before a volatile submission guard rejects the signed operation', async () => {
    const { transaction, signed } = signedPayment()
    const events: string[] = []
    const persistPublication = vi.fn(async () => {
      events.push('publication:persisted')
    })
    const submit = vi.fn()
    await expect(
      signPreparedAndSubmit(
        {
          isConnected: () => true,
          submit,
          request: async () => ({ result: { ledger_current_index: 99 } }),
        } as unknown as Client,
        transaction,
        createWalletSigner({ sign: async () => ({ hash: '', tx_blob: signed.tx_blob }) }),
        {
          journal: { append: async () => {} },
          onValidatedSignature: async (signature) => {
            events.push('signed:persisted')
            expect(signature.lastLedgerSequence).toBe(transaction.LastLedgerSequence)
            await persistPublication()
          },
          beforeSubmit: async () => {
            events.push('guard:rejected')
            throw new Error('READINESS_UNAVAILABLE')
          },
        },
      ),
    ).rejects.toThrow('READINESS_UNAVAILABLE')
    expect(events).toEqual(['signed:persisted', 'publication:persisted', 'guard:rejected'])
    expect(submit).not.toHaveBeenCalled()
  })

  it('never persists or submits when issuer trust changes during the wallet dialog', async () => {
    const { transaction, signed } = signedPayment()
    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    const subject = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
    const generationId = '34'.repeat(32)
    const review: CredentialReview = {
      generationId,
      issuer,
      subject,
      schemaUid: '12'.repeat(32),
      uri: 'https://issuer.example/c.json',
      expiration: null,
      accepted: false,
      state: 'pending',
      claims: { programId: 'course-1' },
      report: {
        onChain: 'pending',
        schema: 'valid',
        payload: 'valid',
        issuerTrust: 'unknown',
        generationId,
      },
    }
    const acknowledgement = createIssuerTrustAcknowledgementToken(review, 'profile-a')
    const persistSigned = vi.fn()
    const submit = vi.fn()
    const entries: SubmissionJournalEntry[] = []
    const client = {
      isConnected: () => true,
      submit,
      request: async () => ({ result: { ledger_current_index: 99 } }),
    } as unknown as Client

    await expect(
      signPreparedAndSubmit(
        client,
        transaction,
        createWalletSigner({ sign: async () => ({ hash: '', tx_blob: signed.tx_blob }) }),
        {
          journal: { append: async (entry) => void entries.push(entry) },
          onValidatedSignature: async () => {
            assertCredentialAcceptanceReviewCurrent(
              review,
              { ...review, report: { ...review.report, issuerTrust: 'untrusted' } },
              'profile-a',
              'profile-a',
              acknowledgement,
            )
            await persistSigned()
          },
        },
      ),
    ).rejects.toThrow('CREDENTIAL_ISSUER_TRUST_CHANGED_AFTER_SIGNATURE')
    expect(persistSigned).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(entries.map((entry) => entry.stage)).toEqual(['prepared', 'failed'])
  })
})

describe('stored recovery material validation', () => {
  function recoveryMaterial(
    overrides: Partial<Parameters<typeof validateStoredRecoveryMaterial>[0]> = {},
  ): Parameters<typeof validateStoredRecoveryMaterial>[0] {
    const { transaction, signed } = signedPayment()
    return {
      txBlob: signed.tx_blob,
      txHash: signed.hash.toUpperCase(),
      lastLedgerSequence: transaction.LastLedgerSequence!,
      account: transaction.Account,
      transactionType: transaction.TransactionType,
      networkId: 1,
      ...overrides,
    }
  }

  it('accepts recovery material whose blob is strictly bound to its stored metadata', () => {
    expect(() => validateStoredRecoveryMaterial(recoveryMaterial())).not.toThrow()
  })

  it('accepts an explicit NetworkID only when it matches the stored network', () => {
    const signer = Wallet.generate()
    const transaction: Payment = {
      TransactionType: 'Payment',
      Account: signer.address,
      Destination: Wallet.generate().address,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
      NetworkID: 1,
    }
    const signed = signer.sign(transaction)

    expect(() =>
      validateStoredRecoveryMaterial({
        txBlob: signed.tx_blob,
        txHash: signed.hash.toUpperCase(),
        lastLedgerSequence: 100,
        account: signer.address,
        transactionType: 'Payment',
        networkId: 1,
      }),
    ).not.toThrow()
  })

  it('rejects an undecodable signed blob', () => {
    expect(() => validateStoredRecoveryMaterial(recoveryMaterial({ txBlob: 'NOT_HEX' }))).toThrow(
      'OPERATION_RECOVERY_BLOB_INVALID',
    )
  })

  it('rejects decodable recovery material without a valid single signature', () => {
    const { transaction } = signedPayment()
    const unsigned = encode({ ...transaction, SigningPubKey: '' })
    expect(() =>
      validateStoredRecoveryMaterial(
        recoveryMaterial({
          txBlob: unsigned,
          txHash: hashes.hashSignedTx(unsigned).toUpperCase(),
        }),
      ),
    ).toThrow('OPERATION_RECOVERY_BLOB_INVALID')
  })

  it('rejects a stored hash that is not derived from the blob', () => {
    expect(() =>
      validateStoredRecoveryMaterial(recoveryMaterial({ txHash: '0'.repeat(64) })),
    ).toThrow('OPERATION_RECOVERY_HASH_MISMATCH')
  })

  it('requires a positive LastLedgerSequence in both the blob and stored metadata', () => {
    const signer = Wallet.generate()
    const transaction = {
      TransactionType: 'Payment',
      Account: signer.address,
      Destination: Wallet.generate().address,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
    } as Payment
    const signed = signer.sign(transaction)

    expect(() =>
      validateStoredRecoveryMaterial({
        txBlob: signed.tx_blob,
        txHash: signed.hash.toUpperCase(),
        lastLedgerSequence: 100,
        account: signer.address,
        transactionType: 'Payment',
        networkId: 1,
      }),
    ).toThrow('OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_INVALID')
    expect(() =>
      validateStoredRecoveryMaterial(recoveryMaterial({ lastLedgerSequence: 0 })),
    ).toThrow('OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_INVALID')
  })

  it('rejects a LastLedgerSequence that differs from the blob', () => {
    expect(() =>
      validateStoredRecoveryMaterial(recoveryMaterial({ lastLedgerSequence: 101 })),
    ).toThrow('OPERATION_RECOVERY_LAST_LEDGER_SEQUENCE_MISMATCH')
  })

  it('rejects an account that differs from the signed transaction', () => {
    expect(() =>
      validateStoredRecoveryMaterial(recoveryMaterial({ account: Wallet.generate().address })),
    ).toThrow('OPERATION_RECOVERY_ACCOUNT_MISMATCH')
  })

  it('rejects a transaction type that differs from the signed transaction', () => {
    expect(() =>
      validateStoredRecoveryMaterial(recoveryMaterial({ transactionType: 'CredentialCreate' })),
    ).toThrow('OPERATION_RECOVERY_TRANSACTION_TYPE_MISMATCH')
  })

  it('rejects an explicit NetworkID that differs from the stored network', () => {
    const signer = Wallet.generate()
    const transaction: Payment = {
      TransactionType: 'Payment',
      Account: signer.address,
      Destination: Wallet.generate().address,
      Amount: '1',
      Fee: '12',
      Sequence: 1,
      LastLedgerSequence: 100,
      NetworkID: 2,
    }
    const signed = signer.sign(transaction)

    expect(() =>
      validateStoredRecoveryMaterial({
        txBlob: signed.tx_blob,
        txHash: signed.hash.toUpperCase(),
        lastLedgerSequence: 100,
        account: signer.address,
        transactionType: 'Payment',
        networkId: 1,
      }),
    ).toThrow('OPERATION_RECOVERY_NETWORK_ID_MISMATCH')
  })
})

describe('reliable submission outcome', () => {
  const successful: ReliableSubmissionResult = {
    operationId: 'operation-1',
    status: 'validated',
    txHash: 'A'.repeat(64),
    transactionResult: 'tesSUCCESS',
    ledgerIndex: 101,
  }

  it('only accepts a validated tesSUCCESS result', () => {
    expect(() => assertValidatedTesSuccess(successful)).not.toThrow()
  })

  it('does not report a pending transaction as successful', () => {
    expect(() => assertValidatedTesSuccess({ ...successful, status: 'pending' })).toThrow(
      'TRANSACTION_PENDING',
    )
  })

  it('does not report a validated tec result as successful', () => {
    expect(() =>
      assertValidatedTesSuccess({ ...successful, transactionResult: 'tecUNFUNDED_PAYMENT' }),
    ).toThrow('TRANSACTION_FAILED:tecUNFUNDED_PAYMENT')
  })

  it('does not report success without a positive validated ledger index', () => {
    expect(() => assertValidatedTesSuccess({ ...successful, ledgerIndex: undefined })).toThrow(
      'TRANSACTION_LEDGER_INDEX_INVALID',
    )
    expect(() => assertValidatedTesSuccess({ ...successful, ledgerIndex: 0 })).toThrow(
      'TRANSACTION_LEDGER_INDEX_INVALID',
    )
  })
})

describe('operation journal state', () => {
  const publicationJobId = '12345678-1234-4234-8234-123456789abc'
  const hostedBusiness = {
    action: 'credential-issue' as const,
    issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
    schemaUid: '12'.repeat(32),
    publicationJobId,
  }

  it('validates and preserves the publication link in stored and portable business context', () => {
    expect(validateOperationBusinessContext(hostedBusiness)).toEqual(hostedBusiness)
    expect(
      toSanitizedOperationReceipt(storedOperation({ business: hostedBusiness })).business,
    ).toEqual(hostedBusiness)
    expect(() =>
      validateOperationBusinessContext({ ...hostedBusiness, publicationJobId: '../invalid' }),
    ).toThrow('OPERATION_PUBLICATION_JOB_ID_INVALID')
  })

  it.each(['validated', 'expired', 'failed'] as const)(
    'retains a hosted signature after %s until explicit publication verification',
    (stage) => {
      const operation = storedOperation({
        stage: 'pending',
        business: hostedBusiness,
        txBlob: 'SIGNED_BLOB',
      })
      const terminal = applyJournalEntry(operation, {
        operationId: operation.operationId,
        at: '2026-09-21T12:00:00.000Z',
        stage,
      })
      expect(terminal.txBlob).toBe('SIGNED_BLOB')
      expect(canRetryOperation(terminal)).toBe(false)
      toSanitizedOperationReceipt(terminal)
      expect(terminal.txBlob).toBe('SIGNED_BLOB')
      const completed = completeOperationPublication(terminal, publicationJobId)
      expect(completed.txBlob).toBeUndefined()
      expect(completed.publicationCompleted).toBe(true)
      expect(completeOperationPublication(completed, publicationJobId)).toEqual(completed)
    },
  )

  it('keeps pending ledger recovery when publication verification finishes first', () => {
    const pending = storedOperation({
      stage: 'pending',
      business: hostedBusiness,
      txBlob: 'SIGNED_BLOB',
    })
    const published = completeOperationPublication(pending, publicationJobId)
    expect(published.publicationCompleted).toBe(true)
    expect(published.txBlob).toBe('SIGNED_BLOB')
    expect(canRetryOperation(published)).toBe(true)
    const validated = applyJournalEntry(published, {
      operationId: pending.operationId,
      at: '2026-09-21T12:00:00.000Z',
      stage: 'validated',
    })
    expect(validated.txBlob).toBeUndefined()
  })

  it('does not purge an unrelated publication', () => {
    const operation = storedOperation({
      stage: 'validated',
      business: hostedBusiness,
      txBlob: 'SIGNED_BLOB',
    })
    expect(completeOperationPublication(operation, '87654321-1234-4234-8234-123456789abc')).toBe(
      operation,
    )
  })

  it('uses action-independent business locks for one credential generation', () => {
    const profileId = 'xrpl-testnet-xcs-v0.1'
    const tuple = {
      issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
      schemaUid: '12'.repeat(32),
      generationId: '34'.repeat(32),
    }
    expect(operationBusinessKey(profileId, { action: 'credential-accept', ...tuple })).toBe(
      operationBusinessKey(profileId, { action: 'credential-revoke', ...tuple }),
    )
    expect(operationBusinessKey(profileId, { action: 'credential-remove', ...tuple })).toBe(
      operationBusinessKey(profileId, { action: 'credential-accept', ...tuple }),
    )
    expect(
      operationBusinessKey(profileId, {
        action: 'credential-issue',
        issuer: tuple.issuer,
        subject: tuple.subject,
        schemaUid: tuple.schemaUid,
      }),
    ).not.toBe(operationBusinessKey(profileId, { action: 'credential-accept', ...tuple }))
  })

  it('preserves public tuple exclusion while locking one issuer invitation across recipient wallets', () => {
    const business = validateOperationBusinessContext({
      action: 'credential-issue',
      issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
      schemaUid: 'a'.repeat(64),
      issuerInviteId: '12345678-1234-4234-8234-123456789abc',
    })
    const existing = storedOperation({ business, stage: 'signed' })
    const differentWallet = storedOperation({
      operationId: 'second',
      business: {
        ...business,
        action: 'credential-issue',
        issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        subject: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        schemaUid: 'a'.repeat(64),
      },
    })
    expect(operationConflictsWith(existing, differentWallet)).toBe(true)
    const publicBusiness = validateOperationBusinessContext({
      ...business,
      issuerInviteId: undefined,
    })
    expect(operationConflictsWith(existing, storedOperation({ business: publicBusiness }))).toBe(
      true,
    )
    expect(operationConflictsWith(storedOperation({ business: publicBusiness }), existing)).toBe(
      true,
    )
    expect(
      operationConflictsWith(
        {
          ...existing,
          stage: 'validated',
          engineResult: 'tesSUCCESS',
          businessConfirmation: 'confirmed',
        },
        differentWallet,
      ),
    ).toBe(true)
    expect(operationConflictsWith({ ...existing, stage: 'expired' }, differentWallet)).toBe(false)
    expect(
      operationConflictsWith(
        { ...existing, stage: 'validated', engineResult: 'tecNO_TARGET' },
        differentWallet,
      ),
    ).toBe(false)
    expect(
      operationConflictsWith(existing, { ...differentWallet, profileId: 'other-profile' }),
    ).toBe(false)
  })

  it('rejects malformed portal invitation identifiers instead of silently dropping the lock', () => {
    expect(() =>
      validateOperationBusinessContext({
        action: 'credential-issue',
        issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
        schemaUid: 'a'.repeat(64),
        issuerInviteId: 'bearer-token-is-not-an-invitation-UUID',
      }),
    ).toThrow('OPERATION_ISSUER_INVITE_ID_INVALID')
  })

  it('allows abandoning only an unsigned prepared draft', () => {
    expect(canAbandonOperation(storedOperation())).toBe(true)
    expect(canAbandonOperation(storedOperation({ stage: 'signed', txHash: 'A'.repeat(64) }))).toBe(
      false,
    )
    expect(canAbandonOperation(storedOperation({ stage: 'prepared', txBlob: 'ABCD' }))).toBe(false)
  })

  it('keeps an incomplete v0.1 registration record readable without inventing finality', () => {
    const receipt = toSanitizedOperationReceipt(
      storedOperation({
        stage: 'validated',
        txHash: 'AB'.repeat(32),
        engineResult: 'tesSUCCESS',
        business: { action: 'schema-register' },
        businessConfirmation: 'confirmed',
      }),
    )

    expect(receipt.business).toEqual({ action: 'schema-register' })
    expect(receipt).not.toHaveProperty('businessConfirmation')
    expect(receipt.receiptVersion).toBe('0.2')
  })

  it('preserves the signed blob while applying SDK journal entries', () => {
    const operation = storedOperation({
      stage: 'signed',
      txBlob: 'ABCD',
      txHash: 'A'.repeat(64),
    })
    const entry: SubmissionJournalEntry = {
      operationId: operation.operationId,
      at: '2026-08-19T12:01:00.000Z',
      stage: 'pending',
      txHash: operation.txHash,
      lastLedgerSequence: 100,
    }

    const updated = applyJournalEntry(operation, entry)
    expect(updated.txBlob).toBe('ABCD')
    expect(updated.stage).toBe('pending')
    expect(canRetryOperation(updated)).toBe(true)
  })

  it('offers tuple-only retries only with an exact generation context', () => {
    const base = storedOperation({
      transactionType: 'CredentialAccept',
      stage: 'pending',
      txBlob: 'ABCD',
      txHash: 'A'.repeat(64),
      lastLedgerSequence: 100,
    })
    expect(canRetryOperation(base)).toBe(false)
    expect(
      canRetryOperation({
        ...base,
        business: {
          action: 'credential-accept',
          issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
          subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
          schemaUid: '12'.repeat(32),
          generationId: '34'.repeat(32),
        },
      }),
    ).toBe(true)
  })

  it('never offers retry for a validated transaction', () => {
    const operation = storedOperation({
      stage: 'pending',
      txBlob: 'ABCD',
      txHash: 'A'.repeat(64),
    })
    const validated = applyJournalEntry(operation, {
      operationId: operation.operationId,
      at: '2026-08-19T12:02:00.000Z',
      stage: 'validated',
      txHash: operation.txHash,
      engineResult: 'tesSUCCESS',
    })

    expect(validated.txBlob).toBeUndefined()
    expect(canRetryOperation(validated)).toBe(false)
  })

  it('does not regress a terminal operation when a stale journal append arrives', () => {
    const operation = storedOperation({
      stage: 'validated',
      txHash: 'A'.repeat(64),
      engineResult: 'tesSUCCESS',
      updatedAt: '2026-08-19T12:02:00.000Z',
    })
    const unchanged = applyJournalEntry(operation, {
      operationId: operation.operationId,
      at: '2026-08-19T12:03:00.000Z',
      stage: 'pending',
    })

    expect(unchanged).toBe(operation)
  })

  it.each(['validated', 'expired', 'failed'] as const)(
    'removes the signed blob from a %s terminal operation',
    (stage) => {
      const operation = storedOperation({ stage: 'pending', txBlob: 'SECRET_SIGNED_BLOB' })
      const terminal = applyJournalEntry(operation, {
        operationId: operation.operationId,
        at: '2026-08-19T12:02:00.000Z',
        stage,
      })

      expect(terminal.txBlob).toBeUndefined()
      expect(canRetryOperation(terminal)).toBe(false)
    },
  )

  it('runtime-sanitizes portable receipts and never exports blobs, claims or messages', () => {
    const operation = storedOperation({
      stage: 'validated',
      txBlob: 'SECRET_SIGNED_BLOB',
      message: 'PRIVATE_FAILURE_MESSAGE',
      txHash: 'A'.repeat(64),
      engineResult: 'tesSUCCESS',
      ledgerIndex: 123,
      businessConfirmation: 'mismatch',
      business: {
        action: 'credential-accept',
        issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
        schemaUid: 'AB'.repeat(32),
        generationId: 'EF'.repeat(32),
        payloadDigestHex: 'CD'.repeat(32),
        claims: { privateValue: 'DO_NOT_EXPORT' },
        payload: 'DO_NOT_EXPORT',
      } as never,
    })

    const receipt = toSanitizedOperationReceipt(operation)
    expect(receipt.business).toEqual({
      action: 'credential-accept',
      issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
      schemaUid: 'ab'.repeat(32),
      generationId: 'ef'.repeat(32),
      payloadDigestHex: 'cd'.repeat(32),
    })
    expect(receipt.businessConfirmation).toBe('mismatch')
    const exported = serializeOperationReceipts([operation], '2026-08-19T13:00:00.000Z')
    expect(exported).not.toContain('SECRET_SIGNED_BLOB')
    expect(exported).not.toContain('PRIVATE_FAILURE_MESSAGE')
    expect(exported).not.toContain('DO_NOT_EXPORT')
    expect(exported).not.toContain('claims')
    expect(exported).not.toContain('"businessConfirmation": "confirmed"')
    expect(JSON.parse(exported)).toMatchObject({
      receiptExportVersion: '0.2',
      exportedAt: '2026-08-19T13:00:00.000Z',
      receipts: [{ ledgerIndex: 123, engineResult: 'tesSUCCESS' }],
    })
  })

  it('exports a v0.2 issuance receipt with public context and exact indexed evidence', () => {
    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    const subject = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
    const schemaUid = '12'.repeat(32)
    const txHash = 'AB'.repeat(32)
    const digest = '34'.repeat(32)
    const receipt = toSanitizedOperationReceipt(
      storedOperation({
        account: issuer,
        transactionType: 'CredentialCreate',
        stage: 'validated',
        txHash,
        engineResult: 'tesSUCCESS',
        ledgerIndex: 101,
        businessConfirmation: 'confirmed',
        business: {
          action: 'credential-issue',
          issuer,
          subject,
          schemaUid,
          credentialUri: `https://issuer.example/c.json#xcs-sha256=${digest}`,
          payloadDigestHex: digest,
          expiration: '2026-09-01T00:00:00.000Z',
          claims: { secret: 'DO_NOT_EXPORT' },
        } as never,
        businessEvidence: {
          transactionHash: txHash,
          ledgerIndex: 101,
          ledgerHash: 'CD'.repeat(32),
          transactionIndex: 2,
          schemaUid,
          generationId: txHash,
          eventType: 'created',
          accepted: false,
          deletionCause: null,
        },
      }),
    )

    expect(receipt).toMatchObject({
      receiptVersion: '0.2',
      businessConfirmation: 'confirmed',
      business: {
        action: 'credential-issue',
        issuer,
        subject,
        schemaUid,
        payloadDigestHex: digest,
      },
      businessEvidence: {
        transactionHash: txHash.toLowerCase(),
        generationId: txHash.toLowerCase(),
        eventType: 'created',
      },
    })
    expect(JSON.stringify(receipt)).not.toContain('DO_NOT_EXPORT')
    expect(JSON.stringify(receipt)).not.toContain('claims')
  })

  it('exports a sanitized v0.2 subject-removal receipt with exact indexed evidence', () => {
    const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
    const subject = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
    const schemaUid = '12'.repeat(32)
    const generationId = '34'.repeat(32)
    const txHash = 'AB'.repeat(32)
    const receipt = toSanitizedOperationReceipt(
      storedOperation({
        account: subject,
        transactionType: 'CredentialDelete',
        stage: 'validated',
        txHash,
        engineResult: 'tesSUCCESS',
        ledgerIndex: 101,
        businessConfirmation: 'confirmed',
        business: {
          action: 'credential-remove',
          issuer,
          subject,
          schemaUid,
          generationId,
          claims: { secret: 'DO_NOT_EXPORT' },
        } as never,
        businessEvidence: {
          transactionHash: txHash,
          ledgerIndex: 101,
          ledgerHash: 'CD'.repeat(32),
          transactionIndex: 2,
          schemaUid,
          generationId,
          eventType: 'deleted',
          accepted: true,
          deletionCause: 'subject_removed',
        },
      }),
    )

    expect(receipt).toMatchObject({
      receiptVersion: '0.2',
      account: subject,
      transactionType: 'CredentialDelete',
      businessConfirmation: 'confirmed',
      business: { action: 'credential-remove', issuer, subject, schemaUid, generationId },
      businessEvidence: { eventType: 'deleted', accepted: true, deletionCause: 'subject_removed' },
    })
    expect(JSON.stringify(receipt)).not.toContain('DO_NOT_EXPORT')
    expect(JSON.stringify(receipt)).not.toContain('claims')
  })

  it('never upgrades a generation-bound receipt to confirmed without event evidence', () => {
    const operation = storedOperation({
      transactionType: 'CredentialAccept',
      stage: 'validated',
      business: {
        action: 'credential-accept',
        issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        subject: 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59',
        schemaUid: '12'.repeat(32),
        generationId: '34'.repeat(32),
      },
    })

    expect(toSanitizedOperationReceipt(operation)).toMatchObject({
      stage: 'validated',
      businessConfirmation: 'pending',
    })
    expect(
      toSanitizedOperationReceipt({
        ...operation,
        stage: 'prepared',
        businessConfirmation: 'confirmed',
      }),
    ).toMatchObject({ stage: 'prepared', businessConfirmation: 'pending' })
    expect(
      toSanitizedOperationReceipt({
        ...operation,
        businessConfirmation: 'confirmed',
        businessEvidence: {
          transactionHash: operation.txHash!,
          ledgerIndex: 101,
          ledgerHash: 'CD'.repeat(32),
          transactionIndex: 2,
          schemaUid: '12'.repeat(32),
          generationId: '34'.repeat(32),
          eventType: 'accepted',
          accepted: false,
          deletionCause: null,
        },
      }),
    ).toMatchObject({ businessConfirmation: 'pending' })
  })
})
