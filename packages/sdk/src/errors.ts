export type SdkErrorCode =
  | 'XCS_SDK_INVALID_ADDRESS'
  | 'XCS_SDK_INVALID_SCHEMA_UID'
  | 'XCS_SDK_INVALID_URI'
  | 'XCS_SDK_INVALID_EXPIRATION'
  | 'XCS_SDK_MEMO_TOO_LARGE'
  | 'XCS_SDK_NETWORK_MISMATCH'
  | 'XCS_SDK_AMENDMENT_UNAVAILABLE'
  | 'XCS_SDK_ACTIVATION_UNAVAILABLE'
  | 'XCS_SDK_ACTIVATION_MISMATCH'
  | 'XCS_SDK_CLIENT_NOT_CONNECTED'
  | 'XCS_SDK_AUTOFILL_INCOMPLETE'
  | 'XCS_SDK_INVALID_SIGNED_BLOB'
  | 'XCS_SDK_INVALID_SIGNER_RESULT'
  | 'XCS_SDK_INVALID_VALIDATED_CONTEXT'
  | 'XCS_SDK_INVALID_TRANSACTION'
  | 'XCS_SDK_TRANSACTION_EXPIRED'
  | 'XCS_SDK_LEDGER_CURRENT_INVALID'
  | 'XCS_SDK_SUBMISSION_FAILED'

export class XcsSdkError extends Error {
  public readonly code: SdkErrorCode
  public readonly details: Readonly<Record<string, unknown>> | undefined

  public constructor(
    code: SdkErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'XcsSdkError'
    this.code = code
    this.details = details
  }
}
