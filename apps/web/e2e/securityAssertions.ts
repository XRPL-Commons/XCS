import { expect, type APIResponse, type Page } from '@playwright/test'

const STRICT_DIRECTIVES = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'font-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'frame-src': ["'none'"],
  'img-src': ["'self'", 'data:'],
  'manifest-src': ["'self'"],
  'media-src': ["'none'"],
  'object-src': ["'none'"],
  'script-src-attr': ["'none'"],
  'style-src-attr': ["'unsafe-inline'"],
  'worker-src': ["'self'"],
} as const

const COMPLETE_DIRECTIVE_SET = [
  ...Object.keys(STRICT_DIRECTIVES),
  'connect-src',
  'script-src',
  'style-src',
].sort()

export type SecurityRuntime = 'development' | 'production'

function requiredHeader(response: APIResponse, name: string): string {
  const value = response.headers()[name.toLowerCase()]
  expect(value, `missing ${name}`).toBeTruthy()
  return value!
}

function parseCsp(value: string): Map<string, string[]> {
  return new Map(
    value
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/u)
        return [name!, sources]
      }),
  )
}

function nonceFromPolicy(policy: Map<string, string[]>): string {
  const nonceSources = (policy.get('script-src') ?? []).filter((source) =>
    /^'nonce-[A-Za-z0-9+/_-]+={0,2}'$/u.test(source),
  )
  expect(nonceSources).toHaveLength(1)
  return nonceSources[0]!.slice("'nonce-".length, -1)
}

function expectNonceOnExecutableTags(html: string, nonce: string): void {
  const executableTags = html.match(/<(?:script|style)\b[^>]*>/gu) ?? []
  expect(executableTags.length).toBeGreaterThan(0)
  for (const tag of executableTags) expect(tag).toContain(`nonce="${nonce}"`)
}

function expectHeadersApplicableToAllResources(response: APIResponse): void {
  const headers = response.headers()
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['strict-transport-security']).toBe('max-age=15552000')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-download-options']).toBe('noopen')
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-permitted-cross-domain-policies']).toBe('none')
  expect(headers['x-xss-protection']).toBe('0')
  expect(headers['x-powered-by']).toBeUndefined()
}

export function expectStrictReportOnlyPolicy(
  response: APIResponse,
  html: string,
  runtime: SecurityRuntime,
): string {
  const headers = response.headers()
  expect(headers['content-security-policy']).toBeUndefined()

  const rawPolicy = requiredHeader(response, 'content-security-policy-report-only')
  expect(rawPolicy).not.toContain("'unsafe-eval'")
  expect(rawPolicy).not.toContain('upgrade-insecure-requests')

  const policy = parseCsp(rawPolicy)
  expect([...policy.keys()].sort()).toEqual(COMPLETE_DIRECTIVE_SET)
  // 'unsafe-inline' is allowed for style attributes only; Nuxt UI overlays position through them.
  for (const [directive, sources] of policy) {
    if (directive === 'style-src-attr') continue
    expect(sources, directive).not.toContain("'unsafe-inline'")
  }
  for (const [directive, sources] of Object.entries(STRICT_DIRECTIVES)) {
    expect(policy.get(directive), directive).toEqual(sources)
  }

  expect(policy.get('connect-src')).toEqual([
    "'self'",
    'https:',
    'wss:',
    ...(runtime === 'development' ? ['http:', 'ws:'] : []),
  ])
  expect(policy.get('script-src')?.slice(0, 2)).toEqual(["'self'", "'strict-dynamic'"])
  expect(policy.get('style-src')?.[0]).toBe("'self'")

  const nonce = nonceFromPolicy(policy)
  expect(policy.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`])
  if (runtime === 'development') {
    expect(html).toContain('property="csp-nonce"')
  } else {
    expect(html).not.toContain('property="csp-nonce"')
  }
  expectNonceOnExecutableTags(html, nonce)
  return nonce
}

export function expectHtmlDefensiveHeaders(response: APIResponse): void {
  expectHeadersApplicableToAllResources(response)
  const headers = response.headers()
  expect(headers['cache-control']).toBe('private, no-store')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups')
  expect(headers['cross-origin-embedder-policy']).toBeUndefined()
  expect(headers['origin-agent-cluster']).toBe('?1')
  expect(headers['x-dns-prefetch-control']).toBe('off')
  expect(headers['permissions-policy']).toBe(
    'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=(), hid=(self), payment=(), usb=(self)',
  )
}

export function expectNonHtmlDefensiveHeaders(response: APIResponse): void {
  expectHeadersApplicableToAllResources(response)
  const headers = response.headers()
  expect(headers['content-security-policy']).toBeUndefined()
  expect(headers['content-security-policy-report-only']).toBeUndefined()
}

export function collectBrowserFailures(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' || /content security policy/iu.test(text)) {
      failures.push(`console:${text}`)
    }
  })
  page.on('requestfailed', (request) => {
    failures.push(`requestfailed:${request.method()} ${request.url()}`)
  })
  return failures
}
