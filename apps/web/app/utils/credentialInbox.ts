import { credentialTypeToSchemaUid } from '#xcs/sdk/index.js'
import { isValidClassicAddress, type Client } from 'xrpl'
import { loadCredentialMutationReview, type CredentialMutationReview } from './credentialReview'

const ACCEPTED_CREDENTIAL_FLAG = 0x0001_0000
const HASH = /^[0-9a-f]{64}$/iu
const MAX_UINT32 = 0xffff_ffff
const PAGE_LIMIT = 400
const MAX_PAGES = 25
const EXACT_LOOKUP_CONCURRENCY = 5

export interface WalletCredentialCandidate {
  readonly ledgerObjectId: string
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
}

export interface WalletCredentialInboxItem extends CredentialMutationReview {
  readonly ledgerObjectId: string
  readonly state: 'pending' | 'expired'
}

interface CredentialInboxPage {
  readonly account: string
  readonly account_objects: unknown[]
  readonly ledger_hash: string
  readonly ledger_index: number
  readonly marker?: string | undefined
  readonly validated: true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): never {
  throw new Error('CREDENTIAL_INBOX_RESPONSE_INVALID')
}

function parseHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) return invalidResponse()
  return value.toLowerCase()
}

function parseUint32(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_UINT32) {
    return invalidResponse()
  }
  return value as number
}

function parsePage(value: unknown, subject: string): CredentialInboxPage {
  if (!isRecord(value) || value.validated !== true || value.account !== subject) {
    return invalidResponse()
  }
  if (!Array.isArray(value.account_objects)) return invalidResponse()
  const ledgerHash = parseHash(value.ledger_hash)
  const ledgerIndex = parseUint32(value.ledger_index)
  if (
    value.marker !== undefined &&
    (typeof value.marker !== 'string' || value.marker.length === 0)
  ) {
    return invalidResponse()
  }
  return {
    account: subject,
    account_objects: value.account_objects,
    ledger_hash: ledgerHash,
    ledger_index: ledgerIndex,
    ...(value.marker === undefined ? {} : { marker: value.marker }),
    validated: true,
  }
}

function parseCandidate(value: unknown, subject: string): WalletCredentialCandidate | null {
  if (!isRecord(value) || value.LedgerEntryType !== 'Credential') return invalidResponse()
  if (typeof value.Subject !== 'string' || !isValidClassicAddress(value.Subject)) {
    return invalidResponse()
  }
  // account_objects also returns Credentials owned by this account as issuer
  // but addressed to another subject. They do not belong in the subject inbox.
  if (value.Subject !== subject) return null
  if (typeof value.Issuer !== 'string') return invalidResponse()
  if (!isValidClassicAddress(value.Issuer)) return invalidResponse()
  const flags = parseUint32(value.Flags)
  if ((flags & ACCEPTED_CREDENTIAL_FLAG) !== 0) return null

  if (
    typeof value.CredentialType !== 'string' ||
    !/^(?:[0-9a-f]{2}){1,64}$/iu.test(value.CredentialType)
  ) {
    return invalidResponse()
  }
  // Native XRPL CredentialType is application-defined. XCS reserves exactly
  // 32 bytes for a schema UID; other valid lengths belong to other protocols.
  if (value.CredentialType.length !== 64) return null
  let schemaUid: string
  try {
    schemaUid = credentialTypeToSchemaUid(value.CredentialType)
  } catch {
    return invalidResponse()
  }

  return {
    ledgerObjectId: parseHash(value.index),
    issuer: value.Issuer,
    subject,
    schemaUid,
  }
}

/**
 * Reads the connected subject's raw Credential entries from a validated XRPL
 * snapshot. Later pages are pinned to the first page's ledger hash so an inbox
 * cannot combine objects from different ledgers.
 */
export async function loadWalletCredentialCandidates(
  client: Client,
  subject: string,
): Promise<WalletCredentialCandidate[]> {
  if (!isValidClassicAddress(subject)) throw new Error('CREDENTIAL_INBOX_SUBJECT_INVALID')
  if (!client.isConnected()) throw new Error('CREDENTIAL_INBOX_CLIENT_NOT_CONNECTED')

  const candidates: WalletCredentialCandidate[] = []
  const seenObjects = new Set<string>()
  const seenTuples = new Set<string>()
  const seenMarkers = new Set<string>()
  let snapshot: { readonly ledgerHash: string; readonly ledgerIndex: number } | undefined
  let marker: string | undefined

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response = await client.request({
      command: 'account_objects',
      account: subject,
      type: 'credential',
      limit: PAGE_LIMIT,
      ...(snapshot === undefined
        ? { ledger_index: 'validated' as const }
        : { ledger_hash: snapshot.ledgerHash }),
      ...(marker === undefined ? {} : { marker }),
    })
    const page = parsePage(response.result, subject)

    if (snapshot === undefined) {
      snapshot = { ledgerHash: page.ledger_hash, ledgerIndex: page.ledger_index }
    } else if (
      page.ledger_hash !== snapshot.ledgerHash ||
      page.ledger_index !== snapshot.ledgerIndex
    ) {
      return invalidResponse()
    }

    for (const object of page.account_objects) {
      const candidate = parseCandidate(object, subject)
      if (candidate === null) continue
      if (seenObjects.has(candidate.ledgerObjectId)) return invalidResponse()
      const tuple = `${candidate.issuer}:${candidate.subject}:${candidate.schemaUid}`
      if (seenTuples.has(tuple)) return invalidResponse()
      seenObjects.add(candidate.ledgerObjectId)
      seenTuples.add(tuple)
      candidates.push(candidate)
      if (candidates.length > 100) throw new Error('CREDENTIAL_INBOX_TOO_LARGE')
    }

    if (page.marker === undefined) {
      return candidates.sort(
        (left, right) =>
          left.issuer.localeCompare(right.issuer) || left.schemaUid.localeCompare(right.schemaUid),
      )
    }
    if (seenMarkers.has(page.marker)) return invalidResponse()
    seenMarkers.add(page.marker)
    marker = page.marker
  }

  throw new Error('CREDENTIAL_INBOX_TOO_LARGE')
}

/** Resolves candidates in bounded batches without fetching payloads or trust reports. */
export async function resolveWalletCredentialInbox(
  candidates: readonly WalletCredentialCandidate[],
  loadExactCredential: (candidate: WalletCredentialCandidate) => Promise<unknown | undefined>,
): Promise<WalletCredentialInboxItem[]> {
  const resolved: WalletCredentialInboxItem[] = []
  for (let offset = 0; offset < candidates.length; offset += EXACT_LOOKUP_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + EXACT_LOOKUP_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (candidate) => {
        const response = await loadExactCredential(candidate)
        if (response === undefined) return null
        const review = loadCredentialMutationReview(response, candidate)
        const state = review.state
        if (review.accepted || (state !== 'pending' && state !== 'expired')) return null
        return { ...review, state, ledgerObjectId: candidate.ledgerObjectId }
      }),
    )
    for (const result of results) {
      if (result !== null) resolved.push(result)
    }
  }
  return resolved.sort(
    (left, right) =>
      (left.state === right.state ? 0 : left.state === 'pending' ? -1 : 1) ||
      left.issuer.localeCompare(right.issuer) ||
      left.schemaUid.localeCompare(right.schemaUid),
  )
}
