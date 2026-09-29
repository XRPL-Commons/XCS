import { createHmac } from 'node:crypto'
import {
  parseCredentialPayload,
  parseJson,
  parsePayloadUri,
  payloadDigest,
} from '#xcs/core/index.js'
import {
  assertXcsTransactionSemantics,
  credentialHexToUri,
  decodeSignedTransactionBlob,
} from '#xcs/sdk/index.js'
import { assertAuthoritativeLedgerEvidence } from './indexer-status.js'
import { DEFAULT_LEDGER_MAX_AGE_SECONDS } from './ledger-freshness.js'
import { authoritativeResolvedSchema, schemaProjectionEvidenceUids } from './schema-projection.js'
import type { ApiRepository } from './types.js'

export interface HostedPayloadRecord {
  readonly locator: string
  readonly digestHex: string
  readonly content: string
}
export interface HostedPayloadRepository {
  publish(input: {
    locator: string
    digestHex: string
    content: string
    transactionHash: string
    profileId: string
    issuer: string
    subject: string
    schemaUid: string
    requesterIpHash: string
    now: Date
    dailyLimit: number
  }): Promise<HostedPayloadRecord>
  get(locator: string): Promise<HostedPayloadRecord | undefined>
}
export interface HostedPayloadServiceOptions {
  readonly repository: HostedPayloadRepository
  readonly apiRepository: ApiRepository
  readonly publicBaseUrl: string
  readonly ipHashSecret: string
  readonly enabledNetworks: ReadonlySet<string>
  readonly maxLedgerAgeSeconds?: number
  readonly now?: () => Date
}
export const HOSTED_PAYLOAD_MAX_BYTES = 64 * 1024
export const HOSTED_PAYLOAD_LOCATOR_HEX_LENGTH = 18
export const HOSTED_PAYLOAD_LOCATOR_PATTERN = '^(?:[0-9a-f]{18}|[0-9a-f]{20})$'
const validLocator = new RegExp(HOSTED_PAYLOAD_LOCATOR_PATTERN, 'u')
const DAILY_PUBLICATION_LIMIT = 50
export class HostedPayloadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    options: { cause?: unknown } = {},
  ) {
    super(code, options)
    this.name = 'HostedPayloadError'
  }
}
export function hostedPayloadLocator(digestHex: string) {
  if (!/^[0-9a-f]{64}$/u.test(digestHex)) {
    throw new HostedPayloadError('PAYLOAD_DIGEST_INVALID', 400)
  }
  return digestHex.slice(0, HOSTED_PAYLOAD_LOCATOR_HEX_LENGTH)
}
export function hostedPayloadFetchUrl(publicBaseUrl: string, locator: string) {
  if (!validLocator.test(locator)) {
    throw new HostedPayloadError('PAYLOAD_LOCATOR_INVALID', 400)
  }
  return `${publicBaseUrl}/p/${locator}`
}
function decodePayloadBase64(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new HostedPayloadError('PAYLOAD_BASE64_INVALID', 400)
  }
  const content = Uint8Array.from(Buffer.from(value, 'base64'))
  if (content.length === 0 || content.length > HOSTED_PAYLOAD_MAX_BYTES) {
    throw new HostedPayloadError('PAYLOAD_SIZE_INVALID', 413)
  }
  return content
}
function hashIp(ipAddress: string, secret: string) {
  return createHmac('sha256', secret).update(ipAddress, 'utf8').digest('hex')
}
export class HostedPayloadService {
  constructor(private readonly options: HostedPayloadServiceOptions) {
    if (Buffer.byteLength(options.ipHashSecret, 'utf8') < 32) {
      throw new Error('Hosted payload IP hash secret must contain at least 32 bytes')
    }
    this.now = options.now ?? (() => new Date())
  }
  private readonly now: () => Date
  async get(locator: string) {
    if (!validLocator.test(locator)) {
      throw new HostedPayloadError('PAYLOAD_NOT_FOUND', 404)
    }
    const payload = await this.options.repository.get(locator)
    if (payload === undefined) throw new HostedPayloadError('PAYLOAD_NOT_FOUND', 404)
    if (payload.locator !== locator || payload.digestHex.slice(0, locator.length) !== locator) {
      throw new HostedPayloadError('PAYLOAD_STORAGE_INTEGRITY_ERROR', 500)
    }
    if (payloadDigest(payload.content) !== payload.digestHex) {
      throw new HostedPayloadError('PAYLOAD_STORAGE_INTEGRITY_ERROR', 500)
    }
    return payload
  }
  async publish(input: {
    network: string
    locator: string
    payloadBase64: string
    signedTransactionBlob: string
    ipAddress: string
  }) {
    if (!this.options.enabledNetworks.has(input.network)) {
      throw new HostedPayloadError('PAYLOAD_HOSTING_NETWORK_DISABLED', 404)
    }
    const bytes = decodePayloadBase64(input.payloadBase64)
    const digestHex = payloadDigest(bytes)
    if (hostedPayloadLocator(digestHex) !== input.locator) {
      throw new HostedPayloadError('PAYLOAD_LOCATOR_MISMATCH', 400)
    }
    let signed
    try {
      signed = decodeSignedTransactionBlob(input.signedTransactionBlob)
    } catch (error) {
      throw new HostedPayloadError('SIGNED_TRANSACTION_INVALID', 401, { cause: error })
    }
    const validated = await this.options.apiRepository.withConsistentSnapshot(
      async (repository) => {
        const network = await repository.getNetwork(input.network)
        if (network === undefined) throw new HostedPayloadError('NETWORK_NOT_FOUND', 404)
        if (network.networkId !== 1) {
          throw new HostedPayloadError('PAYLOAD_HOSTING_NETWORK_DISABLED', 404)
        }
        let semantics
        try {
          semantics = assertXcsTransactionSemantics(signed.transaction, {
            profileId: network.profileId,
            xcsVersion: network.xcsVersion,
            networkId: network.networkId,
            requiredAmendment: network.requiredAmendment,
            registryAddress: network.registryAddress,
            registrationAmountDrops: String(network.registrationAmountDrops),
            activationLedgerIndex: network.activationLedgerIndex,
            activationLedgerHash: network.activationLedgerHash,
          })
        } catch (error) {
          throw new HostedPayloadError('SIGNED_TRANSACTION_INVALID', 401, { cause: error })
        }
        if (semantics.kind !== 'credential-create') {
          throw new HostedPayloadError('SIGNED_TRANSACTION_NOT_CREDENTIAL_CREATE', 400)
        }
        const transaction = semantics.transaction
        const expectedFetchUrl = hostedPayloadFetchUrl(this.options.publicBaseUrl, input.locator)
        let credentialUri
        try {
          if (transaction.URI === undefined) throw new Error('signed URI missing')
          credentialUri = credentialHexToUri(transaction.URI)
          const parsedUri = parsePayloadUri(credentialUri)
          if (
            parsedUri.kind !== 'https' ||
            parsedUri.fetchUrl !== expectedFetchUrl ||
            parsedUri.digestHex !== digestHex
          ) {
            throw new Error('signed URI mismatch')
          }
        } catch (error) {
          throw new HostedPayloadError('SIGNED_TRANSACTION_PAYLOAD_MISMATCH', 403, {
            cause: error,
          })
        }
        let header: Record<string, unknown>
        try {
          const parsed = parseJson(bytes)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('payload is not an object')
          }
          header = parsed as Record<string, unknown>
        } catch (error) {
          throw new HostedPayloadError('PAYLOAD_INVALID', 400, { cause: error })
        }
        if (
          header.issuer !== transaction.Account ||
          header.subject !== transaction.Subject ||
          header.schema !== semantics.schemaUid
        ) {
          throw new HostedPayloadError('SIGNED_TRANSACTION_PAYLOAD_MISMATCH', 403)
        }
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
        const schemaRow = await repository.getSchema(input.network, semantics.schemaUid)
        if (schemaRow === undefined) throw new HostedPayloadError('SCHEMA_NOT_FOUND', 404)
        const schemaEvidence = await repository.getSchemaProjectionEvidence({
          profileId: input.network,
          schemaUids: schemaProjectionEvidenceUids([schemaRow], input.network),
        })
        assertAuthoritativeLedgerEvidence({
          ...authority,
          projectionLedgerIndexes: schemaEvidence.map((item) => item.schema.ledgerIndex),
        })
        const schema = authoritativeResolvedSchema(schemaRow, schemaEvidence, {
          profileId: input.network,
          schemaUid: semantics.schemaUid,
          networkId: network.networkId,
          activationLedgerIndex: network.activationLedgerIndex,
        })
        const transactionEvents = await repository.getCredentialEventsByTransaction({
          profileId: input.network,
          transactionHash: signed.txHash.toLowerCase(),
          issuer: transaction.Account,
          subject: transaction.Subject,
          schemaUid: semantics.schemaUid,
          limit: 2,
        })
        if (
          transactionEvents.length !== 1 ||
          transactionEvents[0]?.eventType !== 'created' ||
          transactionEvents[0].uriHex?.toLowerCase() !== transaction.URI?.toLowerCase()
        ) {
          throw new HostedPayloadError('SIGNED_TRANSACTION_NOT_INDEXED', 409)
        }
        assertAuthoritativeLedgerEvidence({
          ...authority,
          projectionLedgerIndexes: [transactionEvents[0].ledgerIndex],
        })
        try {
          parseCredentialPayload(bytes, {
            issuer: transaction.Account,
            subject: transaction.Subject,
            schemaUid: semantics.schemaUid,
            fields: schema.fields,
          })
        } catch (error) {
          throw new HostedPayloadError('PAYLOAD_INVALID', 400, { cause: error })
        }
        return {
          transactionHash: signed.txHash.toLowerCase(),
          issuer: transaction.Account,
          subject: transaction.Subject,
          schemaUid: semantics.schemaUid,
          content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        }
      },
    )
    const stored = await this.options.repository.publish({
      locator: input.locator,
      digestHex,
      content: validated.content,
      transactionHash: validated.transactionHash,
      profileId: input.network,
      issuer: validated.issuer,
      subject: validated.subject,
      schemaUid: validated.schemaUid,
      requesterIpHash: hashIp(input.ipAddress, this.options.ipHashSecret),
      now: this.now(),
      dailyLimit: DAILY_PUBLICATION_LIMIT,
    })
    return {
      uri: `${hostedPayloadFetchUrl(this.options.publicBaseUrl, stored.locator)}#xcs-sha256=${stored.digestHex}`,
      fetchUrl: hostedPayloadFetchUrl(this.options.publicBaseUrl, stored.locator),
      digestHex: stored.digestHex,
      byteLength: Buffer.byteLength(stored.content, 'utf8'),
      transactionHash: validated.transactionHash,
    }
  }
}
