// Copied from packages/core/src/errors.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
export type XcsErrorCode =
  | 'INVALID_NETWORK_PROFILE'
  | 'INVALID_SCHEMA'
  | 'INVALID_SCHEMA_REFERENCE'
  | 'INVALID_CLAIMS'
  | 'INVALID_UID_INPUT'
  | 'INVALID_CREDENTIAL_PAYLOAD'
  | 'INVALID_PAYLOAD_URI'
  | 'INVALID_RIPPLE_TIME'
  | 'INVALID_JSON'
  | 'NON_CANONICAL_JSON'
  | 'UNSUPPORTED_JSON_VALUE'

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
