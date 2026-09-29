import type { VerificationDimensions } from './credentialReview'

export type PresentationHeadline =
  | 'unusable'
  | 'unavailable'
  | 'pending'
  | 'notFound'
  | 'expired'
  | 'deleted'
  | 'schemaInvalid'
  | 'tampered'
  | 'contentInvalid'
  | 'untrusted'
  | 'schemaUnknown'
  | 'contentUnavailable'
  | 'partial'
  | 'unknownIssuer'
  | 'passed'

/** Known failures take priority over incomplete checks; approval is never issuer trust. */
export function presentationHeadline(
  report: VerificationDimensions | null,
  options: { usable: boolean; fresh: boolean },
): PresentationHeadline {
  if (!options.usable) return 'unusable'
  if (!options.fresh || !report) return 'unavailable'
  if (report.onChain === 'not_found') return 'notFound'
  if (report.onChain !== 'active') return report.onChain
  if (report.schema === 'invalid') return 'schemaInvalid'
  if (report.payload === 'tampered') return 'tampered'
  if (report.payload === 'invalid') return 'contentInvalid'
  if (report.issuerTrust === 'untrusted') return 'untrusted'
  if (report.schema === 'unknown') return 'schemaUnknown'
  if (report.payload === 'unavailable') return 'contentUnavailable'
  if (report.payload === 'not_checked') return 'partial'
  if (report.issuerTrust === 'unknown') return 'unknownIssuer'
  return 'passed'
}

export function recipientCredentialPath(profileId: string, generationId: string): string {
  return `/api/recipient/credentials/${encodeURIComponent(profileId)}/${encodeURIComponent(generationId)}`
}

/** Accept a complete link from this portal, never fetch a pasted foreign URL. */
export function presentationTokenFromLink(origin: string, input: string): string {
  const link = new URL(input.trim())
  if (
    link.origin !== new URL(origin).origin ||
    link.username ||
    link.password ||
    link.search ||
    !/^\/(?:fr\/)?presentations$/.test(link.pathname) ||
    !/^#[A-Za-z0-9_-]{43}$/.test(link.hash)
  )
    throw new Error('PRESENTATION_LINK_INVALID')
  return link.hash.slice(1)
}

/** The bearer is only part of a browser fragment; it is never a route or query parameter. */
export function presentationLink(origin: string, pagePath: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('PRESENTATION_TOKEN_INVALID')
  const location = new URL(pagePath, origin)
  if (
    location.origin !== new URL(origin).origin ||
    !/^\/(?:fr\/)?presentations$/.test(location.pathname)
  )
    throw new Error('PRESENTATION_LOCATION_INVALID')
  location.search = ''
  location.hash = token
  return location.href
}
