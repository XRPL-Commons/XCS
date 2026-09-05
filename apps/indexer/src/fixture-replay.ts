import type { NetworkProfile } from '@xcs-protocol/core'

import { LedgerFixtureBundleSource, validateLedgerFixtureBundle } from './fixture-bundle.js'
import { createReplayTarget, ReplayTargetError, type ReplayTarget } from './replay-target.js'
import { sha256Hex } from './serialization.js'

export interface PrepareFixtureReplayInput {
  readonly directory: string
  readonly bundleDigest: string
  readonly profile: NetworkProfile
  readonly profileFileBytes: Uint8Array
  readonly explicitTarget?: ReplayTarget | undefined
}

export async function prepareFixtureReplay(input: PrepareFixtureReplayInput): Promise<{
  source: LedgerFixtureBundleSource
  replayTarget: ReplayTarget
}> {
  const profileFileSha256 = sha256Hex(input.profileFileBytes)
  // Replay writes incrementally. Verify the complete immutable artifact before
  // constructing a source so corruption can never strand a partial projection.
  await validateLedgerFixtureBundle(
    input.directory,
    input.profile,
    profileFileSha256,
    input.bundleDigest,
  )
  const source = await LedgerFixtureBundleSource.open(
    input.directory,
    input.profile,
    input.bundleDigest,
    profileFileSha256,
  )
  const targetLedgerIndex = await source.getValidatedLedgerIndex()
  const targetLedger = await source.getLedger(targetLedgerIndex)
  const replayTarget = createReplayTarget(targetLedgerIndex, targetLedger.ledgerHash)
  if (
    input.explicitTarget !== undefined &&
    (input.explicitTarget.ledgerIndex !== replayTarget.ledgerIndex ||
      input.explicitTarget.ledgerHash !== replayTarget.ledgerHash)
  ) {
    throw new ReplayTargetError(
      'REPLAY_TARGET_MISMATCH',
      'Explicit replay target does not match the fixture bundle boundary',
    )
  }
  return { source, replayTarget }
}
