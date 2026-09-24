const destinations = new Set([
  '/account',
  '/recipient',
  '/recipient/invitations',
  '/presentations',
  '/verifier',
  '/verifier/apply',
])

/** A fixed in-app return path, never a bearer, arbitrary URL or nested redirect. */
export function authReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/account'
  const path = value.startsWith('/fr/') ? value.slice(3) : value
  return destinations.has(path) ? value : '/account'
}
