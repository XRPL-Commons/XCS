const AUTH_DESTINATIONS = new Set([
  '/account',
  '/issuer',
  '/issuer/application',
  '/issuer/credentials',
  '/issuer/recipients',
  '/issuer/schemas/new',
  '/recipient',
  '/recipient/invitations',
  '/presentations',
  '/verifier',
  '/verifier/apply',
])

const WALLET_DESTINATIONS = [
  /^\/issuer(?:\/(?:schemas\/new|recipients|issue\/[0-9a-f-]{36}))?$/u,
  /^\/recipient(?:\/credentials\/[0-9a-f]{64})?$/u,
]

function localizedPath(path: string, locale: string): string {
  return locale === 'fr' ? `/fr${path}` : path
}

function unlocalizedPath(value: string): string {
  return value.startsWith('/fr/') ? value.slice(3) : value
}

/** A fixed in-app auth destination, never a bearer, query, fragment or nested redirect. */
export function authReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#')) return '/account'
  const path = unlocalizedPath(value)
  return AUTH_DESTINATIONS.has(path) ? value : '/account'
}

/** Wallet onboarding may return only to the exact role screen that initiated it. */
export function walletReturnPath(value: unknown, locale: string, fallback = '/recipient'): string {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#')) {
    return localizedPath(fallback, locale)
  }
  const path = unlocalizedPath(value)
  return WALLET_DESTINATIONS.some((pattern) => pattern.test(path))
    ? value
    : localizedPath(fallback, locale)
}

export const LEGACY_PORTAL_REDIRECTS = {
  '/studio': '/',
  '/schemas/register': '/issuer/schemas/new',
  '/issue': '/issuer/recipients',
  '/accept': '/recipient',
  '/revoke': '/issuer/credentials',
  '/verify': '/presentations',
  '/operations': '/account',
} as const

export function legacyPortalDestination(
  path: keyof typeof LEGACY_PORTAL_REDIRECTS,
  locale: string,
) {
  // A non-empty sentinel replaces any incoming fragment across the HTTP
  // redirect. app.vue removes it before the redirected page is used.
  return `${localizedPath(LEGACY_PORTAL_REDIRECTS[path], locale)}#xcs-legacy-redirect`
}
