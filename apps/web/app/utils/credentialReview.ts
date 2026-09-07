import {
  parseCredentialPayload,
  parsePayloadUri,
  rippleTimeToIso,
  type CredentialPayload,
  type ResolvedSchema,
} from '@xcs-protocol/core'

import { decodeHexUtf8 } from './serialization'

import {
  inspectPilotHttpsPayloadHost,
  readCanonicalHttpsPayload,
  type HttpsPayloadRead,
  type ReadPayloadOptions,
} from './payloadPublication'

const SCHEMA_UID = /^[0-9a-f]{64}$/
const ON_CHAIN_STATUSES = ['pending', 'active', 'expired', 'deleted', 'not_found'] as const
const SCHEMA_STATUSES = ['valid', 'invalid', 'unknown'] as const
const PAYLOAD_STATUSES = ['valid', 'unavailable', 'tampered', 'invalid', 'not_checked'] as const
const TRUST_STATUSES = ['trusted', 'untrusted', 'unknown'] as const

export type CredentialSubjectAction = 'accept' | 'reject' | 'remove'
export type OnChainStatus = (typeof ON_CHAIN_STATUSES)[number]

export interface VerificationDimensions {
  readonly onChain: OnChainStatus
  readonly schema: (typeof SCHEMA_STATUSES)[number]
  readonly payload: (typeof PAYLOAD_STATUSES)[number]
  readonly issuerTrust: (typeof TRUST_STATUSES)[number]
  readonly generationId?: string
}

export interface ApiCredentialDetail {
  readonly generationId: string
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly uriHex: string | null
  readonly expiration: number | null
  readonly accepted: boolean
  readonly state: OnChainStatus
}

/** Exact indexed metadata used by subject deletions without resolving payload or trust. */
export interface CredentialMutationReview {
  readonly generationId: string
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly uri: string | null
  readonly expiration: string | null
  readonly accepted: boolean
  readonly state: OnChainStatus
}

export interface CredentialReview {
  readonly generationId: string
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly uri: string | null
  readonly expiration: string | null
  readonly accepted: boolean
  readonly state: OnChainStatus
  /** Kept in memory for the consented API verification call; never journaled. */
  readonly payload?: CredentialPayload | undefined
  readonly claims?: CredentialPayload['claims'] | undefined
  readonly payloadDigestHex?: string | undefined
  readonly payloadByteLength?: number | undefined
  readonly payloadCheckedAt?: string | undefined
  readonly payloadReviewError?: string | undefined
  readonly report: VerificationDimensions
}

/** In-memory proof that the subject consented to one exact indexed payload location. */
export interface PayloadFetchConsentToken {
  readonly generationId: string
  readonly credentialUri: string
  readonly hostname: string
}

/** In-memory proof that the subject made a trust decision for one exact unknown issuer generation. */
export interface IssuerTrustAcknowledgementToken {
  readonly profileId: string
  readonly issuer: string
  readonly subject: string
  readonly generationId: string
  readonly issuerTrust: 'unknown'
}

interface LoadCredentialReviewOptions {
  readonly credential: unknown
  readonly report: unknown
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly schema?: ResolvedSchema | undefined
  /** Payload bytes are fetched only after the subject has explicitly consented. */
  readonly fetchPayload?: boolean | undefined
  readonly fetchImpl?: typeof fetch
  readonly payloadReader?: (options: ReadPayloadOptions) => Promise<HttpsPayloadRead>
  readonly timeoutMs?: number
  readonly now?: () => Date
}

export type CredentialMutationAction =
  'credential-accept' | 'credential-reject' | 'credential-remove' | 'credential-revoke'

export interface ExpectedCredentialGeneration {
  readonly action: CredentialMutationAction
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly generationId: string
}

export interface CredentialEventConfirmationOptions extends ExpectedCredentialGeneration {
  readonly txHash: string
  readonly loadEvent: () => Promise<unknown>
  readonly timeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`CREDENTIAL_${key.toUpperCase()}_INVALID`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], errorCode: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(errorCode)
  return value as T
}

export function parseApiCredentialDetail(
  input: unknown,
  expected: { issuer: string; subject: string; schemaUid: string },
): ApiCredentialDetail {
  if (!isRecord(input)) throw new Error('CREDENTIAL_RESPONSE_INVALID')
  const generationId = requiredString(input, 'generationId')
  const issuer = requiredString(input, 'issuer')
  const subject = requiredString(input, 'subject')
  const schemaUid = requiredString(input, 'schemaUid').toLowerCase()
  const rawUriHex = input.uriHex
  const uriHex = rawUriHex === null ? null : requiredString(input, 'uriHex')
  const expiration = input.expiration
  const accepted = input.accepted
  const state = oneOf(input.state, ON_CHAIN_STATUSES, 'CREDENTIAL_STATE_INVALID')

  if (!/^[0-9a-f]{64}$/i.test(generationId)) throw new Error('CREDENTIAL_GENERATION_ID_INVALID')
  if (!SCHEMA_UID.test(schemaUid)) throw new Error('CREDENTIAL_SCHEMA_UID_INVALID')
  if (
    issuer !== expected.issuer ||
    subject !== expected.subject ||
    schemaUid !== expected.schemaUid
  ) {
    throw new Error('CREDENTIAL_EXACT_LOOKUP_MISMATCH')
  }
  if (uriHex !== null && !/^(?:[0-9a-f]{2})+$/i.test(uriHex)) {
    throw new Error('CREDENTIAL_URI_HEX_INVALID')
  }
  if (
    expiration !== null &&
    (!Number.isInteger(expiration) ||
      (expiration as number) < 0 ||
      (expiration as number) > 0xffff_ffff)
  ) {
    throw new Error('CREDENTIAL_EXPIRATION_INVALID')
  }
  if (typeof accepted !== 'boolean') throw new Error('CREDENTIAL_ACCEPTED_INVALID')

  return {
    generationId: generationId.toLowerCase(),
    issuer,
    subject,
    schemaUid,
    uriHex,
    expiration: expiration as number | null,
    accepted,
    state,
  }
}

/** Parses only the authoritative tuple response; it performs no verification or remote fetch. */
export function loadCredentialMutationReview(
  input: unknown,
  expected: { readonly issuer: string; readonly subject: string; readonly schemaUid: string },
): CredentialMutationReview {
  const credential = parseApiCredentialDetail(input, {
    ...expected,
    schemaUid: expected.schemaUid.toLowerCase(),
  })
  return {
    generationId: credential.generationId,
    issuer: credential.issuer,
    subject: credential.subject,
    schemaUid: credential.schemaUid,
    uri: credential.uriHex === null ? null : decodeHexUtf8(credential.uriHex),
    expiration: credential.expiration === null ? null : rippleTimeToIso(credential.expiration),
    accepted: credential.accepted,
    state: credential.state,
  }
}

export function parseVerificationDimensions(input: unknown): VerificationDimensions {
  if (!isRecord(input)) throw new Error('VERIFICATION_RESPONSE_INVALID')
  const onChain = oneOf(input.onChain, ON_CHAIN_STATUSES, 'VERIFICATION_ON_CHAIN_INVALID')
  const schema = oneOf(input.schema, SCHEMA_STATUSES, 'VERIFICATION_SCHEMA_INVALID')
  const payload = oneOf(input.payload, PAYLOAD_STATUSES, 'VERIFICATION_PAYLOAD_INVALID')
  const issuerTrust = oneOf(input.issuerTrust, TRUST_STATUSES, 'VERIFICATION_TRUST_INVALID')
  const generationId = input.generationId
  if (
    generationId !== undefined &&
    (typeof generationId !== 'string' || !/^[0-9a-f]{64}$/i.test(generationId))
  ) {
    throw new Error('VERIFICATION_GENERATION_ID_INVALID')
  }
  return {
    onChain,
    schema,
    payload,
    issuerTrust,
    ...(typeof generationId === 'string' ? { generationId: generationId.toLowerCase() } : {}),
  }
}

export async function loadCredentialReview(
  options: LoadCredentialReviewOptions,
): Promise<CredentialReview> {
  const normalizedSchemaUid = options.schemaUid.toLowerCase()
  const expected = {
    issuer: options.issuer,
    subject: options.subject,
    schemaUid: normalizedSchemaUid,
  }
  const credential = parseApiCredentialDetail(options.credential, expected)
  const report = parseVerificationDimensions(options.report)
  if (credential.state !== report.onChain) throw new Error('CREDENTIAL_REVIEW_STATE_MISMATCH')
  if (report.generationId !== undefined && report.generationId !== credential.generationId) {
    throw new Error('CREDENTIAL_REVIEW_GENERATION_MISMATCH')
  }

  const uri = credential.uriHex === null ? null : decodeHexUtf8(credential.uriHex)
  let payloadRead: HttpsPayloadRead | undefined
  let payload: CredentialPayload | undefined
  if (options.fetchPayload === true) {
    if (uri === null) throw new Error('CREDENTIAL_URI_REQUIRED')
    if (options.schema === undefined) throw new Error('CREDENTIAL_SCHEMA_UNAVAILABLE')
    const readOptions = {
      credentialUri: uri,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.now ? { now: options.now } : {}),
    }
    payloadRead = await (options.payloadReader ?? readCanonicalHttpsPayload)(readOptions)
    payload = parseCredentialPayload(payloadRead.content, {
      issuer: credential.issuer,
      subject: credential.subject,
      schemaUid: credential.schemaUid,
      fields: options.schema.fields,
    })
  }

  return {
    generationId: credential.generationId,
    issuer: credential.issuer,
    subject: credential.subject,
    schemaUid: credential.schemaUid,
    uri,
    expiration: credential.expiration === null ? null : rippleTimeToIso(credential.expiration),
    accepted: credential.accepted,
    state: credential.state,
    ...(payload ? { payload } : {}),
    ...(payload ? { claims: payload.claims } : {}),
    ...(payloadRead
      ? {
          payloadDigestHex: payloadRead.digestHex,
          payloadByteLength: payloadRead.byteLength,
          payloadCheckedAt: payloadRead.checkedAt,
        }
      : {}),
    report,
  }
}

export function createPayloadFetchConsentToken(
  review: Pick<CredentialReview, 'generationId' | 'uri'>,
): PayloadFetchConsentToken {
  if (review.uri === null) throw new Error('CREDENTIAL_URI_REQUIRED')
  const parsedUri = parsePayloadUri(review.uri)
  return {
    generationId: review.generationId.toLowerCase(),
    credentialUri: review.uri,
    hostname:
      parsedUri.kind === 'https'
        ? inspectPilotHttpsPayloadHost(review.uri)
        : `ipfs:${parsedUri.cid}`,
  }
}

export function createIssuerTrustAcknowledgementToken(
  review: Pick<CredentialReview, 'issuer' | 'subject' | 'generationId' | 'report'>,
  profileId: string,
): IssuerTrustAcknowledgementToken {
  if (review.report.issuerTrust !== 'unknown') {
    throw new Error('CREDENTIAL_ISSUER_TRUST_ACK_NOT_REQUIRED')
  }
  if (profileId.length === 0) throw new Error('CREDENTIAL_ISSUER_TRUST_ACK_PROFILE_REQUIRED')
  return {
    profileId,
    issuer: review.issuer,
    subject: review.subject,
    generationId: review.generationId.toLowerCase(),
    issuerTrust: 'unknown',
  }
}

function credentialIssuerTrustBlockReason(
  review: Pick<CredentialReview, 'issuer' | 'subject' | 'generationId' | 'report'>,
  acknowledgement?: IssuerTrustAcknowledgementToken,
  profileId?: string,
): string | undefined {
  if (review.report.issuerTrust === 'untrusted') return 'CREDENTIAL_ISSUER_NOT_TRUSTED'
  if (review.report.issuerTrust === 'trusted') {
    return acknowledgement === undefined ? undefined : 'CREDENTIAL_ISSUER_TRUST_ACK_STALE'
  }
  if (acknowledgement === undefined) return 'CREDENTIAL_ISSUER_TRUST_ACK_REQUIRED'
  if (
    acknowledgement.issuerTrust !== review.report.issuerTrust ||
    acknowledgement.profileId !== profileId ||
    acknowledgement.issuer !== review.issuer ||
    acknowledgement.subject !== review.subject ||
    acknowledgement.generationId.toLowerCase() !== review.generationId.toLowerCase()
  ) {
    return 'CREDENTIAL_ISSUER_TRUST_ACK_STALE'
  }
  return undefined
}

/** Revalidates the exact trust decision after the wallet returns, before persistence or submit. */
export function assertCredentialAcceptanceReviewCurrent(
  expected: Pick<
    CredentialReview,
    'issuer' | 'subject' | 'schemaUid' | 'generationId' | 'state' | 'accepted' | 'report'
  >,
  current: Pick<
    CredentialReview,
    'issuer' | 'subject' | 'schemaUid' | 'generationId' | 'state' | 'accepted' | 'report'
  >,
  expectedProfileId: string,
  currentProfileId: string,
  acknowledgement?: IssuerTrustAcknowledgementToken,
): void {
  if (currentProfileId !== expectedProfileId) {
    throw new Error('NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE')
  }
  if (
    current.issuer !== expected.issuer ||
    current.subject !== expected.subject ||
    current.schemaUid.toLowerCase() !== expected.schemaUid.toLowerCase()
  ) {
    throw new Error('CREDENTIAL_REVIEW_CHANGED_AFTER_SIGNATURE')
  }
  if (current.generationId.toLowerCase() !== expected.generationId.toLowerCase()) {
    throw new Error('CREDENTIAL_GENERATION_CHANGED_AFTER_SIGNATURE')
  }
  if (
    current.state !== expected.state ||
    current.accepted !== expected.accepted ||
    current.accepted ||
    current.report.onChain !== expected.report.onChain ||
    current.state !== 'pending'
  ) {
    throw new Error('CREDENTIAL_STATE_CHANGED_AFTER_SIGNATURE')
  }
  if (current.report.issuerTrust !== expected.report.issuerTrust) {
    throw new Error('CREDENTIAL_ISSUER_TRUST_CHANGED_AFTER_SIGNATURE')
  }
  const reason = credentialIssuerTrustBlockReason(current, acknowledgement, currentProfileId)
  if (reason !== undefined) throw new Error(reason)
}

/** Revalidates an exact reject/remove decision after signing, before blob persistence or submit. */
export function assertCredentialSubjectMutationReviewCurrent(
  expected: CredentialMutationReview,
  current: CredentialMutationReview,
  expectedProfileId: string,
  currentProfileId: string,
  action: Extract<CredentialSubjectAction, 'reject' | 'remove'>,
): void {
  if (currentProfileId !== expectedProfileId) {
    throw new Error('NETWORK_PROFILE_CHANGED_AFTER_SIGNATURE')
  }
  if (
    current.issuer !== expected.issuer ||
    current.subject !== expected.subject ||
    current.schemaUid.toLowerCase() !== expected.schemaUid.toLowerCase()
  ) {
    throw new Error('CREDENTIAL_REVIEW_CHANGED_AFTER_SIGNATURE')
  }
  if (current.generationId.toLowerCase() !== expected.generationId.toLowerCase()) {
    throw new Error('CREDENTIAL_GENERATION_CHANGED_AFTER_SIGNATURE')
  }
  if (current.state !== expected.state || current.accepted !== expected.accepted) {
    throw new Error('CREDENTIAL_STATE_CHANGED_AFTER_SIGNATURE')
  }
  const reason = credentialActionBlockReason(current, action)
  if (reason !== undefined) throw new Error(reason)
}

export function assertPayloadFetchConsentCurrent(
  review: Pick<CredentialReview, 'generationId' | 'uri'>,
  consent: PayloadFetchConsentToken,
): void {
  if (review.uri === null) throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  let hostname: string
  try {
    const parsedUri = parsePayloadUri(review.uri)
    hostname =
      parsedUri.kind === 'https'
        ? inspectPilotHttpsPayloadHost(review.uri)
        : `ipfs:${parsedUri.cid}`
  } catch {
    throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  }
  if (
    review.generationId.toLowerCase() !== consent.generationId.toLowerCase() ||
    review.uri !== consent.credentialUri ||
    hostname !== consent.hostname
  ) {
    throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  }
}

/**
 * Re-reads indexed metadata without contacting the issuer, binds it to the
 * displayed consent token, and only then performs the browser payload fetch.
 */
export async function loadCredentialReviewWithConsent(
  options: Omit<LoadCredentialReviewOptions, 'fetchPayload'> & {
    readonly consent: PayloadFetchConsentToken
  },
): Promise<CredentialReview> {
  const { consent, ...reviewOptions } = options
  const metadataReview = await loadCredentialReview(reviewOptions)
  assertPayloadFetchConsentCurrent(metadataReview, consent)
  return loadCredentialReview({ ...reviewOptions, fetchPayload: true })
}

export function assertCredentialGenerationCurrent(
  input: unknown,
  expected: ExpectedCredentialGeneration,
): ApiCredentialDetail {
  const credential = parseApiCredentialDetail(input, expected)
  if (credential.generationId !== expected.generationId.toLowerCase()) {
    throw new Error('CREDENTIAL_GENERATION_CHANGED_AFTER_SIGNATURE')
  }
  const reason =
    expected.action === 'credential-revoke'
      ? credentialRevocationBlockReason(credential)
      : expected.action === 'credential-remove'
        ? credential.accepted && (credential.state === 'active' || credential.state === 'expired')
          ? undefined
          : 'CREDENTIAL_MUST_BE_ACTIVE_OR_EXPIRED_ACCEPTED'
        : expected.action === 'credential-reject'
          ? !credential.accepted &&
            (credential.state === 'pending' || credential.state === 'expired')
            ? undefined
            : 'CREDENTIAL_MUST_BE_PENDING_OR_EXPIRED_UNACCEPTED'
          : !credential.accepted && credential.state === 'pending'
            ? undefined
            : 'CREDENTIAL_MUST_BE_PENDING'
  if (reason !== undefined) throw new Error(reason)
  return credential
}

export function inspectCredentialOperationEvent(
  input: unknown,
  expected: ExpectedCredentialGeneration & { readonly txHash: string },
): 'confirmed' | 'pending' | 'mismatch' {
  if (
    !isRecord(input) ||
    typeof input.transactionHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(input.transactionHash)
  ) {
    throw new Error('CREDENTIAL_EVENT_RESPONSE_INVALID')
  }
  const expectedHash = expected.txHash.toLowerCase()
  if (input.transactionHash.toLowerCase() !== expectedHash) {
    throw new Error('CREDENTIAL_EVENT_RESPONSE_INVALID')
  }
  if (input.event === null) return 'pending'
  if (!isRecord(input.event)) throw new Error('CREDENTIAL_EVENT_RESPONSE_INVALID')

  const event = input.event
  if (
    typeof event.transactionHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(event.transactionHash) ||
    typeof event.issuer !== 'string' ||
    typeof event.subject !== 'string' ||
    typeof event.schemaUid !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(event.schemaUid) ||
    typeof event.eventType !== 'string' ||
    typeof event.accepted !== 'boolean'
  ) {
    throw new Error('CREDENTIAL_EVENT_RESPONSE_INVALID')
  }
  if (
    event.transactionHash.toLowerCase() !== expectedHash ||
    event.issuer !== expected.issuer ||
    event.subject !== expected.subject ||
    event.schemaUid.toLowerCase() !== expected.schemaUid.toLowerCase()
  ) {
    return 'mismatch'
  }

  const expectedEventType = expected.action === 'credential-accept' ? 'accepted' : 'deleted'
  const expectedDeletionCause =
    expected.action === 'credential-reject'
      ? 'subject_rejected'
      : expected.action === 'credential-remove'
        ? expected.issuer === expected.subject
          ? 'issuer_revoked'
          : 'subject_removed'
        : expected.action === 'credential-revoke'
          ? 'issuer_revoked'
          : undefined
  const confirmed =
    typeof event.generationId === 'string' &&
    event.generationId.toLowerCase() === expected.generationId.toLowerCase() &&
    event.eventType === expectedEventType &&
    (expected.action === 'credential-reject'
      ? event.accepted === false
      : (expected.action !== 'credential-accept' && expected.action !== 'credential-remove') ||
        event.accepted === true) &&
    (expectedDeletionCause === undefined || event.deletionCause === expectedDeletionCause)
  return confirmed ? 'confirmed' : 'mismatch'
}

export async function waitForCredentialOperationEvent(
  options: CredentialEventConfirmationOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('CREDENTIAL_EVENT_TIMEOUT_INVALID')
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('CREDENTIAL_EVENT_POLL_INTERVAL_INVALID')
  }
  const deadline = Date.now() + timeoutMs
  do {
    try {
      const state = inspectCredentialOperationEvent(await options.loadEvent(), options)
      if (state === 'confirmed') return
      if (state === 'mismatch') throw new Error('CREDENTIAL_EVENT_CONFIRMATION_MISMATCH')
    } catch (error) {
      if (
        error instanceof Error &&
        ['CREDENTIAL_EVENT_CONFIRMATION_MISMATCH', 'CREDENTIAL_EVENT_RESPONSE_INVALID'].includes(
          error.message,
        )
      ) {
        throw error
      }
      // Freshness/readiness failures are expected while the indexer catches up.
    }
    if (Date.now() >= deadline) throw new Error('CREDENTIAL_EVENT_CONFIRMATION_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  } while (true)
}

export function credentialActionBlockReason(
  review: CredentialReview | CredentialMutationReview,
  action: CredentialSubjectAction,
  issuerTrustAcknowledgement?: IssuerTrustAcknowledgementToken,
  profileId?: string,
): string | undefined {
  if (action === 'remove') {
    return review.accepted && (review.state === 'active' || review.state === 'expired')
      ? undefined
      : 'CREDENTIAL_MUST_BE_ACTIVE_OR_EXPIRED_ACCEPTED'
  }
  if (action === 'reject') {
    return !review.accepted && (review.state === 'pending' || review.state === 'expired')
      ? undefined
      : 'CREDENTIAL_MUST_BE_PENDING_OR_EXPIRED_UNACCEPTED'
  }
  if (
    review.accepted ||
    review.state !== 'pending' ||
    ('report' in review && review.report.onChain !== 'pending')
  ) {
    return 'CREDENTIAL_MUST_BE_PENDING'
  }
  // Rejecting a pending object does not endorse it. Trust and content gates
  // therefore apply to acceptance, while deletion remains a safe escape hatch.
  if (!('report' in review)) return 'CREDENTIAL_ACCEPTANCE_REVIEW_REQUIRED'
  if (review.payloadReviewError !== undefined || review.claims === undefined) {
    return 'CREDENTIAL_PAYLOAD_REVIEW_FAILED'
  }
  if (review.report.schema !== 'valid') return 'CREDENTIAL_SCHEMA_NOT_VALID'
  if (review.report.payload !== 'valid') return 'CREDENTIAL_PAYLOAD_NOT_VALID'
  return credentialIssuerTrustBlockReason(review, issuerTrustAcknowledgement, profileId)
}

export function credentialRevocationBlockReason(
  credential: ApiCredentialDetail,
): string | undefined {
  if (credential.state === 'not_found') return 'CREDENTIAL_NOT_FOUND'
  if (credential.state === 'deleted') return 'CREDENTIAL_ALREADY_DELETED'
  return undefined
}
