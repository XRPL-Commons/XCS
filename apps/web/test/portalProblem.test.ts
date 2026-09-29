import { describe, expect, it } from 'vitest'
import { portalProblem } from '../app/utils/portalProblem'

describe('portal problem mapping', () => {
  it('maps authentication, wallet and retryable failures to safe actions', () => {
    expect(portalProblem({ data: { error: 'AUTH_REQUIRED' } })).toMatchObject({ action: 'signIn' })
    expect(portalProblem(new Error('RECIPIENT_WALLET_REQUIRED'))).toMatchObject({
      action: 'linkWallet',
      stateUnchanged: true,
    })
    expect(portalProblem(new Error('PRESENTATION_UNAVAILABLE'))).toMatchObject({
      action: 'retry',
      recoverable: true,
    })
  })
})
