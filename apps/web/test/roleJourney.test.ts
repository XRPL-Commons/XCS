import { describe, expect, it } from 'vitest'
import { supportsWalletLinkProof, walletLinkReturnPath } from '../app/utils/roleJourney'

describe('wallet onboarding', () => {
  it.each(['/recipient', '/fr/recipient'])(
    'preserves the allowed return destination %s',
    (path) => {
      expect(walletLinkReturnPath(path, 'en')).toBe(path)
    },
  )
  it.each([
    'https://outside.test',
    '//outside.test',
    '/presentations#token',
    '/recipient?token=secret',
    '/account',
    ['/recipient'],
    undefined,
  ])('ignores unsafe or unrelated return values %j', (value) => {
    expect(walletLinkReturnPath(value, 'fr')).toBe('/fr/recipient')
    expect(walletLinkReturnPath(value, 'en')).toBe('/recipient')
  })
  it('offers only the adapters supported by ownership message verification', () => {
    expect(
      [
        'gemwallet',
        'metamask-snap',
        'otsu',
        'crossmark',
        'xaman',
        'ledger',
        'xyra',
        'walletconnect',
      ].filter(supportsWalletLinkProof),
    ).toEqual(['gemwallet', 'metamask-snap', 'otsu'])
  })
})
