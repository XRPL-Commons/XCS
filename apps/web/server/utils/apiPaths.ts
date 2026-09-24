const API_PREFIXES = ['/v1', '/health', '/internal', '/documentation']

/**
 * The read API owns these path prefixes. Everything else is a Nuxt page or a
 * build asset and keeps the framework's own middleware, headers and renderer.
 */
export function isApiPath(path: string): boolean {
  const pathname = path.split('?', 1)[0] ?? path
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** Matches one handler-table path pattern (`/v1/networks/:network`) to a URL. */
export function matchesPath(pattern: string, path: string): boolean {
  const pathname = path.split('?', 1)[0] ?? path
  const patternSegments = pattern.split('/')
  const pathSegments = (pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname).split('/')
  if (patternSegments.length !== pathSegments.length) return false
  return patternSegments.every((segment, index) => {
    const actual = pathSegments[index]
    if (actual === undefined) return false
    return segment.startsWith(':') ? actual.length > 0 : segment === actual
  })
}
