import { describe, expect, it } from 'vitest'
import {
  authReturnPath,
  legacyPortalDestination,
  walletReturnPath,
} from '../app/utils/portalRoutes'

describe('portal route allowlists', () => {
  it('keeps exact localized role destinations and rejects bearer/query redirects', () => {
    expect(authReturnPath('/fr/presentations')).toBe('/fr/presentations')
    expect(authReturnPath('/issuer/recipients')).toBe('/issuer/recipients')
    expect(authReturnPath('/presentations#secret')).toBe('/account')
    expect(authReturnPath('/issuer?organizationId=secret')).toBe('/account')
    expect(authReturnPath('https://outside.test/issuer')).toBe('/account')
  })

  it('returns wallet setup to allowlisted exact recipient and issuer screens', () => {
    expect(walletReturnPath('/fr/recipient', 'fr')).toBe('/fr/recipient')
    expect(
      walletReturnPath(
        `/issuer/issue/${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
        'en',
      ),
    ).toContain('/issuer/issue/')
    expect(walletReturnPath('/presentations#secret', 'fr')).toBe('/fr/recipient')
  })

  it('preserves locale and drops all legacy route inputs', () => {
    expect(legacyPortalDestination('/schemas/register', 'fr')).toBe(
      '/fr/issuer/schemas/new#xcs-legacy-redirect',
    )
    expect(legacyPortalDestination('/verify', 'en')).toBe('/presentations#xcs-legacy-redirect')
  })
})
