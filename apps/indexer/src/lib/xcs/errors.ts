// Copied from packages/core/src/errors.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
export const XCS_ERROR_CODES = [
  'JSON_INVALID',
  'JSON_DUPLICATE_KEY',
  'JSON_INVALID_UNICODE',
  'JSON_NON_IJSON_NUMBER',
  'CANONICALIZATION_UNSUPPORTED_VALUE',
  'HEX_INVALID',
  'UTF8_INVALID',
  'NETWORK_PROFILE_INVALID',
  'SCHEMA_INVALID',
  'SCHEMA_PARENT_NOT_FOUND',
  'SCHEMA_PARENT_NOT_PRIOR',
  'SCHEMA_PARENT_NETWORK_MISMATCH',
  'SCHEMA_OVERRIDE_FORBIDDEN',
  'SCHEMA_INHERITANCE_CYCLE',
  'SCHEMA_DEPTH_EXCEEDED',
  'SCHEMA_FIELD_LIMIT_EXCEEDED',
  'SCHEMA_SUPERSEDES_NOT_FOUND',
  'SCHEMA_SUPERSEDES_NOT_PRIOR',
  'SCHEMA_SUPERSEDES_PUBLISHER_MISMATCH',
  'SCHEMA_CATALOG_INVALID',
  'SCHEMA_CATALOG_LIMIT_EXCEEDED',
  'VERIFICATION_REPORT_INVALID',
  'UID_INPUT_INVALID',
  'CLAIMS_INVALID',
  'PAYLOAD_INVALID',
  'PAYLOAD_URI_INVALID',
  'RIPPLE_TIME_INVALID',
] as const

export type XcsErrorCode = (typeof XCS_ERROR_CODES)[number]

export class XcsError extends Error {
  readonly code: XcsErrorCode
  readonly path?: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: XcsErrorCode,
    message: string,
    options: {
      path?: string
      details?: Readonly<Record<string, unknown>>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'XcsError'
    this.code = code
    if (options.path !== undefined) this.path = options.path
    if (options.details !== undefined) this.details = options.details
  }
}

export function fail(
  code: XcsErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new XcsError(code, message, {
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  })
}
