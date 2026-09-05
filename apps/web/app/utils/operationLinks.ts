const HASH = /^[0-9a-f]{64}$/i
const INVALID_ROUTE_QUERY_VALUE = '__XCS_INVALID_QUERY_VALUE__'

export type CredentialPermalinkSubjectAction = 'accept' | 'reject' | 'remove'

export function credentialPermalinkSubjectAction(input: {
  readonly currentGeneration: boolean
  readonly accepted: boolean
  readonly state: 'pending' | 'active' | 'expired' | 'deleted'
}): CredentialPermalinkSubjectAction | null {
  if (!input.currentGeneration || input.state === 'deleted') return null
  if (input.accepted) {
    return input.state === 'active' || input.state === 'expired' ? 'remove' : null
  }
  if (input.state === 'pending') return 'accept'
  return input.state === 'expired' ? 'reject' : null
}

/** Preserves malformed or repeated link constraints as fail-closed values instead of omitting them. */
export function singleRouteQueryValue(input: unknown): string {
  if (input === undefined) return ''
  return typeof input === 'string' && input.length > 0 ? input : INVALID_ROUTE_QUERY_VALUE
}

function normalizedHash(value: string, errorCode: string): string {
  if (!HASH.test(value)) throw new Error(errorCode)
  return value.toLowerCase()
}

function queryPath(path: string, query: Record<string, string>): string {
  return `${path}?${new URLSearchParams(query).toString()}`
}

export function buildCredentialAcceptLink(input: {
  readonly profileId: string
  readonly issuer: string
  readonly schemaUid: string
  readonly generationId: string
  readonly action?: CredentialPermalinkSubjectAction | undefined
}): string {
  if (
    input.action !== undefined &&
    input.action !== 'accept' &&
    input.action !== 'reject' &&
    input.action !== 'remove'
  ) {
    throw new Error('CREDENTIAL_LINK_ACTION_INVALID')
  }
  return queryPath('/accept', {
    profile: input.profileId,
    issuer: input.issuer,
    schema: normalizedHash(input.schemaUid, 'ACCEPT_LINK_SCHEMA_UID_INVALID'),
    generation: normalizedHash(input.generationId, 'ACCEPT_LINK_GENERATION_INVALID'),
    ...(input.action === undefined ? {} : { action: input.action }),
  })
}

export function buildCredentialPermalink(input: {
  readonly profileId: string
  readonly generationId: string
}): string {
  const generationId = normalizedHash(input.generationId, 'CREDENTIAL_PERMALINK_GENERATION_INVALID')
  return queryPath(`/credentials/${generationId}`, { profile: input.profileId })
}

export function assertLinkProfile(
  expectedProfileId: string | undefined,
  actualProfileId: string,
): void {
  if (expectedProfileId !== undefined && expectedProfileId !== actualProfileId) {
    throw new Error('CREDENTIAL_LINK_PROFILE_MISMATCH')
  }
}

export function assertLinkGeneration(
  expectedGenerationId: string | undefined,
  actualGenerationId: string,
): void {
  if (
    expectedGenerationId !== undefined &&
    normalizedHash(expectedGenerationId, 'CREDENTIAL_LINK_GENERATION_INVALID') !==
      normalizedHash(actualGenerationId, 'CREDENTIAL_GENERATION_ID_INVALID')
  ) {
    throw new Error('CREDENTIAL_LINK_GENERATION_MISMATCH')
  }
}
