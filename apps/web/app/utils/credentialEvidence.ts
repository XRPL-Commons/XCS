import type {
  CredentialPayload,
  FieldDescriptor,
  JsonValue,
  ResolvedSchema,
} from '#xcs/core/index.js'

import {
  assertPayloadFetchConsentCurrent,
  loadCredentialReview,
  type CredentialReview,
  type PayloadFetchConsentToken,
} from './credentialReview'

export interface CredentialClaimRow {
  readonly name: string
  readonly type: FieldDescriptor['type']
  readonly present: boolean
  readonly structured: boolean
  readonly value: JsonValue | undefined
  readonly displayValue: string
}

type CredentialEvidenceIdentity = Pick<
  CredentialReview,
  'generationId' | 'issuer' | 'subject' | 'schemaUid' | 'uri'
>

export async function bindCurrentReportToExactCredential(input: {
  readonly credential: unknown
  readonly report: unknown
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly schema: ResolvedSchema
}): Promise<CredentialReview | null> {
  try {
    const review = await loadCredentialReview(input)
    return review.report.generationId === review.generationId ? review : null
  } catch (error) {
    if (
      error instanceof Error &&
      ['CREDENTIAL_REVIEW_GENERATION_MISMATCH', 'CREDENTIAL_REVIEW_STATE_MISMATCH'].includes(
        error.message,
      )
    ) {
      return null
    }
    throw error
  }
}

function displayClaimValue(value: JsonValue | undefined): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

export function credentialClaimsToRows(
  schema: ResolvedSchema,
  claims: CredentialPayload['claims'],
): CredentialClaimRow[] {
  for (const name of Object.keys(claims)) {
    if (!Object.hasOwn(schema.fields, name)) {
      throw new Error(`CREDENTIAL_CLAIM_SCHEMA_MISMATCH:${name}`)
    }
  }

  return Object.entries(schema.fields).map(([name, descriptor]) => {
    const present = Object.hasOwn(claims, name)
    const value = present ? claims[name] : undefined
    return {
      name,
      type: descriptor.type,
      present,
      structured: value !== null && typeof value === 'object',
      value,
      displayValue: displayClaimValue(value),
    }
  })
}

/**
 * Rebinds one in-memory consent to the same profile, exact generation, tuple and URI
 * after authoritative metadata has been read again and before contacting the issuer.
 */
export function assertExactCredentialConsentCurrent(input: {
  readonly displayed: CredentialEvidenceIdentity
  readonly displayedProfileId: string
  readonly latest: CredentialEvidenceIdentity
  readonly latestProfileId: string
  readonly consent: PayloadFetchConsentToken
}): void {
  const { displayed, displayedProfileId, latest, latestProfileId, consent } = input
  try {
    assertPayloadFetchConsentCurrent(displayed, consent)
  } catch {
    throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  }

  if (
    displayedProfileId !== latestProfileId ||
    displayed.generationId.toLowerCase() !== latest.generationId.toLowerCase() ||
    displayed.issuer !== latest.issuer ||
    displayed.subject !== latest.subject ||
    displayed.schemaUid.toLowerCase() !== latest.schemaUid.toLowerCase() ||
    displayed.uri !== latest.uri
  ) {
    throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  }

  try {
    assertPayloadFetchConsentCurrent(latest, consent)
  } catch {
    throw new Error('CREDENTIAL_PAYLOAD_CONSENT_STALE')
  }
}
