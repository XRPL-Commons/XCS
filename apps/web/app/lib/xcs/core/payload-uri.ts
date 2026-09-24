// Copied from packages/core/src/payload-uri.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { CID } from 'multiformats/cid'
import { base32 } from 'multiformats/bases/base32'
import * as raw from 'multiformats/codecs/raw'
import { create as createMultihash } from 'multiformats/hashes/digest'
import tr46 from 'tr46'

import { fail, XcsError } from './errors.js'
import { utf8ByteLength } from './json.js'

export const MAX_PAYLOAD_BYTES = 1024 * 1024

export interface IpfsPayloadUri {
  kind: 'ipfs'
  uri: string
  cid: string
  digestHex: string
}

export interface HttpsPayloadUri {
  kind: 'https'
  uri: string
  fetchUrl: string
  digestHex: string
}

export type PayloadUri = IpfsPayloadUri | HttpsPayloadUri

export interface PayloadIntegrityResult {
  valid: boolean
  expectedDigestHex: string
  actualDigestHex: string
}

const HTTPS_PREFIX = 'https://'
const SHA_256_MULTIHASH_CODE = 0x12
const INVALID_RAW_HTTPS_CHARACTER = /[\u0000-\u0020\u007f\\]/
const INVALID_NORMALIZED_HOST_ASCII = '/?#@:[]\\%<>^|`{}'
const CANONICAL_HTTPS_PATH_ASCII =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@/"
const CANONICAL_HTTPS_QUERY_ASCII =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&()*+,;=:@/?'
const IPV4_MAPPED_IPV6_HOST = /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/

export function payloadBytes(content: string | Uint8Array): Uint8Array {
  if (typeof content === 'string') utf8ByteLength(content)
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
  if (!(bytes instanceof Uint8Array)) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Payload must be UTF-8 text or bytes', '$payload')
  }
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Payload exceeds 1 MiB', '$payload', {
      size: bytes.length,
    })
  }
  return bytes
}

export function payloadDigest(content: string | Uint8Array): string {
  return bytesToHex(sha256(payloadBytes(content)))
}

function normalizePort(portSuffix: string): string | undefined {
  if (portSuffix === '') return ''
  if (!/^:\d*$/.test(portSuffix)) return undefined
  const digits = portSuffix.slice(1)
  if (digits === '') return ''
  const port = Number(digits)
  if (!Number.isSafeInteger(port) || port > 65_535) return undefined
  return port === 443 ? '' : `:${String(port)}`
}

function hasInvalidHostCharacter(host: string): boolean {
  return [...host].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return (
      codePoint <= 0x20 || codePoint === 0x7f || INVALID_NORMALIZED_HOST_ASCII.includes(character)
    )
  })
}

function normalizeHttpsAuthority(uri: string): string | undefined {
  const remainder = uri.slice(HTTPS_PREFIX.length)
  const delimiterIndex = remainder.search(/[/?#]/)
  const authority = delimiterIndex === -1 ? remainder : remainder.slice(0, delimiterIndex)
  const suffix = delimiterIndex === -1 ? '' : remainder.slice(delimiterIndex)

  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']')
    if (closingBracket === -1 || authority.includes('%')) return undefined
    const port = normalizePort(authority.slice(closingBracket + 1))
    if (port === undefined) return undefined
    try {
      const addressUrl = new URL(`${HTTPS_PREFIX}${authority}/`)
      if (IPV4_MAPPED_IPV6_HOST.test(addressUrl.hostname)) return undefined
      return `${HTTPS_PREFIX}${addressUrl.hostname}${port}${suffix}`
    } catch {
      return undefined
    }
  }
  if ([...authority].filter((character) => character === ':').length > 1) return undefined

  const portIndex = authority.lastIndexOf(':')
  const host = portIndex === -1 ? authority : authority.slice(0, portIndex)
  const port = normalizePort(portIndex === -1 ? '' : authority.slice(portIndex))
  if (port === undefined) return undefined

  let decodedHost: string
  try {
    decodedHost = decodeURIComponent(host)
  } catch {
    return undefined
  }
  const asciiHost = tr46.toASCII(decodedHost, {
    checkBidi: true,
    checkHyphens: false,
    checkJoiners: true,
    transitionalProcessing: false,
    useSTD3ASCIIRules: false,
    verifyDNSLength: false,
  })
  if (asciiHost === null || asciiHost === '' || hasInvalidHostCharacter(asciiHost)) {
    return undefined
  }
  try {
    const hostUrl = new URL(`${HTTPS_PREFIX}${asciiHost}${port}/`)
    return `${HTTPS_PREFIX}${hostUrl.host}${suffix}`
  } catch {
    return undefined
  }
}

function isCanonicalComponent(value: string, allowedAscii: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (character === '%') {
      if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) return false
      index += 2
    } else if (!allowedAscii.includes(character)) {
      return false
    }
  }
  return true
}

function buildFetchUrl(normalizedUri: string): string | undefined {
  const fragmentIndex = normalizedUri.indexOf('#')
  if (fragmentIndex === -1) return undefined
  const withoutFragment = normalizedUri.slice(0, fragmentIndex)
  const remainder = withoutFragment.slice(HTTPS_PREFIX.length)
  const resourceIndex = remainder.search(/[/?]/)
  const authority = resourceIndex === -1 ? remainder : remainder.slice(0, resourceIndex)
  const resource = resourceIndex === -1 ? '' : remainder.slice(resourceIndex)
  const queryIndex = resource.indexOf('?')
  const path = queryIndex === -1 ? resource : resource.slice(0, queryIndex)
  const query = queryIndex === -1 ? undefined : resource.slice(queryIndex + 1)

  if (
    !isCanonicalComponent(path, CANONICAL_HTTPS_PATH_ASCII) ||
    (query !== undefined && !isCanonicalComponent(query, CANONICAL_HTTPS_QUERY_ASCII)) ||
    path.split('/').some((segment) => {
      const dots = segment.replaceAll(/%2e/gi, '.')
      return dots === '.' || dots === '..'
    })
  ) {
    return undefined
  }
  return `${HTTPS_PREFIX}${authority}${path === '' ? '/' : path}${
    query === undefined ? '' : `?${query}`
  }`
}

function parseIpfsUri(uri: string): IpfsPayloadUri | undefined {
  const match = /^ipfs:\/\/(b[a-z2-7]+)$/.exec(uri)
  if (match === null) return undefined
  const cidText = match[1] ?? ''
  try {
    const cid = CID.parse(cidText, base32.decoder)
    if (
      cid.version !== 1 ||
      cid.code !== raw.code ||
      cid.multihash.code !== SHA_256_MULTIHASH_CODE ||
      cid.multihash.size !== 32 ||
      cid.toString(base32.encoder) !== cidText
    ) {
      return fail('INVALID_PAYLOAD_URI', 'Expected a canonical raw SHA-256 CIDv1', '$uri')
    }
    return {
      kind: 'ipfs',
      uri,
      cid: cidText,
      digestHex: bytesToHex(cid.multihash.digest),
    }
  } catch (cause) {
    if (cause instanceof XcsError) throw cause
    return fail('INVALID_PAYLOAD_URI', 'Invalid IPFS CID', '$uri', { cause: String(cause) })
  }
}

export function parsePayloadUri(uri: string): PayloadUri {
  if (typeof uri !== 'string') {
    return fail('INVALID_PAYLOAD_URI', 'URI must be a string', '$uri')
  }
  const length = utf8ByteLength(uri)
  if (length < 1 || length > 256) {
    return fail('INVALID_PAYLOAD_URI', 'URI must contain 1 to 256 UTF-8 bytes', '$uri')
  }
  const ipfs = parseIpfsUri(uri)
  if (ipfs !== undefined) return ipfs

  if (!uri.startsWith(HTTPS_PREFIX) || INVALID_RAW_HTTPS_CHARACTER.test(uri)) {
    return fail('INVALID_PAYLOAD_URI', 'Expected a canonical HTTPS or IPFS URI', '$uri')
  }
  const remainder = uri.slice(HTTPS_PREFIX.length)
  const authorityEnd = remainder.search(/[/?#]/)
  const authority = authorityEnd === -1 ? remainder : remainder.slice(0, authorityEnd)
  if (authority === '' || authority.includes('@')) {
    return fail(
      'INVALID_PAYLOAD_URI',
      'HTTPS authority cannot be empty or contain userinfo',
      '$uri',
    )
  }

  const normalizedUri = normalizeHttpsAuthority(uri)
  if (normalizedUri === undefined) {
    return fail('INVALID_PAYLOAD_URI', 'Invalid HTTPS authority', '$uri')
  }
  const fetchUrl = buildFetchUrl(normalizedUri)
  let parsed: URL
  try {
    parsed = new URL(normalizedUri)
  } catch (cause) {
    return fail('INVALID_PAYLOAD_URI', 'Invalid HTTPS URI', '$uri', { cause: String(cause) })
  }
  if (
    fetchUrl === undefined ||
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !/^#xcs-sha256=[0-9a-f]{64}$/.test(parsed.hash)
  ) {
    return fail(
      'INVALID_PAYLOAD_URI',
      'HTTPS URI must end in #xcs-sha256=<lowercase-sha256>',
      '$uri',
    )
  }
  return {
    kind: 'https',
    uri,
    fetchUrl,
    digestHex: parsed.hash.slice('#xcs-sha256='.length),
  }
}

export function createHttpsPayloadUri(baseUrl: string, content: string | Uint8Array): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (cause) {
    return fail('INVALID_PAYLOAD_URI', 'Invalid HTTPS base URL', '$url', {
      cause: String(cause),
    })
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return fail('INVALID_PAYLOAD_URI', 'Base URL must be fragment-free HTTPS', '$url')
  }
  url.hash = `xcs-sha256=${payloadDigest(content)}`
  const uri = url.toString()
  parsePayloadUri(uri)
  return uri
}

export function createIpfsPayloadUri(content: string | Uint8Array): string {
  const digest = createMultihash(SHA_256_MULTIHASH_CODE, sha256(payloadBytes(content)))
  return `ipfs://${CID.createV1(raw.code, digest).toString(base32.encoder)}`
}

export function verifyPayloadIntegrity(
  content: string | Uint8Array,
  uri: string,
): PayloadIntegrityResult {
  const expectedDigestHex = parsePayloadUri(uri).digestHex
  const actualDigestHex = payloadDigest(content)
  return {
    valid: expectedDigestHex === actualDigestHex,
    expectedDigestHex,
    actualDigestHex,
  }
}
