import { createHmac, randomBytes } from 'node:crypto'

import {
  createIpfsPayloadUri,
  parseCredentialPayload,
  verifyPayloadIntegrity,
  type CredentialPayload,
} from '@xcs-protocol/core'
import { deriveAddress, isValidClassicAddress, verifyKeypairSignature } from 'xrpl'

import { assertAuthoritativeLedgerEvidence } from './indexer-status.js'
import { DEFAULT_LEDGER_MAX_AGE_SECONDS } from './ledger-freshness.js'
import { hasPiiShapedFieldName } from './pii-field-filter.js'
import { authoritativeResolvedSchema, schemaProjectionEvidenceUids } from './schema-projection.js'
import { parseJson } from './serialization.js'
import type { ApiRepository, ContentPinStore, PinningRepository } from './types.js'

const MAX_DEMO_PIN_BYTES = 64 * 1024
const CHALLENGE_TTL_MS = 5 * 60 * 1_000
const PIN_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const DAILY_LIMIT = 10

export class PinningError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    options: { cause?: unknown } = {},
  ) {
    super(code, options)
    this.name = 'PinningError'
  }
}

function hashIp(ipAddress: string, secret: string): string {
  return createHmac('sha256', secret).update(ipAddress, 'utf8').digest('hex')
}

function challengeMessage(input: {
  challengeId: string
  network: string
  wallet: string
  expiresAt: Date
}): string {
  return [
    'XCS Testnet Demo Pin v1',
    `challenge:${input.challengeId}`,
    `network:${input.network}`,
    `wallet:${input.wallet}`,
    `expires:${input.expiresAt.toISOString()}`,
  ].join('\n')
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new PinningError('PAYLOAD_BASE64_INVALID', 400)
  }
  const content = Uint8Array.from(Buffer.from(value, 'base64'))
  if (content.length === 0 || content.length > MAX_DEMO_PIN_BYTES) {
    throw new PinningError('PAYLOAD_SIZE_INVALID', 413)
  }
  return content
}

export interface DemoPinningServiceOptions {
  repository: PinningRepository
  apiRepository: ApiRepository
  store: ContentPinStore
  ipHashSecret: string
  enabledNetworks: ReadonlySet<string>
  maxLedgerAgeSeconds?: number
  now?: () => Date
  verifyWalletSignature?: (input: {
    wallet: string
    message: string
    publicKey: string
    signature: string
  }) => boolean
}

export class DemoPinningService {
  private readonly now: () => Date

  constructor(private readonly options: DemoPinningServiceOptions) {
    if (Buffer.byteLength(options.ipHashSecret, 'utf8') < 32) {
      throw new Error('Pinning IP hash secret must contain at least 32 bytes')
    }
    this.now = options.now ?? (() => new Date())
  }

  async createChallenge(input: { network: string; wallet: string; ipAddress: string }) {
    if (!this.options.enabledNetworks.has(input.network)) {
      throw new PinningError('PINNING_NETWORK_DISABLED', 404)
    }
    if (!isValidClassicAddress(input.wallet)) throw new PinningError('WALLET_INVALID', 400)
    const network = await this.options.apiRepository.getNetwork(input.network)
    if (network === undefined) throw new PinningError('NETWORK_NOT_FOUND', 404)
    if (network.networkId !== 1) throw new PinningError('PINNING_NETWORK_DISABLED', 404)

    const challengeId = randomBytes(32).toString('hex')
    const now = this.now()
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS)
    const message = challengeMessage({
      challengeId,
      network: input.network,
      wallet: input.wallet,
      expiresAt,
    })
    const row = await this.options.repository.createChallenge({
      challengeId,
      profileId: input.network,
      wallet: input.wallet,
      requesterIpHash: hashIp(input.ipAddress, this.options.ipHashSecret),
      message,
      expiresAt,
    })
    return {
      challengeId: row.challengeId,
      message: row.message,
      expiresAt: row.expiresAt.toISOString(),
    }
  }

  async pin(input: {
    network: string
    wallet: string
    challengeId: string
    publicKey: string
    signature: string
    payloadBase64: string
    ipAddress: string
  }) {
    if (!this.options.enabledNetworks.has(input.network)) {
      throw new PinningError('PINNING_NETWORK_DISABLED', 404)
    }
    const challenge = await this.options.repository.getChallenge(input.challengeId)
    if (challenge === undefined) throw new PinningError('CHALLENGE_NOT_FOUND', 404)
    if (challenge.profileId !== input.network || challenge.wallet !== input.wallet) {
      throw new PinningError('CHALLENGE_MISMATCH', 403)
    }
    if (
      !/^(?:ED[0-9A-Fa-f]{64}|0[23][0-9A-Fa-f]{64})$/.test(input.publicKey) ||
      !/^[0-9A-Fa-f]{128,144}$/.test(input.signature)
    ) {
      throw new PinningError('SIGNATURE_INVALID', 401)
    }
    try {
      const verify =
        this.options.verifyWalletSignature ??
        ((signatureInput: {
          wallet: string
          message: string
          publicKey: string
          signature: string
        }) => {
          const publicKey = signatureInput.publicKey.toUpperCase()
          const signature = signatureInput.signature.toUpperCase()
          const messageHex = Buffer.from(signatureInput.message, 'utf8')
            .toString('hex')
            .toUpperCase()
          return (
            deriveAddress(publicKey) === signatureInput.wallet &&
            verifyKeypairSignature(messageHex, signature, publicKey)
          )
        })
      if (
        !verify({
          wallet: input.wallet,
          message: challenge.message,
          publicKey: input.publicKey,
          signature: input.signature,
        })
      ) {
        throw new PinningError('SIGNATURE_INVALID', 401)
      }
    } catch (error) {
      if (error instanceof PinningError) throw error
      throw new PinningError('SIGNATURE_INVALID', 401, { cause: error })
    }

    const content = decodeBase64(input.payloadBase64)
    let payloadHeader: CredentialPayload
    try {
      const parsed = parseJson(content)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('payload is not an object')
      }
      payloadHeader = parsed as unknown as CredentialPayload
    } catch (error) {
      throw new PinningError('PAYLOAD_INVALID', 400, { cause: error })
    }
    if (payloadHeader.issuer !== input.wallet) {
      throw new PinningError('PAYLOAD_ISSUER_MISMATCH', 403)
    }
    if (typeof payloadHeader.schema !== 'string') {
      throw new PinningError('PAYLOAD_INVALID', 400)
    }
    const schema = await this.options.apiRepository.withConsistentSnapshot(async (repository) => {
      const network = await repository.getNetwork(input.network)
      if (network === undefined) throw new PinningError('NETWORK_NOT_FOUND', 404)
      if (network.networkId !== 1) throw new PinningError('PINNING_NETWORK_DISABLED', 404)
      const databaseNow = await repository.getDatabaseTime()
      const status = await repository.getIndexerStatus(input.network)
      const checkpoint = await repository.getLatestCheckpoint(input.network)
      const authority = {
        expectedProfileId: input.network,
        status,
        checkpoint,
        now: databaseNow,
        maxLedgerAgeSeconds: this.options.maxLedgerAgeSeconds ?? DEFAULT_LEDGER_MAX_AGE_SECONDS,
        minimumLedgerIndex: network.activationLedgerIndex,
      }
      assertAuthoritativeLedgerEvidence({ ...authority, projectionLedgerIndexes: [] })

      const schemaRow = await repository.getSchema(input.network, payloadHeader.schema)
      if (schemaRow === undefined) throw new PinningError('SCHEMA_NOT_FOUND', 404)
      const schemaEvidence = await repository.getSchemaProjectionEvidence({
        profileId: input.network,
        schemaUids: schemaProjectionEvidenceUids([schemaRow], input.network),
      })
      assertAuthoritativeLedgerEvidence({
        ...authority,
        projectionLedgerIndexes: schemaEvidence.map((item) => item.schema.ledgerIndex),
      })
      return authoritativeResolvedSchema(schemaRow, schemaEvidence, {
        profileId: input.network,
        schemaUid: payloadHeader.schema,
        networkId: network.networkId,
        activationLedgerIndex: network.activationLedgerIndex,
      })
    })
    let payload: CredentialPayload
    try {
      payload = parseCredentialPayload(content, {
        issuer: input.wallet,
        subject: payloadHeader.subject,
        schemaUid: payloadHeader.schema,
        fields: schema.fields,
      })
    } catch (error) {
      if (error instanceof PinningError) throw error
      throw new PinningError('PAYLOAD_INVALID', 400, { cause: error })
    }
    if (hasPiiShapedFieldName(payload.claims)) {
      throw new PinningError('DEMO_PIN_PII_FIELD_FORBIDDEN', 400)
    }

    const cid = createIpfsPayloadUri(content).slice('ipfs://'.length)
    if (!verifyPayloadIntegrity(content, `ipfs://${cid}`).valid) {
      throw new PinningError('CID_INTEGRITY_ERROR', 500)
    }
    const now = this.now()
    const pinId = randomBytes(32).toString('hex')
    const pin = await this.options.repository.reservePin({
      pinId,
      challengeId: input.challengeId,
      profileId: input.network,
      wallet: input.wallet,
      requesterIpHash: hashIp(input.ipAddress, this.options.ipHashSecret),
      cid,
      byteLength: content.byteLength,
      expiresAt: new Date(now.getTime() + PIN_TTL_MS),
      now,
      dailyLimit: DAILY_LIMIT,
    })

    try {
      await this.options.store.putRaw(content, cid)
      await this.options.repository.markPinned(pin.pinId, this.now())
    } catch (error) {
      await this.options.repository.markFailed(pin.pinId, 'KUBO_WRITE_FAILED', this.now())
      throw new PinningError('PIN_STORE_UNAVAILABLE', 502, { cause: error })
    }

    return {
      uri: `ipfs://${cid}`,
      cid,
      byteLength: content.byteLength,
      expiresAt: pin.expiresAt.toISOString(),
    }
  }

  async unpinExpired(limit = 100): Promise<number> {
    const now = this.now()
    await this.options.repository.deleteExpiredUnreferencedChallenges(now, 1_000)
    const pins = await this.options.repository.findExpiredPins(now, limit)
    let processed = 0
    for (const pin of pins) {
      const shared = await this.options.repository.hasOtherActivePin(pin.cid, pin.pinId, now)
      if (!shared) await this.options.store.unpin(pin.cid)
      await this.options.repository.markUnpinned(pin.pinId, this.now())
      processed += 1
    }
    return processed
  }
}
