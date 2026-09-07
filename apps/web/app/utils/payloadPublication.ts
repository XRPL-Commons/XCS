import { parsePayloadUri, verifyPayloadIntegrity } from '@xcs-protocol/core'

import { canonicalJson, decodeUtf8, parseJson } from './serialization'

export const MAX_PILOT_PAYLOAD_BYTES = 1024 * 1024
export const DEFAULT_PAYLOAD_FETCH_TIMEOUT_MS = 10_000

export interface HttpsPayloadRead {
  readonly content: string
  readonly fetchUrl: string
  readonly digestHex: string
  readonly byteLength: number
  readonly checkedAt: string
}

export interface PayloadPublicationProof {
  readonly fetchUrl: string
  readonly digestHex: string
  readonly byteLength: number
  readonly checkedAt: string
  readonly credentialUri: string
}

export interface ReadPayloadOptions {
  readonly credentialUri: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly now?: () => Date
}

interface VerifyHttpsPublicationOptions extends ReadPayloadOptions {
  readonly canonicalPayload: string
}

function validatedPositiveInteger(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(errorCode)
  return value
}

function sameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return false
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true
}

export function assertPilotPublicPayloadHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  const blockedName =
    normalized === 'localhost' ||
    ['.localhost', '.local', '.internal', '.lan'].some((suffix) => normalized.endsWith(suffix))
  const ipv4Literal = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(normalized)
  const ipv6Literal = normalized.includes(':') || /^\[.*\]$/u.test(normalized)
  if (blockedName || ipv4Literal || ipv6Literal) {
    throw new Error('PILOT_PAYLOAD_HOST_REJECTED')
  }
}

/** Validates and returns the displayed host without performing a request. */
export function inspectPilotHttpsPayloadHost(credentialUri: string): string {
  const parsedUri = parsePayloadUri(credentialUri)
  if (parsedUri.kind !== 'https') throw new Error('PILOT_HTTPS_PAYLOAD_REQUIRED')
  const hostname = new URL(parsedUri.fetchUrl).hostname
  assertPilotPublicPayloadHostname(hostname)
  return hostname
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) throw new Error('PAYLOAD_CONTENT_LENGTH_INVALID')
    if (Number(contentLength) > maxBytes) throw new Error('PAYLOAD_TOO_LARGE')
  }

  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error('PAYLOAD_TOO_LARGE')
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      byteLength += next.value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel('PAYLOAD_TOO_LARGE').catch(() => undefined)
        throw new Error('PAYLOAD_TOO_LARGE')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Reads a public HTTPS payload directly from the browser. Redirects, cached
 * responses, oversized bodies and non-canonical JSON are rejected before any
 * credential transaction can be signed.
 */
export async function readCanonicalHttpsPayload(
  options: ReadPayloadOptions,
): Promise<HttpsPayloadRead> {
  const parsedUri = parsePayloadUri(options.credentialUri)
  if (parsedUri.kind !== 'https') throw new Error('PILOT_HTTPS_PAYLOAD_REQUIRED')
  inspectPilotHttpsPayloadHost(options.credentialUri)

  const maxBytes = validatedPositiveInteger(
    options.maxBytes ?? MAX_PILOT_PAYLOAD_BYTES,
    'PAYLOAD_MAX_BYTES_INVALID',
  )
  const timeoutMs = validatedPositiveInteger(
    options.timeoutMs ?? DEFAULT_PAYLOAD_FETCH_TIMEOUT_MS,
    'PAYLOAD_TIMEOUT_INVALID',
  )
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('PAYLOAD_FETCH_UNAVAILABLE')

  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchImpl(parsedUri.fetchUrl, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut || controller.signal.aborted) throw new Error('PAYLOAD_FETCH_TIMEOUT')
      throw new Error('PAYLOAD_FETCH_FAILED', { cause: error })
    }

    if (!response.ok) throw new Error(`PAYLOAD_FETCH_HTTP_${response.status}`)
    if (response.redirected || response.type === 'opaqueredirect') {
      throw new Error('PAYLOAD_REDIRECT_REJECTED')
    }
    if (response.url.length > 0 && !sameUrl(response.url, parsedUri.fetchUrl)) {
      throw new Error('PAYLOAD_FINAL_URL_MISMATCH')
    }
    if (!isJsonContentType(response.headers.get('content-type'))) {
      throw new Error('PAYLOAD_CONTENT_TYPE_INVALID')
    }

    let bytes: Uint8Array
    try {
      bytes = await readResponseBytes(response, maxBytes)
    } catch (error) {
      if (timedOut || controller.signal.aborted) throw new Error('PAYLOAD_FETCH_TIMEOUT')
      throw error
    }
    const content = decodeUtf8(bytes)
    const parsed = parseJson(content)
    if (canonicalJson(parsed) !== content) throw new Error('PAYLOAD_NOT_CANONICAL_JCS')

    const integrity = verifyPayloadIntegrity(bytes, options.credentialUri)
    if (!integrity.valid) throw new Error('PAYLOAD_DIGEST_MISMATCH')

    return {
      content,
      fetchUrl: parsedUri.fetchUrl,
      digestHex: integrity.actualDigestHex,
      byteLength: bytes.byteLength,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Performs the issuance check immediately before the wallet is invoked. */
export async function verifyHttpsPayloadPublication(
  options: VerifyHttpsPublicationOptions,
): Promise<PayloadPublicationProof> {
  const expectedBytes = new TextEncoder().encode(options.canonicalPayload)
  if (expectedBytes.byteLength > (options.maxBytes ?? MAX_PILOT_PAYLOAD_BYTES)) {
    throw new Error('PAYLOAD_TOO_LARGE')
  }

  const read = await readCanonicalHttpsPayload(options)
  const actualBytes = new TextEncoder().encode(read.content)
  if (
    actualBytes.byteLength !== expectedBytes.byteLength ||
    actualBytes.some((byte, index) => byte !== expectedBytes[index])
  ) {
    throw new Error('PUBLISHED_PAYLOAD_BYTES_MISMATCH')
  }

  return {
    fetchUrl: read.fetchUrl,
    digestHex: read.digestHex,
    byteLength: read.byteLength,
    checkedAt: read.checkedAt,
    credentialUri: options.credentialUri,
  }
}
