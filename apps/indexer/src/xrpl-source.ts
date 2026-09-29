import { createHash } from 'node:crypto'
import { decodeLedgerData } from 'ripple-binary-codec'
import { Client, decode, hashes } from 'xrpl'

import {
  assertRegistryPolicy,
  assertSourceCoversProfile,
  normalizeAccountObjectsPage,
  normalizeServerInfo,
} from './profile-preflight.js'
import { sourceFailure, XrplSourceError } from './source-errors.js'
import type {
  LedgerSource,
  LedgerSourcePreflight,
  LedgerSourceTips,
  LedgerTransaction,
  NetworkProfile,
  RegistryPolicy,
  ValidatedLedger,
} from './types.js'

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function uint(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a uint32`)
  }
  return value
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a 32-byte hexadecimal hash`)
  }
  return value.toLowerCase()
}

function uint64String(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a canonical uint64 string`)
  }
  if (BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a canonical uint64 string`)
  }
  return value
}

function matchingHash(values: unknown[], label: string): string {
  const present = values.filter((value) => value !== undefined)
  if (present.length === 0) return hash(undefined, label)
  const normalized = present.map((value) => hash(value, label))
  if (normalized.some((value) => value !== normalized[0])) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} values disagree inside one response`)
  }
  return normalized[0]!
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a non-empty string`)
  }
  return value
}

function binaryHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/u.test(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be binary hex`)
  }
  return value.toUpperCase()
}

function decodedTransaction(envelope: Record<string, unknown>): Record<string, unknown> {
  const blob = binaryHex(envelope.tx_blob, 'transaction blob')
  const meta = binaryHex(
    Object.hasOwn(envelope, 'meta_blob') ? envelope.meta_blob : envelope.meta,
    'transaction metadata blob',
  )
  if (
    Object.hasOwn(envelope, 'meta_blob') &&
    Object.hasOwn(envelope, 'meta') &&
    binaryHex(envelope.meta, 'transaction metadata blob') !== meta
  ) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Binary metadata representations disagree')
  }
  try {
    const transaction = decode(blob)
    const metadata = decode(meta)
    // xrpl's signed-transaction helper deliberately rejects protocol pseudo-transactions.
    // Their ID uses the same TXN\0 domain, although no account signs these ledger operations.
    const pseudo = ['EnableAmendment', 'SetFee', 'UNLModify'].includes(
      String(transaction.TransactionType),
    )
    const transactionHash = pseudo
      ? createHash('sha512')
          .update(Buffer.from('54584E00' + blob, 'hex'))
          .digest('hex')
          .slice(0, 64)
      : hashes.hashSignedTx(blob)
    if (
      envelope.hash !== undefined &&
      hash(envelope.hash, 'transaction hash') !== transactionHash.toLowerCase()
    ) {
      return sourceFailure('SOURCE_RESPONSE_INVALID', 'Binary transaction hash values disagree')
    }
    // Always decode the serialized fields: API v2 JSON can rename Amount to DeliverMax.
    return { hash: transactionHash, tx_json: transaction, meta: metadata }
  } catch (error) {
    if (error instanceof XrplSourceError) throw error
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Cannot decode binary transaction or metadata')
  }
}

function decodedLedgerHeader(envelope: Record<string, unknown>): Record<string, unknown> {
  const blob = binaryHex(envelope.ledger_data, 'ledger header blob')
  // The canonical header is 118 bytes, excluding the LWR\0 hash prefix.
  if (blob.length !== 236)
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Binary ledger header length is invalid')
  try {
    const header = asRecord(decodeLedgerData(blob), 'decoded ledger header')
    return {
      ...header,
      ledger_hash: hashes.hashLedgerHeader(
        header as unknown as Parameters<typeof hashes.hashLedgerHeader>[0],
      ),
      closed: envelope.closed,
      transactions: envelope.transactions,
    }
  } catch (error) {
    if (error instanceof XrplSourceError) throw error
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Cannot decode binary ledger header')
  }
}

function normalizeTransaction(value: unknown): LedgerTransaction {
  const raw = asRecord(value, 'expanded ledger transaction')
  const envelope = Object.hasOwn(raw, 'tx_blob') ? decodedTransaction(raw) : raw
  const transaction =
    typeof envelope.tx_json === 'object' && envelope.tx_json !== null
      ? asRecord(envelope.tx_json, 'tx_json')
      : typeof envelope.tx === 'object' && envelope.tx !== null
        ? asRecord(envelope.tx, 'tx')
        : envelope
  const metadataValue =
    envelope.meta ?? envelope.metaData ?? transaction.meta ?? transaction.metaData
  const metadata = asRecord(metadataValue, 'transaction metadata')
  nonEmptyString(transaction.TransactionType, 'transaction.TransactionType')
  if (!Array.isArray(metadata.AffectedNodes)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'metadata.AffectedNodes must be an array')
  }
  nonEmptyString(metadata.TransactionResult, 'metadata.TransactionResult')
  const transactionHash = matchingHash(
    [envelope.hash, transaction === envelope ? undefined : transaction.hash],
    'transaction hash',
  )
  const transactionIndex = uint(metadata.TransactionIndex, 'metadata.TransactionIndex')

  const cleanTransaction = { ...transaction }
  delete cleanTransaction.meta
  delete cleanTransaction.metaData
  delete cleanTransaction.hash

  // Nodes add these API conveniences at request time; they are not hashed ledger metadata.
  const cleanMetadata = { ...metadata }
  delete cleanMetadata.nftoken_id
  delete cleanMetadata.nftoken_ids
  delete cleanMetadata.offer_id
  delete cleanMetadata.mpt_issuance_id
  delete cleanMetadata.delivered_amount

  return {
    hash: transactionHash,
    transaction: cleanTransaction,
    metadata: cleanMetadata,
    transactionIndex,
  }
}

export function normalizeLedgerResponse(value: unknown): ValidatedLedger {
  const result = asRecord(value, 'ledger response')
  if (result.validated !== true) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'XRPL server returned a non-validated ledger')
  }
  const rawLedger = asRecord(result.ledger, 'ledger')
  const ledger = Object.hasOwn(rawLedger, 'ledger_data')
    ? decodedLedgerHeader(rawLedger)
    : rawLedger
  if (ledger.closed !== true) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Validated ledger must be marked closed')
  }
  if (!Array.isArray(ledger.transactions)) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'Expanded validated ledger must contain a transactions array',
    )
  }

  const transactions = ledger.transactions
    .map(normalizeTransaction)
    .sort((left, right) => left.transactionIndex - right.transactionIndex)
  const hashes = new Set<string>()
  transactions.forEach((transaction, position) => {
    if (transaction.transactionIndex !== position) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        `Validated ledger is missing transaction index ${position}`,
      )
    }
    if (hashes.has(transaction.hash)) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        `Validated ledger contains duplicate transaction hash ${transaction.hash}`,
      )
    }
    hashes.add(transaction.hash)
  })

  const ledgerIndex = uint(ledger.ledger_index, 'ledger.ledger_index')
  const responseLedgerIndex = uint(result.ledger_index, 'ledger response ledger_index')
  if (ledgerIndex !== responseLedgerIndex) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'Ledger index values disagree inside one response',
    )
  }
  const ledgerHash = hash(ledger.ledger_hash, 'ledger.ledger_hash')
  const responseLedgerHash = hash(result.ledger_hash, 'ledger response ledger_hash')
  if (ledgerHash !== responseLedgerHash) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'Ledger hash values disagree inside one response',
    )
  }

  return {
    ledgerIndex,
    ledgerHash,
    parentHash: hash(ledger.parent_hash, 'ledger.parent_hash'),
    accountRoot: hash(ledger.account_hash, 'ledger.account_hash'),
    transactionRoot: hash(ledger.transaction_hash, 'ledger.transaction_hash'),
    parentCloseTime: uint(ledger.parent_close_time, 'ledger.parent_close_time'),
    closeTime: uint(ledger.close_time, 'ledger.close_time'),
    closeTimeResolution: uint(ledger.close_time_resolution, 'ledger.close_time_resolution'),
    closeFlags: uint(ledger.close_flags, 'ledger.close_flags'),
    totalCoins: uint64String(ledger.total_coins, 'ledger.total_coins'),
    transactions,
  }
}

export function assertFeatureResponseSupportsAmendment(value: unknown, amendmentId: string): void {
  const result = asRecord(value, 'feature result')
  const featureMap =
    typeof result.features === 'object' && result.features !== null
      ? asRecord(result.features, 'feature result.features')
      : result
  const match = Object.entries(featureMap).find(
    ([key]) => key.toUpperCase() === amendmentId.toUpperCase(),
  )
  if (match === undefined) {
    return sourceFailure(
      'SOURCE_AMENDMENT_UNAVAILABLE',
      `Required XRPL amendment ${amendmentId} is absent from feature response`,
    )
  }
  const feature = asRecord(match[1], `feature result ${match[0]}`)
  if (feature.enabled !== true || feature.supported !== true) {
    return sourceFailure(
      'SOURCE_AMENDMENT_UNAVAILABLE',
      `Required XRPL amendment ${amendmentId} is not enabled and supported`,
    )
  }
}

export class XrplLedgerSource implements LedgerSource {
  private readonly client: Client

  constructor(
    url: string,
    private readonly sourceId = 'xrpl',
    private readonly registryPolicy: RegistryPolicy = 'blackholed',
  ) {
    this.client = new Client(url)
  }

  async connect(): Promise<void> {
    if (!this.client.isConnected()) await this.client.connect()
  }

  async disconnect(): Promise<void> {
    if (this.client.isConnected()) await this.client.disconnect()
  }

  async preflight(profile: NetworkProfile): Promise<LedgerSourcePreflight> {
    try {
      const status = normalizeServerInfo(await this.request({ command: 'server_info' }))
      assertSourceCoversProfile(status, profile)
      await this.assertAmendmentEnabled(profile.requiredAmendment)

      const activationLedger = await this.getLedger(profile.activationLedgerIndex)
      if (activationLedger.ledgerHash !== profile.activationLedgerHash) {
        return sourceFailure(
          'SOURCE_ACTIVATION_MISMATCH',
          `Activation ledger hash does not match profile ${profile.profileId}`,
          {
            expectedLedgerHash: profile.activationLedgerHash,
            actualLedgerHash: activationLedger.ledgerHash,
          },
        )
      }

      const accountInfo = await this.request({
        command: 'account_info',
        account: profile.registryAddress,
        ledger_hash: profile.activationLedgerHash,
        signer_lists: true,
        strict: true,
      })
      const accountObjects = await this.getAllAccountObjects(profile)
      assertRegistryPolicy({
        accountInfo,
        accountObjects,
        profile,
        policy: this.registryPolicy,
      })

      return {
        networkId: status.networkId,
        completeLedgerRanges: status.completeLedgerRanges,
        activationLedger,
        tips: {
          primary: status.validatedLedgerIndex,
          secondary: status.validatedLedgerIndex,
          effective: status.validatedLedgerIndex,
        },
      }
    } catch (error) {
      if (error instanceof XrplSourceError) {
        throw new XrplSourceError(
          error.code,
          error.message,
          { ...error.details, source: this.sourceId },
          { cause: error },
        )
      }
      throw new XrplSourceError(
        'SOURCE_UNAVAILABLE',
        `XRPL source ${this.sourceId} preflight failed`,
        { source: this.sourceId },
        { cause: error },
      )
    }
  }

  async assertAmendmentEnabled(amendmentId: string): Promise<void> {
    const response = await this.request({ command: 'feature', feature: amendmentId })
    assertFeatureResponseSupportsAmendment(response, amendmentId)
  }

  async getValidatedLedgerIndex(): Promise<number> {
    const status = normalizeServerInfo(await this.request({ command: 'server_info' }))
    return status.validatedLedgerIndex
  }

  async getValidatedLedgerTips(): Promise<LedgerSourceTips> {
    const tip = await this.getValidatedLedgerIndex()
    return { primary: tip, secondary: tip, effective: tip }
  }

  async getLedger(ledgerIndex: number): Promise<ValidatedLedger> {
    const result = await this.request({
      command: 'ledger',
      ledger_index: ledgerIndex,
      transactions: true,
      expand: true,
      // Large expanded JSON responses can exceed provider WebSocket limits. Binary retains
      // the complete ledger and canonical fields while reducing transport size; no partial retry.
      binary: true,
    })
    const ledger = normalizeLedgerResponse(result)
    if (ledger.ledgerIndex !== ledgerIndex) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        `XRPL source returned ledger ${ledger.ledgerIndex} when ${ledgerIndex} was requested`,
      )
    }
    return ledger
  }

  private async request(request: Record<string, unknown>): Promise<unknown> {
    const call = this.client.request.bind(this.client) as unknown as (
      input: Record<string, unknown>,
    ) => Promise<{ result: unknown }>
    return (await call(request)).result
  }

  private async getAllAccountObjects(profile: NetworkProfile): Promise<unknown[]> {
    const objects: unknown[] = []
    const markers = new Set<string>()
    let marker: unknown

    for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
      const response = await this.request({
        command: 'account_objects',
        account: profile.registryAddress,
        ledger_hash: profile.activationLedgerHash,
        limit: 400,
        ...(marker === undefined ? {} : { marker }),
      })
      const page = normalizeAccountObjectsPage(response, profile)
      objects.push(...page.objects)
      if (page.marker === undefined) return objects

      let markerKey: string
      try {
        markerKey = JSON.stringify(page.marker)
      } catch {
        return sourceFailure(
          'SOURCE_RESPONSE_INVALID',
          'account_objects marker is not serializable',
        )
      }
      if (markers.has(markerKey)) {
        return sourceFailure('SOURCE_RESPONSE_INVALID', 'account_objects marker repeated')
      }
      markers.add(markerKey)
      marker = page.marker
    }

    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'account_objects pagination exceeded 1000 pages',
    )
  }
}
