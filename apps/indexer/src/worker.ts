import { randomUUID } from 'node:crypto'

import { assertLedgerContinuity } from './continuity.js'
import { projectLedger } from './project-ledger.js'
import { createReplayTarget, ReplayTargetError, type ReplayTarget } from './replay-target.js'
import { sourceErrorCode, sourceFailure } from './source-errors.js'
import type {
  Checkpoint,
  IndexerLeaseToken,
  IndexerRepository,
  IndexerStatusUpdate,
  LedgerSource,
  LedgerSourceTips,
  NetworkProfile,
  SchemaCatalogEntry,
  ValidatedLedger,
} from './types.js'

export interface IndexerObserver {
  ledgerProcessed?(details: {
    ledgerIndex: number
    schemaEvents: number
    credentialEvents: number
    malformedCredentialNodes: number
  }): void
  caughtUp?(ledgerIndex: number): void
  failed?(error: unknown): void
}

export interface IndexerWorkerOptions {
  profile: NetworkProfile
  source: LedgerSource
  repository: IndexerRepository
  pollIntervalMs?: number
  leaseDurationMs?: number
  batchSize?: number
  writerId?: string
  observer?: IndexerObserver
  replayTarget?: ReplayTarget
}

class CheckpointIntegrityError extends Error {
  constructor(
    readonly code: 'CHECKPOINT_EVIDENCE_MISSING' | 'CHECKPOINT_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'CheckpointIntegrityError'
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function checkpointFromLedger(ledger: ValidatedLedger): Checkpoint {
  return {
    ledgerIndex: ledger.ledgerIndex,
    ledgerHash: ledger.ledgerHash,
    parentHash: ledger.parentHash,
    closeTime: ledger.closeTime,
    transactionCount: ledger.transactions.length,
    transactionRoot: ledger.transactionRoot,
  }
}

function assertCheckpointHasEvidence(checkpoint: Checkpoint): asserts checkpoint is Checkpoint & {
  transactionRoot: string
} {
  if (checkpoint.transactionRoot === null) {
    throw new CheckpointIntegrityError(
      'CHECKPOINT_EVIDENCE_MISSING',
      `Checkpoint ${checkpoint.ledgerIndex} predates transaction-root persistence and must be rebuilt`,
    )
  }
}

function assertCheckpointMatchesLedger(checkpoint: Checkpoint, ledger: ValidatedLedger): void {
  assertCheckpointHasEvidence(checkpoint)
  if (
    checkpoint.ledgerIndex !== ledger.ledgerIndex ||
    checkpoint.ledgerHash !== ledger.ledgerHash ||
    checkpoint.parentHash !== ledger.parentHash ||
    checkpoint.closeTime !== ledger.closeTime ||
    checkpoint.transactionCount !== ledger.transactions.length ||
    checkpoint.transactionRoot !== ledger.transactionRoot
  ) {
    throw new CheckpointIntegrityError(
      'CHECKPOINT_CONFLICT',
      `Persisted checkpoint ${checkpoint.ledgerIndex} disagrees with the XRPL quorum`,
    )
  }
}

export class IndexerWorker {
  private readonly pollIntervalMs: number
  private readonly leaseDurationMs: number
  private readonly batchSize: number
  private readonly writerId: string
  private readonly replayTarget: ReplayTarget | undefined
  private activeLease: IndexerLeaseToken | undefined
  private lastTips: LedgerSourceTips | undefined
  private lastAgreed: { ledgerIndex: number; ledgerHash: string } | undefined
  private replayTargetVerified = false
  private replayCompleted = false

  constructor(private readonly options: IndexerWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 4_000
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000
    this.batchSize = options.batchSize ?? 20
    this.writerId = options.writerId ?? randomUUID()
    this.replayTarget =
      options.replayTarget === undefined
        ? undefined
        : createReplayTarget(options.replayTarget.ledgerIndex, options.replayTarget.ledgerHash)
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 250) {
      throw new Error('pollIntervalMs must be an integer of at least 250ms')
    }
    if (
      !Number.isInteger(this.leaseDurationMs) ||
      this.leaseDurationMs < 10_000 ||
      this.leaseDurationMs > 300_000
    ) {
      throw new Error('leaseDurationMs must be an integer between 10000 and 300000')
    }
    if (this.leaseDurationMs < this.pollIntervalMs * 3) {
      throw new Error('leaseDurationMs must be at least 3 times pollIntervalMs')
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100) {
      throw new Error('batchSize must be an integer between 1 and 100')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(this.writerId)) {
      throw new Error('writerId is invalid')
    }
    if (
      this.replayTarget !== undefined &&
      this.replayTarget.ledgerIndex < options.profile.activationLedgerIndex
    ) {
      throw new ReplayTargetError(
        'REPLAY_TARGET_UNAVAILABLE',
        'Replay target precedes the configured activation ledger',
      )
    }
  }

  async runOnce(token: IndexerLeaseToken = this.requireActiveLease()): Promise<number> {
    const { profile, repository, source } = this.options
    if (this.replayTarget !== undefined && !this.replayTargetVerified) {
      throw new ReplayTargetError(
        'REPLAY_TARGET_UNAVAILABLE',
        'Replay target must be quorum-verified before projection starts',
      )
    }
    await repository.renewLease(token, this.leaseDurationMs)

    let previous = await repository.getLastCheckpoint(profile.profileId)
    if (previous !== undefined) {
      assertCheckpointHasEvidence(previous)
      this.lastAgreed = {
        ledgerIndex: previous.ledgerIndex,
        ledgerHash: previous.ledgerHash,
      }
    }
    const catalogEntries = await repository.getSchemaCatalog(profile.profileId)
    const catalog = new Map<string, SchemaCatalogEntry>(
      catalogEntries.map((entry) => [entry.uid, entry]),
    )

    const tips = await source.getValidatedLedgerTips()
    this.lastTips = tips
    const validatedLedgerIndex = tips.effective
    const processingLimit = this.replayTarget?.ledgerIndex ?? validatedLedgerIndex
    if (this.replayTarget !== undefined && processingLimit > validatedLedgerIndex) {
      throw new ReplayTargetError(
        'REPLAY_TARGET_UNAVAILABLE',
        `Replay target ${processingLimit} is ahead of the XRPL quorum tip ${validatedLedgerIndex}`,
      )
    }
    let nextLedgerIndex =
      previous === undefined ? profile.activationLedgerIndex : previous.ledgerIndex + 1
    let processed = 0

    await repository.renewLease(token, this.leaseDurationMs)
    // A previously agreed checkpoint remains authoritative within the API's
    // freshness window while the next ledger is fetched. Do not create a
    // transient catching_up state before that ledger and its ready status can
    // be persisted atomically.
    if (previous === undefined || nextLedgerIndex > validatedLedgerIndex) {
      await this.persistRuntimeStatus(
        token,
        this.replayTarget === undefined &&
          previous !== undefined &&
          nextLedgerIndex > validatedLedgerIndex
          ? 'ready'
          : 'catching_up',
      )
    }

    const lastLedgerThisRun = Math.min(processingLimit, nextLedgerIndex + this.batchSize - 1)
    while (nextLedgerIndex <= lastLedgerThisRun) {
      await repository.renewLease(token, this.leaseDurationMs)
      const ledger = await source.getLedger(nextLedgerIndex)
      assertLedgerContinuity(profile, previous, ledger)
      const projection = projectLedger(ledger, profile, catalog)
      const status = this.statusForLedger(
        ledger,
        tips,
        this.replayTarget === undefined && ledger.ledgerIndex === validatedLedgerIndex
          ? 'ready'
          : 'catching_up',
      )
      const result = await repository.persistLedger(profile, projection, token, status)

      for (const registration of projection.schemaRegistrations) {
        if (registration.status !== 'accepted') continue
        catalog.set(registration.schemaUid, {
          uid: registration.schemaUid,
          definition: registration.definition,
          resolved: registration.resolved,
          publisher: registration.publisher,
          networkId: profile.networkId,
          ledgerIndex: ledger.ledgerIndex,
          transactionIndex: registration.transactionIndex,
          name: registration.definition.name,
          description: registration.definition.description,
          transactionHash: registration.transactionHash,
        })
      }

      previous = checkpointFromLedger(ledger)
      this.lastAgreed = {
        ledgerIndex: ledger.ledgerIndex,
        ledgerHash: ledger.ledgerHash,
      }
      nextLedgerIndex += 1
      if (result === 'inserted') {
        processed += 1
        this.options.observer?.ledgerProcessed?.({
          ledgerIndex: ledger.ledgerIndex,
          schemaEvents: projection.schemaRegistrations.length,
          credentialEvents: projection.credentialMutations.length,
          malformedCredentialNodes: projection.malformedCredentialNodes,
        })
      }
    }

    if (nextLedgerIndex > processingLimit) {
      if (this.replayTarget !== undefined) this.replayCompleted = true
      this.options.observer?.caughtUp?.(previous?.ledgerIndex ?? processingLimit)
    }
    return processed
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.activeLease !== undefined) throw new Error('IndexerWorker is already running')

    const { source, profile, repository } = this.options
    let failure: unknown
    let haltAttempted = false

    try {
      await repository.initializeProfile(profile)
      const acquired = await repository.acquireLease(
        profile.profileId,
        this.writerId,
        this.leaseDurationMs,
      )
      this.activeLease = acquired

      await source.connect()
      await repository.renewLease(acquired, this.leaseDurationMs)
      const preflight = await source.preflight(profile)
      this.lastTips = preflight.tips
      await repository.renewLease(acquired, this.leaseDurationMs)

      let replayLedger: ValidatedLedger | undefined
      if (this.replayTarget !== undefined) {
        if (this.replayTarget.ledgerIndex > preflight.tips.effective) {
          throw new ReplayTargetError(
            'REPLAY_TARGET_UNAVAILABLE',
            `Replay target ${this.replayTarget.ledgerIndex} is ahead of the XRPL quorum tip ${preflight.tips.effective}`,
          )
        }
        replayLedger = await source.getLedger(this.replayTarget.ledgerIndex)
        if (
          replayLedger.ledgerIndex !== this.replayTarget.ledgerIndex ||
          replayLedger.ledgerHash !== this.replayTarget.ledgerHash
        ) {
          throw new ReplayTargetError(
            'REPLAY_TARGET_MISMATCH',
            `XRPL quorum evidence does not match replay target ${this.replayTarget.ledgerIndex}`,
          )
        }
        this.replayTargetVerified = true
        await repository.renewLease(acquired, this.leaseDurationMs)
      }

      const checkpoint = await repository.getLastCheckpoint(profile.profileId)
      if (checkpoint !== undefined) {
        assertCheckpointHasEvidence(checkpoint)
        if (
          this.replayTarget !== undefined &&
          checkpoint.ledgerIndex > this.replayTarget.ledgerIndex
        ) {
          throw new ReplayTargetError(
            'REPLAY_TARGET_EXCEEDED',
            `Persisted checkpoint ${checkpoint.ledgerIndex} is ahead of replay target ${this.replayTarget.ledgerIndex}`,
          )
        }
        if (checkpoint.ledgerIndex > preflight.tips.effective) {
          sourceFailure(
            'SOURCE_TIP_REGRESSION',
            `Persisted checkpoint ${checkpoint.ledgerIndex} is ahead of the XRPL quorum tip ${preflight.tips.effective}`,
          )
        }
        const agreedCheckpoint =
          replayLedger !== undefined && checkpoint.ledgerIndex === replayLedger.ledgerIndex
            ? replayLedger
            : await source.getLedger(checkpoint.ledgerIndex)
        assertCheckpointMatchesLedger(checkpoint, agreedCheckpoint)
        this.lastAgreed = {
          ledgerIndex: checkpoint.ledgerIndex,
          ledgerHash: checkpoint.ledgerHash,
        }
      }
      await repository.renewLease(acquired, this.leaseDurationMs)
      await this.persistRuntimeStatus(acquired, 'catching_up')

      while (!signal.aborted) {
        await this.runOnce(acquired)
        if (this.replayCompleted) break
        await wait(this.pollIntervalMs, signal)
      }
    } catch (error) {
      failure = error
      if (this.activeLease !== undefined) {
        const [haltResult] = await Promise.allSettled([
          repository.haltIndexer(
            this.activeLease,
            {
              ...(this.lastTips === undefined
                ? {}
                : {
                    primarySourceTip: this.lastTips.primary,
                    secondarySourceTip: this.lastTips.secondary,
                  }),
              ...(this.lastAgreed === undefined
                ? {}
                : {
                    lastAgreedLedgerIndex: this.lastAgreed.ledgerIndex,
                    lastAgreedLedgerHash: this.lastAgreed.ledgerHash,
                  }),
            },
            sourceErrorCode(error),
          ),
        ])
        haltAttempted = haltResult.status === 'fulfilled'
      }
    }

    const [disconnectResult] = await Promise.allSettled([source.disconnect()])
    let releaseResult: PromiseSettledResult<void> | undefined
    if (!haltAttempted && this.activeLease !== undefined) {
      ;[releaseResult] = await Promise.allSettled([repository.releaseLease(this.activeLease)])
    }
    this.activeLease = undefined

    if (failure === undefined && disconnectResult.status === 'rejected') {
      failure = disconnectResult.reason
    }
    if (failure === undefined && releaseResult?.status === 'rejected') {
      failure = releaseResult.reason
    }
    if (failure !== undefined) {
      this.options.observer?.failed?.(failure)
      throw failure
    }
  }

  private requireActiveLease(): IndexerLeaseToken {
    if (this.activeLease === undefined) {
      throw new Error('IndexerWorker has no active writer lease')
    }
    return this.activeLease
  }

  private statusForLedger(
    ledger: ValidatedLedger,
    tips: LedgerSourceTips,
    state: 'catching_up' | 'ready',
  ): IndexerStatusUpdate {
    return {
      state,
      primarySourceTip: tips.primary,
      secondarySourceTip: tips.secondary,
      lastAgreedLedgerIndex: ledger.ledgerIndex,
      lastAgreedLedgerHash: ledger.ledgerHash,
    }
  }

  private async persistRuntimeStatus(
    token: IndexerLeaseToken,
    state: 'catching_up' | 'ready',
  ): Promise<void> {
    const { repository } = this.options
    await repository.updateIndexerStatus(token, {
      state,
      ...(this.lastTips === undefined
        ? {}
        : {
            primarySourceTip: this.lastTips.primary,
            secondarySourceTip: this.lastTips.secondary,
          }),
      ...(this.lastAgreed === undefined
        ? {}
        : {
            lastAgreedLedgerIndex: this.lastAgreed.ledgerIndex,
            lastAgreedLedgerHash: this.lastAgreed.ledgerHash,
          }),
    })
  }
}
