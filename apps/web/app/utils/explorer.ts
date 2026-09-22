export type ExplorerErrorKind = 'not-found' | 'unavailable' | 'invalid' | 'generic'

export type ExplorerSearchResultKind =
  'schema' | 'credential_generation' | 'transaction' | 'schema_registration' | 'credential_event'

export interface ExplorerSearchResultCoordinates {
  type: ExplorerSearchResultKind
  schemaUid?: string | null
  generationId?: string | null
  transactionHash?: string | null
}

const HEX_256 = /^[0-9a-f]{64}$/u

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

export function singleQueryValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizedExplorerQuery(value: unknown): string {
  return singleQueryValue(value).trim().slice(0, 128)
}

export function normalizedHex256(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return HEX_256.test(normalized) ? normalized : undefined
}

export function httpStatusFromError(error: unknown): number | undefined {
  const record = asRecord(error)
  if (record === undefined) return undefined

  const directStatus = record.statusCode ?? record.status
  if (typeof directStatus === 'number') return directStatus

  const response = asRecord(record.response)
  const responseStatus = response?.status ?? response?.statusCode
  return typeof responseStatus === 'number' ? responseStatus : undefined
}

export function explorerErrorKind(error: unknown): ExplorerErrorKind {
  const status = httpStatusFromError(error)
  if (status === 404) return 'not-found'
  if (status === 503) return 'unavailable'
  if (status === 400 || status === 413 || status === 422) return 'invalid'
  return 'generic'
}

export function explorerResultPath(result: ExplorerSearchResultCoordinates): string | undefined {
  if (result.type === 'schema') {
    const uid = normalizedHex256(result.schemaUid)
    return uid === undefined ? undefined : `/schemas/${uid}`
  }

  if (result.type === 'credential_generation') {
    const generationId = normalizedHex256(result.generationId)
    return generationId === undefined ? undefined : `/credentials/${generationId}`
  }

  const transactionHash = normalizedHex256(result.transactionHash)
  return transactionHash === undefined ? undefined : `/transactions/${transactionHash}`
}

export function decodeUtf8HexForDisplay(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0) return undefined
  if (!/^[0-9a-f]+$/iu.test(value)) return undefined

  try {
    const bytes = new Uint8Array(value.match(/.{2}/gu)!.map((byte) => Number.parseInt(byte, 16)))
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // eslint-disable-next-line no-control-regex -- intentionally matches control characters to reject them.
    return /[\u0000-\u001f\u007f-\u009f]/u.test(decoded) ? undefined : decoded
  } catch {
    return undefined
  }
}

export function displayDate(value: unknown, locale: string): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return undefined
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(date)
}

export function displayXrplTime(value: unknown, locale: string): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return displayDate((value + 946_684_800) * 1_000, locale)
}
