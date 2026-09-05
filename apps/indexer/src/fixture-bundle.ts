import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rmdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { parseNetworkProfile, type NetworkProfile } from '@xcs-protocol/core'

import { assertLedgerContinuity, assertTransactionOrdering } from './continuity.js'
import { canonicalJson, encodeUtf8, parseJson, sha256Hex } from './serialization.js'
import type {
  Checkpoint,
  LedgerSource,
  LedgerSourcePreflight,
  LedgerSourceTips,
  LedgerTransaction,
  ValidatedLedger,
} from './types.js'

export const LEDGER_FIXTURE_BUNDLE_FORMAT = 'xcs-ledger-bundle/1' as const
export const LEDGER_FIXTURE_MAX_MANIFEST_BYTES = 32 * 1024 * 1024
export const LEDGER_FIXTURE_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024
export const LEDGER_FIXTURE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
export const LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK = 4096
export const LEDGER_FIXTURE_MAX_INDEX_COMPRESSED_BYTES = 8 * 1024 * 1024
export const LEDGER_FIXTURE_MAX_INDEX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const OPERATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u
const UINT32_MAX = 0xffff_ffff

export type LedgerFixtureBundleErrorCode =
  | 'FIXTURE_BUNDLE_INVALID'
  | 'FIXTURE_BUNDLE_OUTPUT_EXISTS'
  | 'FIXTURE_BUNDLE_RANGE_INVALID'
  | 'FIXTURE_BUNDLE_SOURCE_UNAVAILABLE'
  | 'FIXTURE_BUNDLE_INTEGRITY_FAILED'

export class LedgerFixtureBundleError extends Error {
  constructor(
    readonly code: LedgerFixtureBundleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LedgerFixtureBundleError'
  }
}

export interface LedgerFixtureEntry {
  ledgerIndex: number
  ledgerHash: string
  parentHash: string
  transactionRoot: string
  contentSha256: string
  compressedSha256: string
}

export interface LedgerFixtureIndexChunk {
  from: number
  to: number
  contentSha256: string
  compressedSha256: string
}

export interface LedgerFixtureBundleManifest {
  format: typeof LEDGER_FIXTURE_BUNDLE_FORMAT
  capturedAt: string
  profile: NetworkProfile
  profileFileSha256: string
  sources: {
    consensus: 'normalized-exact-dual-rippled'
    primaryOperator: string
    secondaryOperator: string
  }
  sourceTips: LedgerSourceTips
  range: { from: number; to: number }
  index: {
    entriesPerChunk: typeof LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK
    chunks: LedgerFixtureIndexChunk[]
  }
}

export interface CaptureLedgerFixtureBundleInput {
  outputDirectory: string
  profile: NetworkProfile
  profileFileBytes: Uint8Array
  source: LedgerSource
  toLedgerIndex: number
  primaryOperator: string
  secondaryOperator: string
  capturedAt?: Date
}

function fail(code: LedgerFixtureBundleErrorCode, message: string, cause?: unknown): never {
  throw new LedgerFixtureBundleError(code, message, cause === undefined ? undefined : { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('FIXTURE_BUNDLE_INVALID', `${label} contains unsupported properties`)
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('FIXTURE_BUNDLE_INVALID', `${label} must be a non-empty string`)
  }
  return value
}

function hash(value: unknown, label: string): string {
  const raw = string(value, label)
  if (!HASH_PATTERN.test(raw)) {
    return fail('FIXTURE_BUNDLE_INVALID', `${label} must be a lowercase 32-byte hash`)
  }
  return raw
}

function uint32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    return fail('FIXTURE_BUNDLE_INVALID', `${label} must be a uint32`)
  }
  return value
}

function canonicalBytes(value: unknown): Uint8Array {
  try {
    return encodeUtf8(canonicalJson(value))
  } catch (error) {
    return fail('FIXTURE_BUNDLE_INVALID', 'Fixture data must be canonicalizable JSON', error)
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

async function readFileBounded(path: string, maximumBytes: number): Promise<Uint8Array> {
  const pathStats = await lstat(path)
  if (!pathStats.isFile()) {
    return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture path must be a regular file')
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  )
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size < 1 || stats.size > maximumBytes) {
      return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture file size is outside safe limits')
    }

    // Read one byte beyond the observed size so a concurrently replaced/growing file fails closed.
    const expectedBytes = Number(stats.size)
    const buffer = Buffer.allocUnsafe(expectedBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead !== expectedBytes) {
      return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture file changed while being read')
    }
    return buffer.subarray(0, expectedBytes)
  } finally {
    await handle.close()
  }
}

function profileFromFileBytes(bytes: Uint8Array): NetworkProfile {
  let parsed: unknown
  try {
    parsed = parseJson(bytes)
  } catch (error) {
    return fail('FIXTURE_BUNDLE_INVALID', 'profile file must be strict UTF-8 JSON', error)
  }
  return fixtureNetworkProfile(parsed, 'profile file')
}

function fixtureNetworkProfile(value: unknown, label: string): NetworkProfile {
  try {
    return parseNetworkProfile(value)
  } catch (error) {
    return fail('FIXTURE_BUNDLE_INVALID', `${label} is not a valid network profile`, error)
  }
}

function parseTransaction(value: unknown, position: number): LedgerTransaction {
  if (!isRecord(value)) {
    return fail('FIXTURE_BUNDLE_INVALID', `ledger transaction ${position} must be an object`)
  }
  exactKeys(value, ['hash', 'transaction', 'metadata', 'transactionIndex'], 'ledger transaction')
  const transactionHash = hash(value.hash, `ledger transaction ${position}.hash`)
  const transactionIndex = uint32(
    value.transactionIndex,
    `ledger transaction ${position}.transactionIndex`,
  )
  if (transactionIndex !== position) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      `ledger transaction index ${transactionIndex} is not contiguous at position ${position}`,
    )
  }
  if (!isRecord(value.transaction) || !isRecord(value.metadata)) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      `ledger transaction ${position} must contain transaction and metadata objects`,
    )
  }
  if (
    typeof value.transaction.TransactionType !== 'string' ||
    value.transaction.TransactionType.length === 0 ||
    !Array.isArray(value.metadata.AffectedNodes) ||
    typeof value.metadata.TransactionResult !== 'string' ||
    value.metadata.TransactionResult.length === 0 ||
    value.metadata.TransactionIndex !== transactionIndex
  ) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      `ledger transaction ${position} is missing normalized transaction evidence`,
    )
  }
  canonicalBytes(value.transaction)
  canonicalBytes(value.metadata)
  return {
    hash: transactionHash,
    transaction: value.transaction,
    metadata: value.metadata,
    transactionIndex,
  }
}

function parseLedger(value: unknown): ValidatedLedger {
  if (!isRecord(value)) return fail('FIXTURE_BUNDLE_INVALID', 'ledger fixture must be an object')
  exactKeys(
    value,
    [
      'ledgerIndex',
      'ledgerHash',
      'parentHash',
      'accountRoot',
      'transactionRoot',
      'parentCloseTime',
      'closeTime',
      'closeTimeResolution',
      'closeFlags',
      'totalCoins',
      'transactions',
    ],
    'ledger fixture',
  )
  if (!Array.isArray(value.transactions)) {
    return fail('FIXTURE_BUNDLE_INVALID', 'ledger transactions must be an array')
  }
  const transactions = value.transactions.map(parseTransaction)
  const transactionHashes = new Set(transactions.map((transaction) => transaction.hash))
  if (transactionHashes.size !== transactions.length) {
    return fail('FIXTURE_BUNDLE_INVALID', 'ledger fixture contains duplicate transaction hashes')
  }
  const totalCoins = string(value.totalCoins, 'ledger.totalCoins')
  if (
    totalCoins.length > 20 ||
    !/^(?:0|[1-9]\d*)$/u.test(totalCoins) ||
    BigInt(totalCoins) > 0xffff_ffff_ffff_ffffn
  ) {
    return fail('FIXTURE_BUNDLE_INVALID', 'ledger.totalCoins must be a canonical uint64 string')
  }
  const ledger: ValidatedLedger = {
    ledgerIndex: uint32(value.ledgerIndex, 'ledger.ledgerIndex'),
    ledgerHash: hash(value.ledgerHash, 'ledger.ledgerHash'),
    parentHash: hash(value.parentHash, 'ledger.parentHash'),
    accountRoot: hash(value.accountRoot, 'ledger.accountRoot'),
    transactionRoot: hash(value.transactionRoot, 'ledger.transactionRoot'),
    parentCloseTime: uint32(value.parentCloseTime, 'ledger.parentCloseTime'),
    closeTime: uint32(value.closeTime, 'ledger.closeTime'),
    closeTimeResolution: uint32(value.closeTimeResolution, 'ledger.closeTimeResolution'),
    closeFlags: uint32(value.closeFlags, 'ledger.closeFlags'),
    totalCoins,
    transactions,
  }
  try {
    assertTransactionOrdering(ledger)
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      'ledger fixture transaction ordering is inconsistent',
      error,
    )
  }
  return ledger
}

function parseTips(value: unknown): LedgerSourceTips {
  if (!isRecord(value)) return fail('FIXTURE_BUNDLE_INVALID', 'sourceTips must be an object')
  exactKeys(value, ['primary', 'secondary', 'effective'], 'sourceTips')
  const tips = {
    primary: uint32(value.primary, 'sourceTips.primary'),
    secondary: uint32(value.secondary, 'sourceTips.secondary'),
    effective: uint32(value.effective, 'sourceTips.effective'),
  }
  if (tips.effective !== Math.min(tips.primary, tips.secondary)) {
    return fail('FIXTURE_BUNDLE_INVALID', 'sourceTips.effective must be the minimum source tip')
  }
  return tips
}

function parseOperator(value: unknown, label: string): string {
  const operator = string(value, label)
  if (operator !== operator.trim() || !OPERATOR_PATTERN.test(operator)) {
    return fail('FIXTURE_BUNDLE_INVALID', `${label} contains unsupported characters`)
  }
  return operator
}

function parseEntry(value: unknown, position: number): LedgerFixtureEntry {
  if (!isRecord(value)) {
    return fail('FIXTURE_BUNDLE_INVALID', `ledger manifest entry ${position} must be an object`)
  }
  exactKeys(
    value,
    [
      'ledgerIndex',
      'ledgerHash',
      'parentHash',
      'transactionRoot',
      'contentSha256',
      'compressedSha256',
    ],
    'ledger manifest entry',
  )
  return {
    ledgerIndex: uint32(value.ledgerIndex, `ledgers[${position}].ledgerIndex`),
    ledgerHash: hash(value.ledgerHash, `ledgers[${position}].ledgerHash`),
    parentHash: hash(value.parentHash, `ledgers[${position}].parentHash`),
    transactionRoot: hash(value.transactionRoot, `ledgers[${position}].transactionRoot`),
    contentSha256: hash(value.contentSha256, `ledgers[${position}].contentSha256`),
    compressedSha256: hash(value.compressedSha256, `ledgers[${position}].compressedSha256`),
  }
}

function parseIndexChunk(value: unknown, position: number): LedgerFixtureIndexChunk {
  if (!isRecord(value)) {
    return fail('FIXTURE_BUNDLE_INVALID', `index chunk ${position} must be an object`)
  }
  exactKeys(value, ['from', 'to', 'contentSha256', 'compressedSha256'], 'index chunk')
  const from = uint32(value.from, `index.chunks[${position}].from`)
  const to = uint32(value.to, `index.chunks[${position}].to`)
  if (from === 0 || to < from || to - from + 1 > LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK) {
    return fail('FIXTURE_BUNDLE_INVALID', `index chunk ${position} has an invalid range`)
  }
  return {
    from,
    to,
    contentSha256: hash(value.contentSha256, `index.chunks[${position}].contentSha256`),
    compressedSha256: hash(value.compressedSha256, `index.chunks[${position}].compressedSha256`),
  }
}

function parseManifest(value: unknown): LedgerFixtureBundleManifest {
  if (!isRecord(value)) return fail('FIXTURE_BUNDLE_INVALID', 'bundle manifest must be an object')
  exactKeys(
    value,
    [
      'format',
      'capturedAt',
      'profile',
      'profileFileSha256',
      'sources',
      'sourceTips',
      'range',
      'index',
    ],
    'bundle manifest',
  )
  if (value.format !== LEDGER_FIXTURE_BUNDLE_FORMAT) {
    return fail('FIXTURE_BUNDLE_INVALID', 'unsupported ledger fixture bundle format')
  }
  const capturedAt = string(value.capturedAt, 'capturedAt')
  const capturedDate = new Date(capturedAt)
  if (!Number.isFinite(capturedDate.getTime()) || capturedDate.toISOString() !== capturedAt) {
    return fail('FIXTURE_BUNDLE_INVALID', 'capturedAt must be an exact UTC ISO-8601 timestamp')
  }
  if (!isRecord(value.sources)) {
    return fail('FIXTURE_BUNDLE_INVALID', 'sources must be an object')
  }
  exactKeys(value.sources, ['consensus', 'primaryOperator', 'secondaryOperator'], 'sources')
  if (value.sources.consensus !== 'normalized-exact-dual-rippled') {
    return fail('FIXTURE_BUNDLE_INVALID', 'bundle must record exact dual-rippled consensus')
  }
  const primaryOperator = parseOperator(value.sources.primaryOperator, 'sources.primaryOperator')
  const secondaryOperator = parseOperator(
    value.sources.secondaryOperator,
    'sources.secondaryOperator',
  )
  if (primaryOperator.toLowerCase() === secondaryOperator.toLowerCase()) {
    return fail('FIXTURE_BUNDLE_INVALID', 'source operators must be distinct')
  }
  if (!isRecord(value.range)) return fail('FIXTURE_BUNDLE_INVALID', 'range must be an object')
  exactKeys(value.range, ['from', 'to'], 'range')
  const range = {
    from: uint32(value.range.from, 'range.from'),
    to: uint32(value.range.to, 'range.to'),
  }
  if (range.from === 0 || range.to < range.from) {
    return fail('FIXTURE_BUNDLE_RANGE_INVALID', 'bundle range is invalid')
  }
  if (!isRecord(value.index)) {
    return fail('FIXTURE_BUNDLE_INVALID', 'index must be an object')
  }
  exactKeys(value.index, ['entriesPerChunk', 'chunks'], 'index')
  if (value.index.entriesPerChunk !== LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK) {
    return fail('FIXTURE_BUNDLE_INVALID', 'index.entriesPerChunk is unsupported')
  }
  if (!Array.isArray(value.index.chunks) || value.index.chunks.length === 0) {
    return fail('FIXTURE_BUNDLE_INVALID', 'index.chunks must be a non-empty array')
  }
  const chunks = value.index.chunks.map(parseIndexChunk)
  chunks.forEach((chunk, position) => {
    const expectedFrom = position === 0 ? range.from : chunks[position - 1]!.to + 1
    const expectedTo = Math.min(expectedFrom + LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK - 1, range.to)
    if (chunk.from !== expectedFrom || chunk.to !== expectedTo) {
      fail('FIXTURE_BUNDLE_INVALID', 'index chunks must be aligned and contiguous')
    }
  })
  if (chunks.at(-1)!.to !== range.to) {
    return fail('FIXTURE_BUNDLE_INVALID', 'index chunks must cover the exact bundle range')
  }
  const profile = fixtureNetworkProfile(value.profile, 'bundle profile')
  if (profile.activationLedgerIndex !== range.from) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      'bundle must begin at the profile activation ledger index',
    )
  }
  const sourceTips = parseTips(value.sourceTips)
  if (sourceTips.effective < range.to) {
    return fail('FIXTURE_BUNDLE_INVALID', 'bundle range exceeds the captured source quorum tip')
  }
  return {
    format: LEDGER_FIXTURE_BUNDLE_FORMAT,
    capturedAt,
    profile,
    profileFileSha256: hash(value.profileFileSha256, 'profileFileSha256'),
    sources: {
      consensus: 'normalized-exact-dual-rippled',
      primaryOperator,
      secondaryOperator,
    },
    sourceTips,
    range,
    index: {
      entriesPerChunk: LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK,
      chunks,
    },
  }
}

function checkpoint(ledger: ValidatedLedger): Checkpoint {
  return {
    ledgerIndex: ledger.ledgerIndex,
    ledgerHash: ledger.ledgerHash,
    parentHash: ledger.parentHash,
    closeTime: ledger.closeTime,
    transactionCount: ledger.transactions.length,
    transactionRoot: ledger.transactionRoot,
  }
}

function ledgerFile(directory: string, ledgerIndex: number): string {
  return join(directory, 'ledgers', `${ledgerIndex}.json.gz`)
}

function indexChunkFileName(chunk: Pick<LedgerFixtureIndexChunk, 'from' | 'to'>): string {
  return `${chunk.from}-${chunk.to}.json.gz`
}

function indexChunkFile(
  directory: string,
  chunk: Pick<LedgerFixtureIndexChunk, 'from' | 'to'>,
): string {
  return join(directory, 'indexes', indexChunkFileName(chunk))
}

export function ledgerFixtureBundleDigest(manifest: LedgerFixtureBundleManifest): string {
  return sha256Hex(canonicalBytes(manifest))
}

async function assertBundleRootShape(directory: string): Promise<void> {
  try {
    const expected = new Set(['manifest.json', 'indexes', 'ledgers'])
    const rootDirectory = await opendir(directory)
    for await (const entry of rootDirectory) {
      const expectedType =
        entry.name === 'manifest.json'
          ? entry.isFile()
          : entry.name === 'indexes' || entry.name === 'ledgers'
            ? entry.isDirectory()
            : false
      if (!expectedType || !expected.delete(entry.name)) {
        return fail(
          'FIXTURE_BUNDLE_INTEGRITY_FAILED',
          'fixture bundle must contain only manifest.json, indexes and ledgers',
        )
      }
    }
    if (expected.size !== 0) {
      return fail(
        'FIXTURE_BUNDLE_INTEGRITY_FAILED',
        'fixture bundle must contain manifest.json, indexes and ledgers',
      )
    }
  } catch (error) {
    if (error instanceof LedgerFixtureBundleError) throw error
    return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture bundle inventory is invalid', error)
  }
}

async function assertExactLedgerInventory(
  directory: string,
  manifest: LedgerFixtureBundleManifest,
): Promise<void> {
  try {
    let ledgerFileCount = 0
    const ledgerDirectory = await opendir(join(directory, 'ledgers'))
    for await (const entry of ledgerDirectory) {
      const match = /^([1-9]\d{0,9})\.json\.gz$/u.exec(entry.name)
      const ledgerIndex = match === null ? Number.NaN : Number(match[1])
      if (
        !entry.isFile() ||
        !Number.isInteger(ledgerIndex) ||
        ledgerIndex < manifest.range.from ||
        ledgerIndex > manifest.range.to
      ) {
        return fail(
          'FIXTURE_BUNDLE_INTEGRITY_FAILED',
          'fixture bundle contains an unexpected ledger entry',
        )
      }
      ledgerFileCount += 1
    }
    if (ledgerFileCount !== manifest.range.to - manifest.range.from + 1) {
      return fail(
        'FIXTURE_BUNDLE_INTEGRITY_FAILED',
        'fixture bundle ledger inventory does not exactly match the manifest',
      )
    }

    const expectedIndexFiles = new Set(
      manifest.index.chunks.map((chunk) => indexChunkFileName(chunk)),
    )
    const indexDirectory = await opendir(join(directory, 'indexes'))
    for await (const entry of indexDirectory) {
      if (!entry.isFile() || !expectedIndexFiles.delete(entry.name)) {
        return fail(
          'FIXTURE_BUNDLE_INTEGRITY_FAILED',
          'fixture bundle contains an unexpected index entry',
        )
      }
    }
    if (expectedIndexFiles.size !== 0) {
      return fail(
        'FIXTURE_BUNDLE_INTEGRITY_FAILED',
        'fixture bundle index inventory does not exactly match the manifest',
      )
    }
  } catch (error) {
    if (error instanceof LedgerFixtureBundleError) throw error
    return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture bundle inventory is invalid', error)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function publishBundleNoClobber(
  temporaryDirectory: string,
  outputDirectory: string,
  manifest: LedgerFixtureBundleManifest,
): Promise<void> {
  let outputCreated = false
  let indexesCreated = false
  let ledgersCreated = false
  let linkedChunkCount = 0
  let lastLinkedLedgerIndex = manifest.range.from - 1
  let manifestLinked = false
  try {
    try {
      await mkdir(outputDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('FIXTURE_BUNDLE_OUTPUT_EXISTS', 'fixture output directory already exists')
      }
      throw error
    }
    outputCreated = true
    await mkdir(join(outputDirectory, 'indexes'), { mode: 0o700 })
    indexesCreated = true
    await mkdir(join(outputDirectory, 'ledgers'), { mode: 0o700 })
    ledgersCreated = true

    for (const chunk of manifest.index.chunks) {
      const destination = indexChunkFile(outputDirectory, chunk)
      await link(indexChunkFile(temporaryDirectory, chunk), destination)
      linkedChunkCount += 1
    }
    for (
      let ledgerIndex = manifest.range.from;
      ledgerIndex <= manifest.range.to;
      ledgerIndex += 1
    ) {
      const destination = ledgerFile(outputDirectory, ledgerIndex)
      await link(ledgerFile(temporaryDirectory, ledgerIndex), destination)
      lastLinkedLedgerIndex = ledgerIndex
    }

    // The manifest is the completion marker and is linked only after all committed evidence.
    const manifestDestination = join(outputDirectory, 'manifest.json')
    await link(join(temporaryDirectory, 'manifest.json'), manifestDestination)
    manifestLinked = true
    await chmod(join(outputDirectory, 'indexes'), 0o755)
    await chmod(join(outputDirectory, 'ledgers'), 0o755)
    await chmod(outputDirectory, 0o755)
  } catch (error) {
    if (manifestLinked) {
      await unlink(join(outputDirectory, 'manifest.json')).catch(() => undefined)
    }
    for (
      let ledgerIndex = lastLinkedLedgerIndex;
      ledgerIndex >= manifest.range.from;
      ledgerIndex -= 1
    ) {
      await unlink(ledgerFile(outputDirectory, ledgerIndex)).catch(() => undefined)
    }
    for (let position = linkedChunkCount - 1; position >= 0; position -= 1) {
      await unlink(indexChunkFile(outputDirectory, manifest.index.chunks[position]!)).catch(
        () => undefined,
      )
    }
    if (ledgersCreated) await rmdir(join(outputDirectory, 'ledgers')).catch(() => undefined)
    if (indexesCreated) await rmdir(join(outputDirectory, 'indexes')).catch(() => undefined)
    if (outputCreated) await rmdir(outputDirectory).catch(() => undefined)
    if (error instanceof LedgerFixtureBundleError) throw error
    return fail('FIXTURE_BUNDLE_SOURCE_UNAVAILABLE', 'fixture bundle publication failed', error)
  }
}

async function writeLedger(
  directory: string,
  ledger: ValidatedLedger,
): Promise<LedgerFixtureEntry> {
  const content = canonicalBytes(ledger)
  if (content.length > LEDGER_FIXTURE_MAX_UNCOMPRESSED_BYTES) {
    return fail('FIXTURE_BUNDLE_INVALID', 'ledger fixture exceeds the uncompressed size limit')
  }
  const compressed = gzipSync(content, { level: 9 })
  if (compressed.length > LEDGER_FIXTURE_MAX_COMPRESSED_BYTES) {
    return fail('FIXTURE_BUNDLE_INVALID', 'ledger fixture exceeds the compressed size limit')
  }
  await writeFile(ledgerFile(directory, ledger.ledgerIndex), compressed, { flag: 'wx' })
  return {
    ledgerIndex: ledger.ledgerIndex,
    ledgerHash: ledger.ledgerHash,
    parentHash: ledger.parentHash,
    transactionRoot: ledger.transactionRoot,
    contentSha256: sha256Hex(content),
    compressedSha256: sha256Hex(compressed),
  }
}

async function writeIndexChunk(
  directory: string,
  entries: LedgerFixtureEntry[],
): Promise<LedgerFixtureIndexChunk> {
  const first = entries[0]
  const last = entries.at(-1)
  if (
    first === undefined ||
    last === undefined ||
    entries.length > LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK
  ) {
    return fail('FIXTURE_BUNDLE_INVALID', 'fixture index chunk entries are invalid')
  }
  const chunkRange = { from: first.ledgerIndex, to: last.ledgerIndex }
  const content = canonicalBytes(entries)
  if (content.length > LEDGER_FIXTURE_MAX_INDEX_UNCOMPRESSED_BYTES) {
    return fail('FIXTURE_BUNDLE_INVALID', 'fixture index chunk exceeds the size limit')
  }
  const compressed = gzipSync(content, { level: 9 })
  if (compressed.length > LEDGER_FIXTURE_MAX_INDEX_COMPRESSED_BYTES) {
    return fail('FIXTURE_BUNDLE_INVALID', 'compressed fixture index chunk exceeds the size limit')
  }
  await writeFile(indexChunkFile(directory, chunkRange), compressed, { flag: 'wx' })
  return {
    ...chunkRange,
    contentSha256: sha256Hex(content),
    compressedSha256: sha256Hex(compressed),
  }
}

async function readIndexChunk(
  directory: string,
  chunk: LedgerFixtureIndexChunk,
): Promise<LedgerFixtureEntry[]> {
  let compressed: Uint8Array
  try {
    compressed = await readFileBounded(
      indexChunkFile(directory, chunk),
      LEDGER_FIXTURE_MAX_INDEX_COMPRESSED_BYTES,
    )
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} is unavailable`,
      error,
    )
  }
  if (sha256Hex(compressed) !== chunk.compressedSha256) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} compressed digest does not match`,
    )
  }
  let content: Uint8Array
  try {
    content = gunzipSync(compressed, {
      maxOutputLength: LEDGER_FIXTURE_MAX_INDEX_UNCOMPRESSED_BYTES,
    })
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} is not bounded valid gzip`,
      error,
    )
  }
  if (sha256Hex(content) !== chunk.contentSha256) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} content digest does not match`,
    )
  }
  let parsed: unknown
  try {
    parsed = parseJson(content)
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} is not strict UTF-8 JSON`,
      error,
    )
  }
  if (!bytesEqual(content, canonicalBytes(parsed)) || !Array.isArray(parsed)) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} is not an exact canonical JSON array`,
    )
  }
  const entries = parsed.map(parseEntry)
  if (entries.length !== chunk.to - chunk.from + 1) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `fixture index chunk ${chunk.from}-${chunk.to} has the wrong entry count`,
    )
  }
  entries.forEach((entry, position) => {
    if (entry.ledgerIndex !== chunk.from + position) {
      fail(
        'FIXTURE_BUNDLE_INTEGRITY_FAILED',
        `fixture index chunk ${chunk.from}-${chunk.to} is not contiguous`,
      )
    }
  })
  return entries
}

async function readLedger(directory: string, entry: LedgerFixtureEntry): Promise<ValidatedLedger> {
  let compressed: Uint8Array
  try {
    compressed = await readFileBounded(
      ledgerFile(directory, entry.ledgerIndex),
      LEDGER_FIXTURE_MAX_COMPRESSED_BYTES,
    )
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} fixture is unavailable`,
      error,
    )
  }
  if (sha256Hex(compressed) !== entry.compressedSha256) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} compressed digest does not match the manifest`,
    )
  }
  let content: Uint8Array
  try {
    content = gunzipSync(compressed, {
      maxOutputLength: LEDGER_FIXTURE_MAX_UNCOMPRESSED_BYTES,
    })
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} fixture is not valid gzip`,
      error,
    )
  }
  if (sha256Hex(content) !== entry.contentSha256) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} content digest does not match the manifest`,
    )
  }
  let parsed: unknown
  try {
    parsed = parseJson(content)
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} fixture is not strict UTF-8 JSON`,
      error,
    )
  }
  if (!bytesEqual(content, canonicalBytes(parsed))) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} fixture is not encoded as exact canonical JSON`,
    )
  }
  const ledger = parseLedger(parsed)
  if (
    ledger.ledgerIndex !== entry.ledgerIndex ||
    ledger.ledgerHash !== entry.ledgerHash ||
    ledger.parentHash !== entry.parentHash ||
    ledger.transactionRoot !== entry.transactionRoot
  ) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      `ledger ${entry.ledgerIndex} evidence does not match the manifest`,
    )
  }
  return ledger
}

async function inspectLedgerFixtureBundle(
  directoryInput: string,
  expectedProfile?: NetworkProfile,
  expectedProfileFileSha256?: string,
  expectedBundleDigest?: string,
): Promise<{ directory: string; manifest: LedgerFixtureBundleManifest }> {
  const directory = resolve(directoryInput)
  await assertBundleRootShape(directory)
  let manifestInput: unknown
  let manifestBytes: Uint8Array
  try {
    manifestBytes = await readFileBounded(
      join(directory, 'manifest.json'),
      LEDGER_FIXTURE_MAX_MANIFEST_BYTES,
    )
    manifestInput = parseJson(manifestBytes)
  } catch (error) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      'fixture bundle manifest is unavailable or invalid',
      error,
    )
  }
  if (!bytesEqual(manifestBytes, canonicalBytes(manifestInput))) {
    return fail('FIXTURE_BUNDLE_INVALID', 'fixture bundle manifest is not exact canonical JSON')
  }
  const manifestDigest = sha256Hex(manifestBytes)
  const manifest = parseManifest(manifestInput)
  if (
    expectedBundleDigest !== undefined &&
    manifestDigest !== hash(expectedBundleDigest, 'expectedBundleDigest')
  ) {
    return fail(
      'FIXTURE_BUNDLE_INTEGRITY_FAILED',
      'fixture bundle digest does not match the expected evidence digest',
    )
  }
  if (
    expectedProfile !== undefined &&
    canonicalJson(manifest.profile) !== canonicalJson(expectedProfile)
  ) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      'fixture bundle profile does not match the expected profile',
    )
  }
  if (
    expectedProfileFileSha256 !== undefined &&
    manifest.profileFileSha256 !== hash(expectedProfileFileSha256, 'expectedProfileFileSha256')
  ) {
    return fail(
      'FIXTURE_BUNDLE_INVALID',
      'fixture bundle profile file digest does not match the expected profile file',
    )
  }
  await assertExactLedgerInventory(directory, manifest)
  return { directory, manifest }
}

export async function validateLedgerFixtureBundle(
  directoryInput: string,
  expectedProfile?: NetworkProfile,
  expectedProfileFileSha256?: string,
  expectedBundleDigest?: string,
): Promise<LedgerFixtureBundleManifest> {
  const { directory, manifest } = await inspectLedgerFixtureBundle(
    directoryInput,
    expectedProfile,
    expectedProfileFileSha256,
    expectedBundleDigest,
  )

  let previous: ValidatedLedger | undefined
  for (const chunk of manifest.index.chunks) {
    const entries = await readIndexChunk(directory, chunk)
    for (const entry of entries) {
      const ledger = await readLedger(directory, entry)
      try {
        assertLedgerContinuity(
          manifest.profile,
          previous === undefined ? undefined : checkpoint(previous),
          ledger,
        )
      } catch (error) {
        return fail(
          'FIXTURE_BUNDLE_INTEGRITY_FAILED',
          `ledger ${ledger.ledgerIndex} continuity evidence is inconsistent`,
          error,
        )
      }
      previous = ledger
    }
  }
  return manifest
}

export async function captureLedgerFixtureBundle(
  input: CaptureLedgerFixtureBundleInput,
): Promise<LedgerFixtureBundleManifest> {
  const profile = fixtureNetworkProfile(input.profile, 'capture profile')
  const outputDirectory = resolve(input.outputDirectory)
  if (!basename(outputDirectory) || outputDirectory === resolve('/')) {
    return fail('FIXTURE_BUNDLE_INVALID', 'fixture output must be a dedicated non-root directory')
  }
  if (await pathExists(outputDirectory)) {
    return fail('FIXTURE_BUNDLE_OUTPUT_EXISTS', 'fixture output directory already exists')
  }
  if (
    !Number.isInteger(input.toLedgerIndex) ||
    input.toLedgerIndex < profile.activationLedgerIndex ||
    input.toLedgerIndex > UINT32_MAX
  ) {
    return fail(
      'FIXTURE_BUNDLE_RANGE_INVALID',
      'fixture target must be a uint32 at or after profile activation',
    )
  }
  const primaryOperator = parseOperator(input.primaryOperator, 'primaryOperator')
  const secondaryOperator = parseOperator(input.secondaryOperator, 'secondaryOperator')
  if (primaryOperator.toLowerCase() === secondaryOperator.toLowerCase()) {
    return fail('FIXTURE_BUNDLE_INVALID', 'source operators must be distinct')
  }
  const capturedAt = (input.capturedAt ?? new Date()).toISOString()
  const fileProfile = profileFromFileBytes(input.profileFileBytes)
  if (canonicalJson(fileProfile) !== canonicalJson(profile)) {
    return fail('FIXTURE_BUNDLE_INVALID', 'profile file bytes do not describe the capture profile')
  }
  const profileFileSha256 = sha256Hex(input.profileFileBytes)

  await mkdir(dirname(outputDirectory), { recursive: true })
  const temporaryDirectory = await mkdtemp(
    join(dirname(outputDirectory), `.${basename(outputDirectory)}.tmp-`),
  )
  let sourceConnected = false
  try {
    await mkdir(join(temporaryDirectory, 'ledgers'))
    await mkdir(join(temporaryDirectory, 'indexes'))
    await input.source.connect()
    sourceConnected = true
    const preflight = await input.source.preflight(profile)
    if (
      preflight.networkId !== profile.networkId ||
      preflight.activationLedger.ledgerIndex !== profile.activationLedgerIndex ||
      preflight.activationLedger.ledgerHash !== profile.activationLedgerHash
    ) {
      return fail(
        'FIXTURE_BUNDLE_SOURCE_UNAVAILABLE',
        'source preflight does not match the profile',
      )
    }
    const tips = await input.source.getValidatedLedgerTips()
    if (tips.effective < input.toLedgerIndex) {
      return fail(
        'FIXTURE_BUNDLE_RANGE_INVALID',
        'fixture target exceeds the current dual-source quorum tip',
      )
    }

    const chunks: LedgerFixtureIndexChunk[] = []
    let pendingEntries: LedgerFixtureEntry[] = []
    let previous: ValidatedLedger | undefined
    for (
      let ledgerIndex = profile.activationLedgerIndex;
      ledgerIndex <= input.toLedgerIndex;
      ledgerIndex += 1
    ) {
      const ledger = await input.source.getLedger(ledgerIndex)
      assertLedgerContinuity(
        profile,
        previous === undefined ? undefined : checkpoint(previous),
        ledger,
      )
      pendingEntries.push(await writeLedger(temporaryDirectory, ledger))
      if (
        pendingEntries.length === LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK ||
        ledgerIndex === input.toLedgerIndex
      ) {
        chunks.push(await writeIndexChunk(temporaryDirectory, pendingEntries))
        pendingEntries = []
      }
      previous = ledger
    }

    const manifest: LedgerFixtureBundleManifest = {
      format: LEDGER_FIXTURE_BUNDLE_FORMAT,
      capturedAt,
      profile,
      profileFileSha256,
      sources: {
        consensus: 'normalized-exact-dual-rippled',
        primaryOperator,
        secondaryOperator,
      },
      sourceTips: tips,
      range: { from: profile.activationLedgerIndex, to: input.toLedgerIndex },
      index: {
        entriesPerChunk: LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK,
        chunks,
      },
    }
    const manifestBytes = canonicalBytes(manifest)
    if (manifestBytes.length > LEDGER_FIXTURE_MAX_MANIFEST_BYTES) {
      return fail('FIXTURE_BUNDLE_INVALID', 'fixture bundle manifest exceeds the size limit')
    }
    await writeFile(join(temporaryDirectory, 'manifest.json'), manifestBytes, {
      flag: 'wx',
    })
    await validateLedgerFixtureBundle(temporaryDirectory, profile, profileFileSha256)
    await input.source.disconnect()
    sourceConnected = false
    await publishBundleNoClobber(temporaryDirectory, outputDirectory, manifest)
    await rm(temporaryDirectory, { recursive: true, force: true })
    return manifest
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    if (error instanceof LedgerFixtureBundleError) throw error
    return fail('FIXTURE_BUNDLE_SOURCE_UNAVAILABLE', 'ledger fixture capture failed', error)
  } finally {
    if (sourceConnected) await input.source.disconnect().catch(() => undefined)
  }
}

export class LedgerFixtureBundleSource implements LedgerSource {
  private cachedChunk?: {
    descriptor: LedgerFixtureIndexChunk
    entries: LedgerFixtureEntry[]
  }

  private constructor(
    private readonly directory: string,
    private readonly manifest: LedgerFixtureBundleManifest,
  ) {}

  static async open(
    directory: string,
    expectedProfile: NetworkProfile,
    expectedBundleDigest: string,
    expectedProfileFileSha256?: string,
  ): Promise<LedgerFixtureBundleSource> {
    const inspected = await inspectLedgerFixtureBundle(
      directory,
      expectedProfile,
      expectedProfileFileSha256,
      expectedBundleDigest,
    )
    return new LedgerFixtureBundleSource(inspected.directory, inspected.manifest)
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async preflight(profile: NetworkProfile): Promise<LedgerSourcePreflight> {
    if (
      canonicalJson(fixtureNetworkProfile(profile, 'source profile')) !==
      canonicalJson(this.manifest.profile)
    ) {
      return fail('FIXTURE_BUNDLE_INVALID', 'fixture source profile does not match')
    }
    return {
      networkId: this.manifest.profile.networkId,
      completeLedgerRanges: [{ min: this.manifest.range.from, max: this.manifest.range.to }],
      activationLedger: await this.getLedger(this.manifest.range.from),
      tips: this.bundleTips(),
    }
  }

  async assertAmendmentEnabled(amendmentId: string): Promise<void> {
    if (amendmentId.toUpperCase() !== this.manifest.profile.requiredAmendment) {
      return fail('FIXTURE_BUNDLE_INVALID', 'fixture source amendment does not match')
    }
  }

  async getValidatedLedgerIndex(): Promise<number> {
    return this.manifest.range.to
  }

  async getValidatedLedgerTips(): Promise<LedgerSourceTips> {
    return this.bundleTips()
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    if (ledgerIndex < this.manifest.range.from || ledgerIndex > this.manifest.range.to) {
      return fail(
        'FIXTURE_BUNDLE_RANGE_INVALID',
        `ledger ${ledgerIndex} is outside the fixture range`,
      )
    }
    const chunkPosition = Math.floor(
      (ledgerIndex - this.manifest.range.from) / LEDGER_FIXTURE_INDEX_ENTRIES_PER_CHUNK,
    )
    const chunk = this.manifest.index.chunks[chunkPosition]
    if (chunk === undefined || ledgerIndex < chunk.from || ledgerIndex > chunk.to) {
      return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture index does not cover the ledger')
    }
    if (
      this.cachedChunk === undefined ||
      this.cachedChunk.descriptor.from !== chunk.from ||
      this.cachedChunk.descriptor.to !== chunk.to
    ) {
      this.cachedChunk = { descriptor: chunk, entries: await readIndexChunk(this.directory, chunk) }
    }
    const entry = this.cachedChunk.entries[ledgerIndex - chunk.from]
    if (entry === undefined || entry.ledgerIndex !== ledgerIndex) {
      return fail('FIXTURE_BUNDLE_INTEGRITY_FAILED', 'fixture index entry is unavailable')
    }
    return readLedger(this.directory, entry)
  }

  private bundleTips(): LedgerSourceTips {
    return {
      primary: this.manifest.range.to,
      secondary: this.manifest.range.to,
      effective: this.manifest.range.to,
    }
  }
}
