import { createHttpsPayloadUri, parsePayloadUri, payloadDigest } from '#xcs/core/index.js'
import { inspectPilotHttpsPayloadHost, verifyHttpsPayloadPublication } from './payloadPublication'

export const HOSTED_PAYLOAD_LOCATOR_HEX_LENGTH = 18
// The hosted API's decoded byte limit, not the protocol's larger payload limit.
export const HOSTED_PAYLOAD_MAX_BYTES = 64 * 1024

export function assertHostedPayloadSize(canonicalPayload: string): void {
  const size = new TextEncoder().encode(canonicalPayload).byteLength
  if (size === 0 || size > HOSTED_PAYLOAD_MAX_BYTES) throw new Error('PAYLOAD_SIZE_INVALID')
}

/** Reachability only: publication and exact-byte verification still follow ledger success. */
export async function assertHostedPayloadReachable(
  credentialUri: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  inspectPilotHttpsPayloadHost(credentialUri)
  const uri = parsePayloadUri(credentialUri)
  if (uri.kind !== 'https') throw new Error('PAYLOAD_SERVICE_HTTPS_REQUIRED')
  try {
    const response = await fetchImpl(uri.fetchUrl, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    // A new content-addressed object does not exist until the signed credential
    // is published. An unreachable origin, expired tunnel or server error is not
    // that expected absence and must block signing.
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
  } catch (cause) {
    throw new Error('PAYLOAD_HOST_UNREACHABLE_BEFORE_SIGNING', { cause })
  }
}

export interface HostedPayloadLocation {
  readonly locator: string
  readonly fetchUrl: string
  readonly credentialUri: string
  readonly digestHex: string
}

export function createHostedPayloadLocation(
  publicBaseUrl: string,
  canonicalPayload: string,
): HostedPayloadLocation {
  assertHostedPayloadSize(canonicalPayload)
  let base: URL
  try {
    base = new URL(publicBaseUrl)
  } catch {
    throw new Error('PAYLOAD_SERVICE_NOT_CONFIGURED')
  }
  if (
    base.protocol !== 'https:' ||
    base.username !== '' ||
    base.password !== '' ||
    base.origin !== publicBaseUrl
  ) {
    throw new Error('PAYLOAD_SERVICE_HTTPS_REQUIRED')
  }

  const digestHex = payloadDigest(canonicalPayload)
  const locator = digestHex.slice(0, HOSTED_PAYLOAD_LOCATOR_HEX_LENGTH)
  const fetchUrl = `${publicBaseUrl}/p/${locator}`
  const credentialUri = createHttpsPayloadUri(fetchUrl, canonicalPayload)
  if (new TextEncoder().encode(credentialUri).byteLength > 128) {
    throw new Error('PAYLOAD_SERVICE_URL_TOO_LONG')
  }
  return { locator, fetchUrl, credentialUri, digestHex }
}

export function encodePayloadBase64(canonicalPayload: string): string {
  assertHostedPayloadSize(canonicalPayload)
  const bytes = new TextEncoder().encode(canonicalPayload)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export interface PendingHostedPayload {
  readonly network: string
  readonly locator: string
  readonly canonicalPayload: string
  readonly credentialUri: string
  readonly signedTransactionBlob: string
  readonly transactionHash: string
}

interface HostedPayloadReceipt {
  readonly uri: string
  readonly fetchUrl: string
  readonly digestHex: string
  readonly byteLength: number
  readonly transactionHash: string
}

/** Called only after ledger success. Retrying publishes the same signed credential. */
export async function publishHostedPayloadAndVerify(
  pending: PendingHostedPayload,
  publish: (input: {
    network: string
    locator: string
    payloadBase64: string
    signedTransactionBlob: string
  }) => Promise<HostedPayloadReceipt>,
  fetchImpl?: typeof fetch,
) {
  let receipt: HostedPayloadReceipt
  try {
    receipt = await publish({
      network: pending.network,
      locator: pending.locator,
      payloadBase64: encodePayloadBase64(pending.canonicalPayload),
      signedTransactionBlob: pending.signedTransactionBlob,
    })
  } catch (error) {
    const code = (error as { data?: { error?: unknown } } | null)?.data?.error
    if (typeof code === 'string') throw new Error(code, { cause: error })
    throw error
  }
  if (
    receipt.uri !== pending.credentialUri ||
    receipt.fetchUrl !== pending.credentialUri.split('#')[0] ||
    receipt.digestHex !== payloadDigest(pending.canonicalPayload) ||
    receipt.byteLength !== new TextEncoder().encode(pending.canonicalPayload).byteLength ||
    receipt.transactionHash.toLowerCase() !== pending.transactionHash.toLowerCase()
  ) {
    throw new Error('SIGNED_TRANSACTION_PAYLOAD_MISMATCH')
  }
  return verifyHttpsPayloadPublication({
    canonicalPayload: pending.canonicalPayload,
    credentialUri: pending.credentialUri,
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}
