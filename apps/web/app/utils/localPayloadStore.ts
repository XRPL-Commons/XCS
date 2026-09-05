import { createIpfsPayloadUri, parsePayloadUri, verifyPayloadIntegrity } from '@xcs-protocol/core'

import { canonicalJson, parseJson } from './serialization'

export const LOCAL_PAYLOAD_STORE_MAX_BYTES = 64 * 1024
export const LOCAL_PAYLOAD_STORE_MAX_ENTRIES = 20
export const LOCAL_PAYLOAD_STORE_TTL_MS = 24 * 60 * 60 * 1_000
export const LOCAL_PAYLOAD_LOCATION = 'local-browser-test-store'

const STORAGE_PREFIX = 'xcs:local-test-payload:v1:'
// Context-neutral labels such as `name`/`nom` are intentionally allowed: they commonly identify a
// course, diploma or event. This guardrail only blocks names with a strong personal-data meaning.
const SENSITIVE_FIELD_NAMES = new Set([
  'address',
  'adresse',
  'birthdate',
  'dateofbirth',
  'dob',
  'email',
  'familyname',
  'firstname',
  'fullname',
  'givenname',
  'lastname',
  'middlename',
  'mobile',
  'mobilenumber',
  'nationalid',
  'passport',
  'passportnumber',
  'phone',
  'phonenumber',
  'postaladdress',
  'prenom',
  'socialsecuritynumber',
  'ssn',
  'streetaddress',
  'telephone',
  'telephonenumber',
])

export interface LocalPayloadStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class LocalPayloadPiiFieldError extends Error {
  constructor(readonly fieldPath: string) {
    super('LOCAL_PAYLOAD_PII_FIELD_REJECTED')
    this.name = 'LocalPayloadPiiFieldError'
  }
}

interface StoredLocalPayload {
  readonly version: 1
  readonly content: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly nonPersonalTestDataAcknowledged?: true
}

export interface LocalPayloadPublication {
  readonly credentialUri: string
  readonly digestHex: string
  readonly byteLength: number
  readonly createdAt: string
  readonly expiresAt: string
}

export interface LocalPayloadRead {
  readonly content: string
  readonly fetchUrl: string
  readonly digestHex: string
  readonly byteLength: number
  readonly checkedAt: string
}

function storageKey(cid: string): string {
  return `${STORAGE_PREFIX}${cid}`
}

function localStoreKeys(storage: LocalPayloadStorage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
  }
  return keys
}

function fieldPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`
}

function findSensitiveFieldPath(value: unknown, parent = '$'): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const match = findSensitiveFieldPath(child, fieldPath(parent, index))
      if (match !== undefined) return match
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  for (const [key, child] of Object.entries(value)) {
    const currentPath = fieldPath(parent, key)
    const normalizedKey = key
      .normalize('NFKD')
      .toLowerCase()
      .replaceAll(/[^a-z0-9]/g, '')
    if (SENSITIVE_FIELD_NAMES.has(normalizedKey)) return currentPath
    const match = findSensitiveFieldPath(child, currentPath)
    if (match !== undefined) return match
  }
  return undefined
}

function parseStoredPayload(value: string): StoredLocalPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw new Error('LOCAL_PAYLOAD_STORE_RECORD_INVALID', { cause })
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('content' in parsed) ||
    typeof parsed.content !== 'string' ||
    !('createdAt' in parsed) ||
    typeof parsed.createdAt !== 'string' ||
    !('expiresAt' in parsed) ||
    typeof parsed.expiresAt !== 'string' ||
    ('nonPersonalTestDataAcknowledged' in parsed &&
      parsed.nonPersonalTestDataAcknowledged !== true) ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !Number.isFinite(Date.parse(parsed.expiresAt))
  ) {
    throw new Error('LOCAL_PAYLOAD_STORE_RECORD_INVALID')
  }
  if (Date.parse(parsed.expiresAt) - Date.parse(parsed.createdAt) !== LOCAL_PAYLOAD_STORE_TTL_MS) {
    throw new Error('LOCAL_PAYLOAD_STORE_RECORD_INVALID')
  }
  return parsed as StoredLocalPayload
}

function inspectCanonicalPayload(
  content: string,
  nonPersonalTestDataAcknowledged = false,
): { credentialUri: string; byteLength: number } {
  const byteLength = new TextEncoder().encode(content).byteLength
  if (byteLength === 0 || byteLength > LOCAL_PAYLOAD_STORE_MAX_BYTES) {
    throw new Error('LOCAL_PAYLOAD_SIZE_INVALID')
  }
  let parsed: unknown
  try {
    parsed = parseJson(content)
    if (canonicalJson(parsed) !== content) throw new Error('not canonical')
  } catch (cause) {
    throw new Error('LOCAL_PAYLOAD_NOT_CANONICAL_JCS', { cause })
  }
  const sensitiveFieldPath = findSensitiveFieldPath(parsed)
  if (sensitiveFieldPath !== undefined && !nonPersonalTestDataAcknowledged) {
    throw new LocalPayloadPiiFieldError(sensitiveFieldPath)
  }
  return { credentialUri: createIpfsPayloadUri(content), byteLength }
}

function removeExpired(storage: LocalPayloadStorage, nowMs: number): void {
  for (const key of localStoreKeys(storage)) {
    const value = storage.getItem(key)
    if (value === null) continue
    try {
      if (Date.parse(parseStoredPayload(value).expiresAt) <= nowMs) storage.removeItem(key)
    } catch {
      storage.removeItem(key)
    }
  }
}

export function storeLocalTestPayload(input: {
  readonly storage: LocalPayloadStorage
  readonly content: string
  readonly now?: () => Date
  readonly nonPersonalTestDataAcknowledged?: boolean
}): LocalPayloadPublication {
  const now = input.now?.() ?? new Date()
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error('LOCAL_PAYLOAD_STORE_TIME_INVALID')
  const inspected = inspectCanonicalPayload(
    input.content,
    input.nonPersonalTestDataAcknowledged === true,
  )
  const parsedUri = parsePayloadUri(inspected.credentialUri)
  if (parsedUri.kind !== 'ipfs') throw new Error('LOCAL_PAYLOAD_URI_INVALID')
  const key = storageKey(parsedUri.cid)
  removeExpired(input.storage, nowMs)

  const existing = input.storage.getItem(key)
  if (existing !== null) {
    try {
      const record = parseStoredPayload(existing)
      if (record.content !== input.content) throw new Error('LOCAL_PAYLOAD_DIGEST_COLLISION')
      if (
        input.nonPersonalTestDataAcknowledged === true &&
        record.nonPersonalTestDataAcknowledged !== true
      ) {
        input.storage.setItem(
          key,
          JSON.stringify({ ...record, nonPersonalTestDataAcknowledged: true }),
        )
      }
      return {
        credentialUri: inspected.credentialUri,
        digestHex: parsedUri.digestHex,
        byteLength: inspected.byteLength,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'LOCAL_PAYLOAD_DIGEST_COLLISION') throw error
      input.storage.removeItem(key)
    }
  }

  if (localStoreKeys(input.storage).length >= LOCAL_PAYLOAD_STORE_MAX_ENTRIES) {
    throw new Error('LOCAL_PAYLOAD_STORE_QUOTA_EXCEEDED')
  }
  const createdAt = now.toISOString()
  const expiresAt = new Date(nowMs + LOCAL_PAYLOAD_STORE_TTL_MS).toISOString()
  const record: StoredLocalPayload = {
    version: 1,
    content: input.content,
    createdAt,
    expiresAt,
    ...(input.nonPersonalTestDataAcknowledged === true
      ? { nonPersonalTestDataAcknowledged: true }
      : {}),
  }
  try {
    input.storage.setItem(key, JSON.stringify(record))
  } catch (cause) {
    throw new Error('LOCAL_PAYLOAD_STORE_WRITE_FAILED', { cause })
  }

  return {
    credentialUri: inspected.credentialUri,
    digestHex: parsedUri.digestHex,
    byteLength: inspected.byteLength,
    createdAt,
    expiresAt,
  }
}

export function readLocalTestPayload(input: {
  readonly storage: LocalPayloadStorage
  readonly credentialUri: string
  readonly now?: () => Date
}): LocalPayloadRead {
  const parsedUri = parsePayloadUri(input.credentialUri)
  if (parsedUri.kind !== 'ipfs') throw new Error('LOCAL_PAYLOAD_IPFS_URI_REQUIRED')
  const value = input.storage.getItem(storageKey(parsedUri.cid))
  if (value === null) throw new Error('LOCAL_PAYLOAD_NOT_FOUND')
  let record: StoredLocalPayload
  try {
    record = parseStoredPayload(value)
  } catch (error) {
    input.storage.removeItem(storageKey(parsedUri.cid))
    throw error
  }
  const now = input.now?.() ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('LOCAL_PAYLOAD_STORE_TIME_INVALID')
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    input.storage.removeItem(storageKey(parsedUri.cid))
    throw new Error('LOCAL_PAYLOAD_EXPIRED')
  }
  const inspected = inspectCanonicalPayload(
    record.content,
    record.nonPersonalTestDataAcknowledged === true,
  )
  if (inspected.credentialUri !== input.credentialUri) {
    throw new Error('LOCAL_PAYLOAD_DIGEST_MISMATCH')
  }
  const integrity = verifyPayloadIntegrity(record.content, input.credentialUri)
  if (!integrity.valid) throw new Error('LOCAL_PAYLOAD_DIGEST_MISMATCH')
  return {
    content: record.content,
    fetchUrl: input.credentialUri,
    digestHex: integrity.actualDigestHex,
    byteLength: inspected.byteLength,
    checkedAt: now.toISOString(),
  }
}

export function clearLocalTestPayloads(storage: LocalPayloadStorage): number {
  const keys = localStoreKeys(storage)
  for (const key of keys) storage.removeItem(key)
  return keys.length
}

export function inspectLocalTestPayloadLocation(input: {
  readonly storage: LocalPayloadStorage
  readonly credentialUri: string
  readonly now?: () => Date
}): string {
  readLocalTestPayload(input)
  return LOCAL_PAYLOAD_LOCATION
}
