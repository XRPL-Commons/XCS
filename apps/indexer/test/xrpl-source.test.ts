import { describe, expect, it, vi } from 'vitest'
import { encode } from 'ripple-binary-codec'
import { Client, decode, hashes, Wallet } from 'xrpl'

import {
  assertFeatureResponseSupportsAmendment,
  normalizeLedgerResponse,
  XrplLedgerSource,
} from '../src/xrpl-source.js'

const LEDGER_HASH = 'a'.repeat(64)
const PARENT_HASH = 'b'.repeat(64)
const ACCOUNT_ROOT = 'c'.repeat(64)
const TRANSACTION_ROOT = 'd'.repeat(64)
const FIRST_TX_HASH = 'e'.repeat(64)
const SECOND_TX_HASH = 'f'.repeat(64)

function response(): Record<string, unknown> {
  return {
    validated: true,
    ledger_hash: LEDGER_HASH.toUpperCase(),
    ledger_index: 10,
    ledger: {
      account_hash: ACCOUNT_ROOT.toUpperCase(),
      close_flags: 0,
      close_time: 500,
      close_time_resolution: 10,
      closed: true,
      ledger_hash: LEDGER_HASH.toUpperCase(),
      ledger_index: 10,
      parent_close_time: 490,
      parent_hash: PARENT_HASH.toUpperCase(),
      total_coins: '99999999999999999',
      transaction_hash: TRANSACTION_ROOT.toUpperCase(),
      transactions: [
        {
          hash: SECOND_TX_HASH.toUpperCase(),
          tx_json: { TransactionType: 'CredentialAccept' },
          meta: { TransactionIndex: 1, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
        },
        {
          hash: FIRST_TX_HASH.toUpperCase(),
          tx_json: { TransactionType: 'Payment' },
          meta: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
        },
      ],
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture is not a record')
  }
  return value as Record<string, unknown>
}

function ledger(value: Record<string, unknown>): Record<string, unknown> {
  return record(value.ledger)
}

function transactions(value: Record<string, unknown>): Record<string, unknown>[] {
  const candidate = ledger(value).transactions
  if (!Array.isArray(candidate)) throw new Error('fixture transactions are missing')
  return candidate.map(record)
}

describe('normalizeLedgerResponse', () => {
  it('normalizes the complete canonical header and orders expanded transactions', () => {
    const normalized = normalizeLedgerResponse(response())

    expect(normalized).toMatchObject({
      ledgerIndex: 10,
      ledgerHash: LEDGER_HASH,
      parentHash: PARENT_HASH,
      accountRoot: ACCOUNT_ROOT,
      transactionRoot: TRANSACTION_ROOT,
      parentCloseTime: 490,
      closeTime: 500,
      closeTimeResolution: 10,
      closeFlags: 0,
      totalCoins: '99999999999999999',
    })
    expect(normalized.transactions.map((entry) => entry.transactionIndex)).toEqual([0, 1])
    expect(normalized.transactions.map((entry) => entry.hash)).toEqual([
      FIRST_TX_HASH,
      SECOND_TX_HASH,
    ])
  })

  it('accepts the flattened expanded-transaction response shape', () => {
    const value = response()
    ledger(value).transactions = [
      {
        hash: FIRST_TX_HASH,
        TransactionType: 'Payment',
        metaData: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS', AffectedNodes: [] },
      },
    ]

    expect(normalizeLedgerResponse(value).transactions[0]).toMatchObject({
      hash: FIRST_TX_HASH,
      transaction: { TransactionType: 'Payment' },
      transactionIndex: 0,
    })
  })

  it.each<[string, unknown]>([
    ['nftoken_id', FIRST_TX_HASH],
    ['nftoken_ids', [FIRST_TX_HASH]],
    ['offer_id', FIRST_TX_HASH],
    ['mpt_issuance_id', '1'.repeat(48)],
    ['delivered_amount', '1'],
  ])(
    'ignores the synthetic API metadata field %s without mutating the response',
    (field, value) => {
      const decorated = response()
      const metadata = record(transactions(decorated)[0]!.meta)
      metadata[field] = value

      expect(normalizeLedgerResponse(decorated)).toEqual(normalizeLedgerResponse(response()))
      expect(metadata[field]).toEqual(value)
    },
  )

  it.each<[string, unknown]>([
    ['DeliveredAmount', '1'],
    ['AffectedNodes', [{ ModifiedNode: { LedgerEntryType: 'AccountRoot' } }]],
    ['TransactionResult', 'tecFAILED'],
    ['FutureCanonicalField', 'preserved'],
  ])('preserves %s for the quorum to detect canonical metadata differences', (field, value) => {
    const changed = response()
    const metadata = record(transactions(changed)[0]!.meta)
    metadata[field] = value
    metadata.delivered_amount = '1'

    const normalized = normalizeLedgerResponse(changed)
    expect(normalized).not.toEqual(normalizeLedgerResponse(response()))
    expect(normalized.transactions[1]!.metadata[field]).toEqual(value)
    expect(normalized.transactions[1]!.metadata).not.toHaveProperty('delivered_amount')
  })

  it('rejects a ledger that is not marked validated or closed', () => {
    const unvalidated = response()
    unvalidated.validated = false
    expect(() => normalizeLedgerResponse(unvalidated)).toThrow('non-validated')

    const open = response()
    ledger(open).closed = false
    expect(() => normalizeLedgerResponse(open)).toThrow('marked closed')
  })

  it.each([
    'ledger_index',
    'ledger_hash',
    'parent_hash',
    'account_hash',
    'transaction_hash',
    'parent_close_time',
    'close_time',
    'close_time_resolution',
    'close_flags',
    'total_coins',
    'transactions',
  ])('rejects an omitted canonical ledger field: %s', (field) => {
    const value = response()
    delete ledger(value)[field]
    expect(() => normalizeLedgerResponse(value)).toThrow()
  })

  it.each(['ledger_index', 'ledger_hash'])('rejects an omitted response field: %s', (field) => {
    const value = response()
    delete value[field]
    expect(() => normalizeLedgerResponse(value)).toThrow()
  })

  it('rejects disagreement between outer and inner ledger identity', () => {
    const wrongIndex = response()
    wrongIndex.ledger_index = 11
    expect(() => normalizeLedgerResponse(wrongIndex)).toThrow('index values disagree')

    const wrongHash = response()
    wrongHash.ledger_hash = '9'.repeat(64)
    expect(() => normalizeLedgerResponse(wrongHash)).toThrow('hash values disagree')
  })

  it('rejects missing transaction hashes and metadata', () => {
    const missingHash = response()
    delete transactions(missingHash)[0]!.hash
    expect(() => normalizeLedgerResponse(missingHash)).toThrow('transaction hash')

    const missingMetadata = response()
    delete transactions(missingMetadata)[0]!.meta
    expect(() => normalizeLedgerResponse(missingMetadata)).toThrow('transaction metadata')

    const missingIndex = response()
    delete record(transactions(missingIndex)[0]!.meta).TransactionIndex
    expect(() => normalizeLedgerResponse(missingIndex)).toThrow('TransactionIndex')
  })

  it('rejects missing or empty canonical transaction and metadata fields', () => {
    const missingType = response()
    delete record(transactions(missingType)[0]!.tx_json).TransactionType
    expect(() => normalizeLedgerResponse(missingType)).toThrow('TransactionType')

    const emptyType = response()
    record(transactions(emptyType)[0]!.tx_json).TransactionType = ''
    expect(() => normalizeLedgerResponse(emptyType)).toThrow('TransactionType')

    const missingNodes = response()
    delete record(transactions(missingNodes)[0]!.meta).AffectedNodes
    expect(() => normalizeLedgerResponse(missingNodes)).toThrow('AffectedNodes')

    const malformedNodes = response()
    record(transactions(malformedNodes)[0]!.meta).AffectedNodes = {}
    expect(() => normalizeLedgerResponse(malformedNodes)).toThrow('AffectedNodes')

    const missingResult = response()
    delete record(transactions(missingResult)[0]!.meta).TransactionResult
    expect(() => normalizeLedgerResponse(missingResult)).toThrow('TransactionResult')

    const emptyResult = response()
    record(transactions(emptyResult)[0]!.meta).TransactionResult = '   '
    expect(() => normalizeLedgerResponse(emptyResult)).toThrow('TransactionResult')
  })

  it('rejects conflicting transaction hash representations', () => {
    const value = response()
    record(transactions(value)[0]!.tx_json).hash = '8'.repeat(64)
    expect(() => normalizeLedgerResponse(value)).toThrow('values disagree')
  })

  it('rejects duplicate transaction hashes', () => {
    const value = response()
    transactions(value)[1]!.hash = SECOND_TX_HASH
    expect(() => normalizeLedgerResponse(value)).toThrow('duplicate transaction hash')
  })

  it.each([2, 0])('rejects discontinuous or duplicate transaction index %s', (index) => {
    const value = response()
    record(transactions(value)[0]!.meta).TransactionIndex = index
    expect(() => normalizeLedgerResponse(value)).toThrow('missing transaction index')
  })

  it.each(['01', '-1', '18446744073709551616', 100])(
    'rejects non-canonical total coins %j',
    (totalCoins) => {
      const value = response()
      ledger(value).total_coins = totalCoins
      expect(() => normalizeLedgerResponse(value)).toThrow('canonical uint64')
    },
  )
})

describe('assertFeatureResponseSupportsAmendment', () => {
  const amendmentId = 'A'.repeat(64)

  it('accepts both XRPL feature response shapes', () => {
    const feature = {
      [amendmentId.toLowerCase()]: {
        enabled: true,
        name: 'Credentials',
        supported: true,
        vetoed: false,
      },
    }
    expect(() => assertFeatureResponseSupportsAmendment(feature, amendmentId)).not.toThrow()
    expect(() =>
      assertFeatureResponseSupportsAmendment({ features: feature }, amendmentId),
    ).not.toThrow()
  })

  it.each([
    ['absent', {}],
    ['disabled', { [amendmentId]: { enabled: false, supported: true } }],
    ['unsupported', { [amendmentId]: { enabled: true, supported: false } }],
  ])('fails closed when the amendment is %s', (_name, featureResponse) => {
    expect(() => assertFeatureResponseSupportsAmendment(featureResponse, amendmentId)).toThrow(
      amendmentId,
    )
  })
})

// Published XRPL binary-codec header vector (ledger 32052277); no transaction/account secrets.
const BINARY_HEADER =
  '01E91435016340767BF1C4A3EACEB081770D8ADE216C85445DD6FB002C6B5A2930F2DECE006DA18150CB18F6DD33F6F0990754C962A7CCE62F332FF9C13939B03B864117F0BDA86B6E9B4F873B5C3E520634D343EF5D9D9A4246643D64DAD278BA95DC0EAC6EB5350CF970D521276CDE21276CE60A00'
const BINARY_HEADER_FIELDS = {
  ledger_index: 32052277,
  total_coins: '99994494362043555',
  parent_hash: 'EACEB081770D8ADE216C85445DD6FB002C6B5A2930F2DECE006DA18150CB18F6',
  transaction_hash: 'DD33F6F0990754C962A7CCE62F332FF9C13939B03B864117F0BDA86B6E9B4F87',
  account_hash: '3B5C3E520634D343EF5D9D9A4246643D64DAD278BA95DC0EAC6EB5350CF970D5',
  parent_close_time: 556231902,
  close_time: 556231910,
  close_time_resolution: 10,
  close_flags: 0,
}
function binaryResponse() {
  const holder = Wallet.generate()
  const tx = holder.sign({
    TransactionType: 'Payment',
    Account: holder.address,
    Destination: Wallet.generate().address,
    Amount: '123',
    Sequence: 1,
    Fee: '12',
  })
  const metadata = {
    TransactionIndex: 0,
    TransactionResult: 'tesSUCCESS',
    AffectedNodes: [],
    DeliveredAmount: '123',
  }
  return {
    signed: tx,
    metadata,
    result: {
      validated: true,
      ledger_index: BINARY_HEADER_FIELDS.ledger_index,
      ledger_hash: hashes.hashLedgerHeader(
        BINARY_HEADER_FIELDS as Parameters<typeof hashes.hashLedgerHeader>[0],
      ),
      ledger: {
        closed: true,
        ledger_data: BINARY_HEADER,
        transactions: [{ tx_blob: tx.tx_blob, meta: encode(metadata) }],
      },
    },
  }
}

describe('binary ledger transport', () => {
  it('decodes canonical header/transaction/metadata and derives the missing transaction hash from signed bytes', () => {
    const fixture = binaryResponse()
    const normalized = normalizeLedgerResponse(fixture.result)
    expect(normalized).toMatchObject({
      ledgerIndex: 32052277,
      totalCoins: '99994494362043555',
      parentCloseTime: 556231902,
      closeTime: 556231910,
      closeTimeResolution: 10,
      closeFlags: 0,
      parentHash: BINARY_HEADER_FIELDS.parent_hash.toLowerCase(),
      transactionRoot: BINARY_HEADER_FIELDS.transaction_hash.toLowerCase(),
      accountRoot: BINARY_HEADER_FIELDS.account_hash.toLowerCase(),
    })
    expect(normalized.transactions[0]).toMatchObject({
      hash: fixture.signed.hash.toLowerCase(),
      transactionIndex: 0,
      metadata: fixture.metadata,
      transaction: { TransactionType: 'Payment', Amount: '123' },
    })
    expect(normalized.transactions[0]!.transaction).not.toHaveProperty('DeliverMax')
    const expanded = {
      ...fixture.result,
      ledger: {
        ...BINARY_HEADER_FIELDS,
        ledger_hash: fixture.result.ledger_hash,
        closed: true,
        transactions: [
          {
            hash: fixture.signed.hash,
            tx_json: decode(fixture.signed.tx_blob),
            meta: fixture.metadata,
          },
        ],
      },
    }
    expect(normalized).toEqual(normalizeLedgerResponse(expanded))
  })
  it('accepts API v2 meta_blob and hash while rejecting conflicting metadata aliases', () => {
    const fixture = binaryResponse()
    const expected = normalizeLedgerResponse(fixture.result)
    const tx = record(fixture.result.ledger.transactions[0])
    tx.meta_blob = tx.meta
    tx.hash = fixture.signed.hash
    delete tx.meta
    expect(normalizeLedgerResponse(fixture.result)).toEqual(expected)
    tx.meta = encode({ ...fixture.metadata, TransactionResult: 'tecUNFUNDED_PAYMENT' })
    expect(() => normalizeLedgerResponse(fixture.result)).toThrow(
      'metadata representations disagree',
    )
  })
  it('requests a complete binary ledger and keeps the response-index guard', async () => {
    const fixture = binaryResponse()
    const request = vi
      .spyOn(Client.prototype, 'request')
      .mockResolvedValue({ result: fixture.result } as never)
    try {
      const source = new XrplLedgerSource('wss://source.invalid')
      expect(await source.getLedger(32052277)).toEqual(normalizeLedgerResponse(fixture.result))
      expect(request).toHaveBeenCalledWith({
        command: 'ledger',
        ledger_index: 32052277,
        transactions: true,
        expand: true,
        binary: true,
      })
      await expect(source.getLedger(32052278)).rejects.toMatchObject({
        code: 'SOURCE_RESPONSE_INVALID',
      })
    } finally {
      request.mockRestore()
    }
  })
  it.each(['', '0', 'GG', '00', BINARY_HEADER + '00'])(
    'rejects malformed or trailing binary header bytes %s',
    (header) => {
      const fixture = binaryResponse()
      fixture.result.ledger.ledger_data = header
      expect(() => normalizeLedgerResponse(fixture.result)).toThrow()
    },
  )
  it('rejects a binary header that disagrees with the advertised hash', () => {
    const fixture = binaryResponse()
    fixture.result.ledger_hash = '0'.repeat(64)
    expect(() => normalizeLedgerResponse(fixture.result)).toThrow('hash values disagree')
  })
  it.each(['tx_blob', 'meta'] as const)(
    'rejects invalid binary %s instead of trusting optional JSON shadows',
    (field) => {
      const fixture = binaryResponse()
      const tx = fixture.result.ledger.transactions[0]!
      tx[field] = '00'
      Object.assign(tx, { hash: fixture.signed.hash, tx_json: decode(fixture.signed.tx_blob) })
      expect(() => normalizeLedgerResponse(fixture.result)).toThrow('Cannot decode binary')
    },
  )
  it('rejects a conflicting optional transaction hash', () => {
    const fixture = binaryResponse()
    Object.assign(fixture.result.ledger.transactions[0]!, { hash: '0'.repeat(64) })
    expect(() => normalizeLedgerResponse(fixture.result)).toThrow('hash values disagree')
  })
  it('retains legitimate protocol pseudo-transactions without claiming an account signature', () => {
    const fixture = binaryResponse()
    const pseudo = {
      TransactionType: 'EnableAmendment',
      Account: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
      LedgerSequence: 32052277,
      Amendment: 'a'.repeat(64),
    }
    const blob = encode(pseudo)
    fixture.result.ledger.transactions[0]!.tx_blob = blob
    const normalized = normalizeLedgerResponse(fixture.result).transactions[0]!
    expect(normalized.transaction).toMatchObject({
      ...pseudo,
      Amendment: pseudo.Amendment.toUpperCase(),
    })
    // The standard ID domain applies to unsigned protocol operations too.
    expect(normalized.hash).toBe('38b05da5a7dc38038355bb22ce9b605ba616f1cf87e8576dd6be3da1a6bf1702')
  })
})
