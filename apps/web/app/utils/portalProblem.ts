export type PortalProblemAction = 'retry' | 'signIn' | 'linkWallet' | 'goBack' | 'none'

export interface PortalProblem {
  code: string
  recoverable: boolean
  action: PortalProblemAction
  stateUnchanged: boolean
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const data = (error as { data?: unknown }).data
    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { error?: unknown }).error === 'string'
    ) {
      return (data as { error: string }).error
    }
    if (typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
  }
  return 'PORTAL_UNAVAILABLE'
}

/** Convert transport/internal failures to a bounded UI state without exposing raw codes. */
export function portalProblem(error: unknown): PortalProblem {
  const code = errorCode(error)
  if (code === 'AUTH_REQUIRED') {
    return { code, recoverable: true, action: 'signIn', stateUnchanged: true }
  }
  if (code.includes('WALLET_REQUIRED') || code.includes('WALLET_LINK')) {
    return { code, recoverable: true, action: 'linkWallet', stateUnchanged: true }
  }
  if (code.includes('UNAVAILABLE') || code.includes('RATE_LIMITED') || code.includes('TIMEOUT')) {
    return { code, recoverable: true, action: 'retry', stateUnchanged: true }
  }
  if (code.includes('INVALID') || code.includes('EXPIRED') || code.includes('REVOKED')) {
    return { code, recoverable: false, action: 'goBack', stateUnchanged: true }
  }
  return { code, recoverable: true, action: 'retry', stateUnchanged: false }
}
