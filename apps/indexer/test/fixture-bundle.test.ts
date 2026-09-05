import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import type { JsonValue, NetworkProfile } from '@xcs-protocol/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  captureLedgerFixtureBundle,
  ledgerFixtureBundleDigest,
  LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK,
  LEDGER_FIXTURE_MAX_COMPRESSED_BYTES,
  LedgerFixtureBundleSource,
  validateLedgerFixtureBundle,
  type LedgerFixtureBundleManifest,
} from '../src/fixture-bundle.js'
import { prepareFixtureReplay } from '../src/fixture-replay.js'
import { canonicalJson, encodeUtf8, sha256Hex } from '../src/serialization.js'
import type {
  LedgerSource,
  LedgerSourcePreflight,
  LedgerSourceTips,
  ValidatedLedger,
} from '../src/types.js'

const HASH = {
  activation: 'a'.repeat(64),
  next: 'b'.repeat(64),
  parent: 'c'.repeat(64),
  account: 'd'.repeat(64),
  transaction: 'e'.repeat(64),
  transactionRoot: 'f'.repeat(64),
  emptyRoot: '0'.repeat(64),
}

const profile: NetworkProfile = {
  profileId: 'xrpl-testnet-xcs-v0.1-fixture',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: '1'.repeat(64),
  registryAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  registrationAmountDrops: '1',
  activationLedgerIndex: 100,
  activationLedgerHash: HASH.activation,
}

const generatedProfile: NetworkProfile = {
  ...profile,
  profileId: 'xrpl-testnet-xcs-v0.1-multi-chunk',
  activationLedgerIndex: 1,
  activationLedgerHash: sha256Hex(encodeUtf8('fixture-ledger:1')),
}

function ledger(
  ledgerIndex: number,
  ledgerHash: string,
  parentHash: string,
  withTransaction: boolean,
): ValidatedLedger {
  return {
    ledgerIndex,
    ledgerHash,
    parentHash,
    accountRoot: HASH.account,
    transactionRoot: withTransaction ? HASH.transactionRoot : HASH.emptyRoot,
    parentCloseTime: ledgerIndex + 900,
    closeTime: ledgerIndex + 901,
    closeTimeResolution: 10,
    closeFlags: 0,
    totalCoins: '99999999999999999',
    transactions: withTransaction
      ? [
          {
            hash: HASH.transaction,
            transactionIndex: 0,
            transaction: { TransactionType: 'Payment', Account: profile.registryAddress },
            metadata: {
              TransactionIndex: 0,
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [],
            },
          },
        ]
      : [],
  }
}

class FixtureSource implements LedgerSource {
  readonly ledgers = new Map<number, ValidatedLedger>([
    [100, ledger(100, HASH.activation, HASH.parent, true)],
    [101, ledger(101, HASH.next, HASH.activation, false)],
  ])
  connected = false
  disconnected = false
  onDisconnect?: () => Promise<void>

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    await this.onDisconnect?.()
  }

  async preflight(): Promise<LedgerSourcePreflight> {
    return {
      networkId: 1,
      completeLedgerRanges: [{ min: 100, max: 101 }],
      activationLedger: structuredClone(this.ledgers.get(100)!),
      tips: this.tips(),
    }
  }

  async assertAmendmentEnabled(): Promise<void> {}

  async getValidatedLedgerIndex(): Promise<number> {
    return 101
  }

  async getValidatedLedgerTips(): Promise<LedgerSourceTips> {
    return this.tips()
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    const value = this.ledgers.get(ledgerIndex)
    if (!value) throw new Error('missing ledger')
    return structuredClone(value)
  }

  private tips(): LedgerSourceTips {
    return { primary: 103, secondary: 101, effective: 101 }
  }
}

function generatedHash(value: number): string {
  return sha256Hex(encodeUtf8(`fixture-ledger:${value}`))
}

class GeneratedFixtureSource implements LedgerSource {
  readonly target = LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK + 1

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async preflight(): Promise<LedgerSourcePreflight> {
    return {
      networkId: 1,
      completeLedgerRanges: [{ min: 1, max: this.target }],
      activationLedger: this.ledger(1),
      tips: this.tips(),
    }
  }

  async assertAmendmentEnabled(): Promise<void> {}

  async getValidatedLedgerIndex(): Promise<number> {
    return this.target
  }

  async getValidatedLedgerTips(): Promise<LedgerSourceTips> {
    return this.tips()
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    if (ledgerIndex < 1 || ledgerIndex > this.target) throw new Error('missing ledger')
    return this.ledger(ledgerIndex)
  }

  private ledger(ledgerIndex: number): ValidatedLedger {
    return ledger(ledgerIndex, generatedHash(ledgerIndex), generatedHash(ledgerIndex - 1), false)
  }

  private tips(): LedgerSourceTips {
    return { primary: this.target, secondary: this.target, effective: this.target }
  }
}

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'xcs-ledger-bundle-test-'))
  temporaryRoots.push(value)
  return value
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function rewriteCanonicalLedger(
  output: string,
  manifest: LedgerFixtureBundleManifest,
  ledgerIndex: number,
  mutate: (ledger: Record<string, JsonValue>) => void,
): Promise<string> {
  const ledgerPath = join(output, 'ledgers', `${ledgerIndex}.json.gz`)
  const ledger = JSON.parse(gunzipSync(await readFile(ledgerPath)).toString('utf8')) as Record<
    string,
    JsonValue
  >
  mutate(ledger)
  const ledgerContent = encodeUtf8(canonicalJson(ledger))
  const compressedLedger = gzipSync(ledgerContent)
  await writeFile(ledgerPath, compressedLedger)

  const chunk = manifest.index.chunks.find(
    (candidate) => ledgerIndex >= candidate.from && ledgerIndex <= candidate.to,
  )!
  const chunkPath = join(output, 'indexes', `${chunk.from}-${chunk.to}.json.gz`)
  const entries = JSON.parse(gunzipSync(await readFile(chunkPath)).toString('utf8')) as Array<
    Record<string, JsonValue>
  >
  const entry = entries[ledgerIndex - chunk.from]!
  entry.ledgerHash = ledger.ledgerHash!
  entry.parentHash = ledger.parentHash!
  entry.transactionRoot = ledger.transactionRoot!
  entry.contentSha256 = sha256Hex(ledgerContent)
  entry.compressedSha256 = sha256Hex(compressedLedger)
  const indexContent = encodeUtf8(canonicalJson(entries))
  const compressedIndex = gzipSync(indexContent)
  await writeFile(chunkPath, compressedIndex)
  chunk.contentSha256 = sha256Hex(indexContent)
  chunk.compressedSha256 = sha256Hex(compressedIndex)
  await writeFile(join(output, 'manifest.json'), canonicalJson(manifest))
  return ledgerFixtureBundleDigest(manifest)
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('ledger fixture bundles', () => {
  it('captures quorum-normalized ledgers without provider URLs and validates them offline', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const source = new FixtureSource()
    const profileFileBytes = encodeUtf8(`${JSON.stringify(profile, null, 2)}\n`)

    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes,
      source,
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
      capturedAt: new Date('2026-08-25T10:00:00.000Z'),
    })

    expect(source.connected).toBe(true)
    expect(source.disconnected).toBe(true)
    expect(captured.range).toEqual({ from: 100, to: 101 })
    expect(captured.index.chunks).toHaveLength(1)
    const manifestText = await readFile(join(output, 'manifest.json'), 'utf8')
    expect(manifestText).not.toContain('wss://')
    expect(manifestText).not.toContain('rpcUrl')

    const bundleDigest = ledgerFixtureBundleDigest(captured)
    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, bundleDigest),
    ).resolves.toEqual(captured)
    const offlineSource = await LedgerFixtureBundleSource.open(output, profile, bundleDigest)
    await expect(offlineSource.preflight(profile)).resolves.toMatchObject({
      networkId: 1,
      tips: { primary: 101, secondary: 101, effective: 101 },
    })
    await expect(offlineSource.getLedger(101)).resolves.toMatchObject({
      ledgerIndex: 101,
      ledgerHash: HASH.next,
    })
    await expect(offlineSource.getLedger(102)).rejects.toMatchObject({
      code: 'FIXTURE_BUNDLE_RANGE_INVALID',
    })
  })

  it('rejects changed compressed content before parsing it', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })

    await writeFile(join(output, 'ledgers', '101.json.gz'), 'changed')
    await expect(validateLedgerFixtureBundle(output, profile)).rejects.toMatchObject({
      code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED',
    })
  })

  it('opens structure eagerly but verifies ledger content only when the source reads it', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    await writeFile(join(output, 'ledgers', '101.json.gz'), 'changed')

    const source = await LedgerFixtureBundleSource.open(
      output,
      profile,
      ledgerFixtureBundleDigest(captured),
    )
    await expect(source.getLedger(100)).resolves.toMatchObject({ ledgerIndex: 100 })
    await expect(source.getLedger(101)).rejects.toMatchObject({
      code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED',
    })
  })

  it('derives an offline replay target from profile-bound bundle evidence', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const profileFileBytes = encodeUtf8(JSON.stringify(profile))
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes,
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const bundleDigest = ledgerFixtureBundleDigest(captured)

    await expect(
      prepareFixtureReplay({
        directory: output,
        bundleDigest,
        profile,
        profileFileBytes,
      }),
    ).resolves.toMatchObject({
      replayTarget: { ledgerIndex: 101, ledgerHash: HASH.next },
    })
    await expect(
      prepareFixtureReplay({
        directory: output,
        bundleDigest,
        profile,
        profileFileBytes,
        explicitTarget: { ledgerIndex: 100, ledgerHash: HASH.activation },
      }),
    ).rejects.toMatchObject({ code: 'REPLAY_TARGET_MISMATCH' })
    await expect(
      prepareFixtureReplay({
        directory: output,
        bundleDigest,
        profile,
        profileFileBytes: encodeUtf8(`${JSON.stringify(profile)}\n`),
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })

    await writeFile(join(output, 'ledgers', '100.json.gz'), 'changed')
    await expect(
      prepareFixtureReplay({
        directory: output,
        bundleDigest,
        profile,
        profileFileBytes,
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('requires exact canonical JSON bytes for the manifest and every ledger', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const manifestPath = join(output, 'manifest.json')
    await writeFile(manifestPath, `${JSON.stringify(captured, null, 2)}\n`)
    await expect(validateLedgerFixtureBundle(output, profile)).rejects.toMatchObject({
      code: 'FIXTURE_BUNDLE_INVALID',
    })

    await writeFile(manifestPath, canonicalJson(captured))
    const ledgerPath = join(output, 'ledgers', '101.json.gz')
    const ledger = JSON.parse(gunzipSync(await readFile(ledgerPath)).toString('utf8')) as JsonValue
    const nonCanonicalLedger = encodeUtf8(`${JSON.stringify(ledger, null, 2)}\n`)
    const compressed = gzipSync(nonCanonicalLedger)
    const chunk = captured.index.chunks[0]!
    const chunkPath = join(output, 'indexes', `${chunk.from}-${chunk.to}.json.gz`)
    const entries = JSON.parse(gunzipSync(await readFile(chunkPath)).toString('utf8')) as Array<
      Record<string, JsonValue>
    >
    entries[1]!.contentSha256 = sha256Hex(nonCanonicalLedger)
    entries[1]!.compressedSha256 = sha256Hex(compressed)
    const indexContent = encodeUtf8(canonicalJson(entries))
    const compressedIndex = gzipSync(indexContent)
    chunk.contentSha256 = sha256Hex(indexContent)
    chunk.compressedSha256 = sha256Hex(compressedIndex)
    await writeFile(ledgerPath, compressed)
    await writeFile(chunkPath, compressedIndex)
    await writeFile(manifestPath, canonicalJson(captured))

    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, ledgerFixtureBundleDigest(captured)),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('rejects oversized, extra and symlinked bundle files', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const digest = ledgerFixtureBundleDigest(captured)

    await writeFile(join(output, 'unexpected.env'), 'SECRET=value')
    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, digest),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
    await rm(join(output, 'unexpected.env'))

    const ledgerPath = join(output, 'ledgers', '101.json.gz')
    const originalLedgerPath = join(root, 'original-ledger.json.gz')
    await writeFile(originalLedgerPath, await readFile(ledgerPath))
    await rm(ledgerPath)
    await symlink(originalLedgerPath, ledgerPath)
    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, digest),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
    await rm(ledgerPath)
    await writeFile(ledgerPath, await readFile(originalLedgerPath))

    await truncate(ledgerPath, LEDGER_FIXTURE_MAX_COMPRESSED_BYTES + 1)
    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, digest),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('rejects an evidence digest that does not match the canonical manifest', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })

    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, '0'.repeat(64)),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('maps invalid capture and manifest profiles to the fixture error contract', async () => {
    const root = await temporaryRoot()
    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: join(root, 'invalid-capture'),
        profile: { ...profile, networkId: -1 },
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source: new FixtureSource(),
        toLedgerIndex: 101,
        primaryOperator: 'XRPL Commons',
        secondaryOperator: 'Independent Operator',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })

    const output = join(root, 'invalid-manifest')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    captured.profile.networkId = -1
    await writeFile(join(output, 'manifest.json'), canonicalJson(captured))
    await expect(
      validateLedgerFixtureBundle(
        output,
        undefined,
        undefined,
        ledgerFixtureBundleDigest(captured),
      ),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })
  })

  it('rejects an altered index chunk and a manifest with misaligned chunk ranges', async () => {
    const root = await temporaryRoot()
    const alteredOutput = join(root, 'altered-index')
    const altered = await captureLedgerFixtureBundle({
      outputDirectory: alteredOutput,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const alteredChunk = altered.index.chunks[0]!
    await writeFile(
      join(alteredOutput, 'indexes', `${alteredChunk.from}-${alteredChunk.to}.json.gz`),
      'changed',
    )
    await expect(
      validateLedgerFixtureBundle(
        alteredOutput,
        profile,
        undefined,
        ledgerFixtureBundleDigest(altered),
      ),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })

    const misalignedOutput = join(root, 'misaligned-index')
    const misaligned = await captureLedgerFixtureBundle({
      outputDirectory: misalignedOutput,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const originalChunk = misaligned.index.chunks[0]!
    misaligned.index.chunks = [
      { ...originalChunk, to: 100 },
      { ...originalChunk, from: 100 },
    ]
    await writeFile(join(misalignedOutput, 'manifest.json'), canonicalJson(misaligned))
    await expect(
      validateLedgerFixtureBundle(
        misalignedOutput,
        profile,
        undefined,
        ledgerFixtureBundleDigest(misaligned),
      ),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })
  })

  it('requires exact canonical JSON bytes for every index chunk', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'non-canonical-index')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const chunk = captured.index.chunks[0]!
    const chunkPath = join(output, 'indexes', `${chunk.from}-${chunk.to}.json.gz`)
    const entries = JSON.parse(gunzipSync(await readFile(chunkPath)).toString('utf8')) as JsonValue
    const nonCanonicalIndex = encodeUtf8(`${JSON.stringify(entries, null, 2)}\n`)
    const compressedIndex = gzipSync(nonCanonicalIndex)
    await writeFile(chunkPath, compressedIndex)
    chunk.contentSha256 = sha256Hex(nonCanonicalIndex)
    chunk.compressedSha256 = sha256Hex(compressedIndex)
    await writeFile(join(output, 'manifest.json'), canonicalJson(captured))

    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, ledgerFixtureBundleDigest(captured)),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('maps broken ledger continuity to the fixture integrity contract', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'broken-continuity')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const digest = await rewriteCanonicalLedger(output, captured, 101, (candidate) => {
      candidate.parentHash = '9'.repeat(64)
    })

    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, digest),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INTEGRITY_FAILED' })
  })

  it('rejects total coin strings before attempting an unbounded bigint conversion', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'oversized-total-coins')
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile,
      profileFileBytes: encodeUtf8(JSON.stringify(profile)),
      source: new FixtureSource(),
      toLedgerIndex: 101,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })
    const digest = await rewriteCanonicalLedger(output, captured, 101, (candidate) => {
      candidate.totalCoins = '9'.repeat(21)
    })

    await expect(
      validateLedgerFixtureBundle(output, profile, undefined, digest),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })
  })

  it('captures multiple index chunks and reads distant ledgers lazily', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'multi-chunk')
    const source = new GeneratedFixtureSource()
    const captured = await captureLedgerFixtureBundle({
      outputDirectory: output,
      profile: generatedProfile,
      profileFileBytes: encodeUtf8(JSON.stringify(generatedProfile)),
      source,
      toLedgerIndex: source.target,
      primaryOperator: 'XRPL Commons',
      secondaryOperator: 'Independent Operator',
    })

    expect(captured.index.chunks).toHaveLength(2)
    expect(captured.index.chunks[0]).toMatchObject({
      from: 1,
      to: LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK,
    })
    expect(captured.index.chunks[1]).toMatchObject({
      from: source.target,
      to: source.target,
    })
    const fixtureSource = await LedgerFixtureBundleSource.open(
      output,
      generatedProfile,
      ledgerFixtureBundleDigest(captured),
    )
    await expect(fixtureSource.getLedger(1)).resolves.toMatchObject({ ledgerIndex: 1 })
    await expect(fixtureSource.getLedger(source.target)).resolves.toMatchObject({
      ledgerIndex: source.target,
    })
  }, 30_000)

  it('removes partial output when ledger continuity fails', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'bundle')
    const source = new FixtureSource()
    source.ledgers.get(101)!.parentHash = '9'.repeat(64)

    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: output,
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source,
        toLedgerIndex: 101,
        primaryOperator: 'XRPL Commons',
        secondaryOperator: 'Independent Operator',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_SOURCE_UNAVAILABLE' })
    expect(await exists(output)).toBe(false)
    expect(source.disconnected).toBe(true)
  })

  it('refuses an existing target and non-independent operator labels', async () => {
    const root = await temporaryRoot()
    const existing = join(root, 'existing')
    await writeFile(existing, 'occupied')
    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: existing,
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source: new FixtureSource(),
        toLedgerIndex: 101,
        primaryOperator: 'same',
        secondaryOperator: 'different',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_OUTPUT_EXISTS' })

    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: join(root, 'operators'),
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source: new FixtureSource(),
        toLedgerIndex: 101,
        primaryOperator: 'same',
        secondaryOperator: 'SAME',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })

    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: join(root, 'operator-whitespace'),
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source: new FixtureSource(),
        toLedgerIndex: 101,
        primaryOperator: ' XRPL Commons ',
        secondaryOperator: 'Independent Operator',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })
  })

  it('does not replace a target directory created while capture is running', async () => {
    const root = await temporaryRoot()
    const output = join(root, 'raced-output')
    const source = new FixtureSource()
    source.onDisconnect = async () => {
      await mkdir(output)
      await writeFile(join(output, 'owner-marker'), 'keep')
    }

    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: output,
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(profile)),
        source,
        toLedgerIndex: 101,
        primaryOperator: 'XRPL Commons',
        secondaryOperator: 'Independent Operator',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_OUTPUT_EXISTS' })
    await expect(readFile(join(output, 'owner-marker'), 'utf8')).resolves.toBe('keep')
  })

  it('binds the byte-level profile digest to the profile used for capture', async () => {
    const root = await temporaryRoot()
    const differentProfile = { ...profile, profileId: 'different-profile' }

    await expect(
      captureLedgerFixtureBundle({
        outputDirectory: join(root, 'mismatch'),
        profile,
        profileFileBytes: encodeUtf8(JSON.stringify(differentProfile)),
        source: new FixtureSource(),
        toLedgerIndex: 101,
        primaryOperator: 'XRPL Commons',
        secondaryOperator: 'Independent Operator',
      }),
    ).rejects.toMatchObject({ code: 'FIXTURE_BUNDLE_INVALID' })
  })
})
