import { describe, expect, it } from 'vitest'

import { LedgerFixtureBundleError } from '../src/fixture-bundle.js'
import { QuorumLedgerSource } from '../src/quorum-ledger-source.js'
import { XrplSourceError } from '../src/source-errors.js'
import { IndexerWorker } from '../src/worker.js'
import type {
  AcquiredIndexerLease,
  Checkpoint,
  IndexerHaltStatus,
  IndexerLeaseToken,
  IndexerRepository,
  IndexerStatusUpdate,
  LedgerProjection,
  LedgerSource,
  LedgerSourcePreflight,
  LedgerSourceTips,
  NetworkProfile,
  SchemaCatalogEntry,
  ValidatedLedger,
} from '../src/types.js'

const profile: NetworkProfile = {
  profileId: 'test',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'f'.repeat(64),
  registryAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  registrationAmountDrops: '1',
  activationLedgerIndex: 100,
  activationLedgerHash: 'a'.repeat(64),
}

const token: AcquiredIndexerLease = {
  profileId: profile.profileId,
  writerId: 'writer-1',
  epoch: 1,
  leaseExpiresAt: new Date('2030-01-01T00:00:00Z'),
}

function hash(index: number): string {
  return index === 100 ? 'a'.repeat(64) : index.toString(16).padStart(64, '0')
}

function transactionRoot(index: number): string {
  return (index + 1_000).toString(16).padStart(64, '0')
}

function ledger(ledgerIndex: number): ValidatedLedger {
  return {
    ledgerIndex,
    ledgerHash: hash(ledgerIndex),
    parentHash: ledgerIndex === 100 ? '0'.repeat(64) : hash(ledgerIndex - 1),
    accountRoot: (ledgerIndex + 2_000).toString(16).padStart(64, '0'),
    transactionRoot: transactionRoot(ledgerIndex),
    parentCloseTime: 999 + ledgerIndex,
    closeTime: 1_000 + ledgerIndex,
    closeTimeResolution: 10,
    closeFlags: 0,
    totalCoins: '100000000000000000',
    transactions: [],
  }
}

function checkpoint(value: ValidatedLedger): Checkpoint {
  return {
    ledgerIndex: value.ledgerIndex,
    ledgerHash: value.ledgerHash,
    parentHash: value.parentHash,
    closeTime: value.closeTime,
    transactionCount: value.transactions.length,
    transactionRoot: value.transactionRoot,
  }
}

class MemoryRepository implements IndexerRepository {
  checkpoint: Checkpoint | undefined
  readonly persisted: number[] = []
  readonly statuses: IndexerStatusUpdate[] = []
  readonly halted: Array<{ status: IndexerHaltStatus; errorCode: string }> = []
  initialized = false
  released = false
  haltFailure = false

  async initializeProfile() {
    this.initialized = true
  }

  async acquireLease() {
    return token
  }

  async renewLease(lease: IndexerLeaseToken) {
    expect(lease).toMatchObject(token)
    return token
  }

  async updateIndexerStatus(_lease: IndexerLeaseToken, status: IndexerStatusUpdate) {
    this.statuses.push(status)
  }

  async releaseLease() {
    this.released = true
  }

  async haltIndexer(_lease: IndexerLeaseToken, status: IndexerHaltStatus, errorCode: string) {
    if (this.haltFailure) throw new Error('STATUS_WRITE_FAILED')
    this.halted.push({ status, errorCode })
  }

  async getLastCheckpoint() {
    return this.checkpoint
  }

  async getSchemaCatalog(): Promise<SchemaCatalogEntry[]> {
    return []
  }

  async persistLedger(
    _profile: NetworkProfile,
    projection: LedgerProjection,
    _lease: IndexerLeaseToken,
    status: IndexerStatusUpdate,
  ) {
    this.persisted.push(projection.ledger.ledgerIndex)
    this.checkpoint = checkpoint(projection.ledger)
    this.statuses.push(status)
    return 'inserted' as const
  }
}

class MemorySource implements LedgerSource {
  connected = false
  readonly requestedLedgers: number[] = []

  constructor(public tip = 103) {}

  async connect() {
    this.connected = true
  }

  async disconnect() {
    this.connected = false
  }

  async preflight(): Promise<LedgerSourcePreflight> {
    return {
      networkId: profile.networkId,
      completeLedgerRanges: [{ min: 100, max: this.tip }],
      activationLedger: ledger(100),
      tips: await this.getValidatedLedgerTips(),
    }
  }

  async assertAmendmentEnabled() {}

  async getValidatedLedgerIndex() {
    return this.tip
  }

  async getValidatedLedgerTips(): Promise<LedgerSourceTips> {
    return { primary: this.tip, secondary: this.tip, effective: this.tip }
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    this.requestedLedgers.push(ledgerIndex)
    return ledger(ledgerIndex)
  }
}

type QuorumFailureMode = 'valid' | 'transaction_omitted' | 'malformed' | 'metadata_diverged'

class QuorumTestSource extends MemorySource {
  constructor(private readonly mode: QuorumFailureMode) {
    super(100)
  }

  override async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    this.requestedLedgers.push(ledgerIndex)
    if (this.mode === 'malformed') {
      throw new XrplSourceError('SOURCE_RESPONSE_INVALID', 'ledger response is malformed')
    }

    const value = ledger(ledgerIndex)
    value.transactions = [
      {
        hash: 'e'.repeat(64),
        transactionIndex: 0,
        transaction: { TransactionType: 'Payment', Sequence: 1 },
        metadata: { TransactionIndex: 0, TransactionResult: 'tesSUCCESS' },
      },
    ]
    if (this.mode === 'transaction_omitted') value.transactions = []
    if (this.mode === 'metadata_diverged') {
      value.transactions[0]!.metadata.TransactionResult = 'tecFAILED'
    }
    return value
  }
}

class CorruptFixtureSource extends MemorySource {
  constructor() {
    super(100)
  }

  override async getLedger(): Promise<ValidatedLedger> {
    throw new LedgerFixtureBundleError(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      'fixture ledger digest mismatch',
    )
  }
}

describe('IndexerWorker', () => {
  it('processes at most the configured batch and atomically marks the tip ready', async () => {
    const repository = new MemoryRepository()
    let caughtUp = false
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new MemorySource(),
      batchSize: 2,
      writerId: token.writerId,
      observer: { caughtUp: () => (caughtUp = true) },
    })

    await expect(worker.runOnce(token)).resolves.toBe(2)
    expect(repository.persisted).toEqual([100, 101])
    expect(repository.statuses.at(-1)?.state).toBe('catching_up')
    expect(caughtUp).toBe(false)

    await expect(worker.runOnce(token)).resolves.toBe(2)
    expect(repository.persisted).toEqual([100, 101, 102, 103])
    expect(repository.statuses.at(-1)).toMatchObject({
      state: 'ready',
      lastAgreedLedgerIndex: 103,
      primarySourceTip: 103,
      secondarySourceTip: 103,
    })

    await expect(worker.runOnce(token)).resolves.toBe(0)
    expect(repository.persisted).toEqual([100, 101, 102, 103])
    expect(caughtUp).toBe(true)
  })

  it('does not transiently clear readiness while advancing one ledger from a checkpoint', async () => {
    const repository = new MemoryRepository()
    repository.checkpoint = checkpoint(ledger(100))
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new MemorySource(101),
      writerId: token.writerId,
    })

    await expect(worker.runOnce(token)).resolves.toBe(1)
    expect(repository.persisted).toEqual([101])
    expect(repository.statuses).toEqual([
      expect.objectContaining({
        state: 'ready',
        lastAgreedLedgerIndex: 101,
        primarySourceTip: 101,
        secondarySourceTip: 101,
      }),
    ])
  })

  it('preflights, acquires a lease and releases it on a clean stop', async () => {
    const repository = new MemoryRepository()
    const source = new MemorySource(100)
    const controller = new AbortController()
    const worker = new IndexerWorker({
      profile,
      repository,
      source,
      pollIntervalMs: 250,
      writerId: token.writerId,
      observer: { caughtUp: () => controller.abort() },
    })

    await expect(worker.start(controller.signal)).resolves.toBeUndefined()
    expect(repository.initialized).toBe(true)
    expect(repository.released).toBe(true)
    expect(repository.halted).toEqual([])
    expect(source.connected).toBe(false)
  })

  it.each([
    ['a source omits a transaction', 'transaction_omitted', 'SOURCE_DIVERGENCE'],
    ['a source returns malformed ledger data', 'malformed', 'SOURCE_RESPONSE_INVALID'],
    ['the normalized metadata diverges', 'metadata_diverged', 'SOURCE_DIVERGENCE'],
  ] as const)(
    'halts before ledger persistence when %s',
    async (_name, failureMode, expectedErrorCode) => {
      const repository = new MemoryRepository()
      const source = new QuorumLedgerSource(
        new QuorumTestSource('valid'),
        new QuorumTestSource(failureMode),
      )
      const worker = new IndexerWorker({
        profile,
        repository,
        source,
        pollIntervalMs: 250,
        writerId: token.writerId,
      })

      await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
        code: expectedErrorCode,
      })
      expect(repository.persisted).toEqual([])
      expect(repository.checkpoint).toBeUndefined()
      expect(repository.halted).toEqual([expect.objectContaining({ errorCode: expectedErrorCode })])
    },
  )

  it('preserves a lazy fixture integrity code when the worker halts', async () => {
    const repository = new MemoryRepository()
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new CorruptFixtureSource(),
      pollIntervalMs: 250,
      writerId: token.writerId,
    })

    await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED',
    })
    expect(repository.persisted).toEqual([])
    expect(repository.halted).toEqual([
      expect.objectContaining({ errorCode: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' }),
    ])
  })

  it('quorum-verifies a replay bound and stops there even when the tip advances', async () => {
    const repository = new MemoryRepository()
    const source = new MemorySource(103)
    const processed: number[] = []
    const worker = new IndexerWorker({
      profile,
      repository,
      source,
      pollIntervalMs: 250,
      batchSize: 2,
      writerId: token.writerId,
      replayTarget: { ledgerIndex: 102, ledgerHash: hash(102) },
      observer: {
        ledgerProcessed: ({ ledgerIndex }) => {
          processed.push(ledgerIndex)
          source.tip = 150
        },
      },
    })

    await expect(worker.start(new AbortController().signal)).resolves.toBeUndefined()
    expect(processed).toEqual([100, 101, 102])
    expect(repository.persisted).toEqual([100, 101, 102])
    expect(source.requestedLedgers).toContain(102)
    expect(source.requestedLedgers).not.toContain(103)
    expect(repository.statuses.at(-1)).toMatchObject({
      state: 'catching_up',
      primarySourceTip: 150,
      secondarySourceTip: 150,
      lastAgreedLedgerIndex: 102,
    })
    expect(repository.released).toBe(true)
  })

  it('fails closed when replay target evidence is unavailable or mismatched', async () => {
    const unavailableRepository = new MemoryRepository()
    const unavailable = new IndexerWorker({
      profile,
      repository: unavailableRepository,
      source: new MemorySource(103),
      pollIntervalMs: 250,
      writerId: token.writerId,
      replayTarget: { ledgerIndex: 104, ledgerHash: hash(104) },
    })

    await expect(unavailable.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'REPLAY_TARGET_UNAVAILABLE',
    })
    expect(unavailableRepository.persisted).toEqual([])
    expect(unavailableRepository.halted.at(-1)?.errorCode).toBe('REPLAY_TARGET_UNAVAILABLE')

    const mismatchRepository = new MemoryRepository()
    const mismatch = new IndexerWorker({
      profile,
      repository: mismatchRepository,
      source: new MemorySource(103),
      pollIntervalMs: 250,
      writerId: token.writerId,
      replayTarget: { ledgerIndex: 102, ledgerHash: 'f'.repeat(64) },
    })

    await expect(mismatch.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'REPLAY_TARGET_MISMATCH',
    })
    expect(mismatchRepository.persisted).toEqual([])
    expect(mismatchRepository.halted.at(-1)?.errorCode).toBe('REPLAY_TARGET_MISMATCH')
  })

  it('does not allow direct bounded replay before target verification', async () => {
    const worker = new IndexerWorker({
      profile,
      repository: new MemoryRepository(),
      source: new MemorySource(103),
      writerId: token.writerId,
      replayTarget: { ledgerIndex: 102, ledgerHash: hash(102) },
    })

    await expect(worker.runOnce(token)).rejects.toMatchObject({
      code: 'REPLAY_TARGET_UNAVAILABLE',
    })
  })

  it('rejects a replay target before the configured activation ledger', () => {
    expect(
      () =>
        new IndexerWorker({
          profile,
          repository: new MemoryRepository(),
          source: new MemorySource(103),
          writerId: token.writerId,
          replayTarget: { ledgerIndex: 99, ledgerHash: hash(99) },
        }),
    ).toThrowError(expect.objectContaining({ code: 'REPLAY_TARGET_UNAVAILABLE' }))
  })

  it('halts instead of trusting a legacy checkpoint without transaction evidence', async () => {
    const repository = new MemoryRepository()
    repository.checkpoint = { ...checkpoint(ledger(100)), transactionRoot: null }
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new MemorySource(100),
      pollIntervalMs: 250,
      writerId: token.writerId,
    })

    await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'CHECKPOINT_EVIDENCE_MISSING',
    })
    expect(repository.halted).toEqual([
      expect.objectContaining({ errorCode: 'CHECKPOINT_EVIDENCE_MISSING' }),
    ])
    expect(repository.released).toBe(false)
  })

  it('halts when persisted transaction evidence disagrees with the quorum', async () => {
    const repository = new MemoryRepository()
    repository.checkpoint = {
      ...checkpoint(ledger(100)),
      transactionRoot: 'f'.repeat(64),
    }
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new MemorySource(100),
      pollIntervalMs: 250,
      writerId: token.writerId,
    })

    await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'CHECKPOINT_CONFLICT',
    })
    expect(repository.halted).toEqual([
      expect.objectContaining({ errorCode: 'CHECKPOINT_CONFLICT' }),
    ])
  })

  it('tries to clear readiness when recording the halt fails', async () => {
    const repository = new MemoryRepository()
    repository.checkpoint = { ...checkpoint(ledger(100)), transactionRoot: null }
    repository.haltFailure = true
    const worker = new IndexerWorker({
      profile,
      repository,
      source: new MemorySource(100),
      pollIntervalMs: 250,
      writerId: token.writerId,
    })

    await expect(worker.start(new AbortController().signal)).rejects.toMatchObject({
      code: 'CHECKPOINT_EVIDENCE_MISSING',
    })
    expect(repository.released).toBe(true)
  })
})
