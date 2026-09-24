import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { IncomingMessage as MockIncomingMessage } from 'node-mock-http'

import { matchesPath } from '../../server/utils/apiPaths'
import { resolveClientAddress } from '../../server/utils/clientAddress'
import { isInProcessRequest } from '../../server/utils/inProcessRequest'
import {
  assertDeclaredLength,
  BodyTooLargeError,
  readBoundedBody,
  type BoundedBodySource,
} from '../../server/xcs/body-limit'
import { createApiHandlers, mapError } from '../../server/xcs/handlers'
import { createLimiter, rateLimitBucketKey } from '../../server/xcs/rate-limit'
import type { ApiHandlers, RouteDefinition } from '../../server/xcs/http'
import type { DemoPinningService } from '../../server/xcs/pinning'
import { StaticTrustPolicy } from '../../server/xcs/verification'
import { rateLimitResponseSchema } from '../../server/xcs/http-schemas'

const LIMIT = { max: 2, timeWindowMs: 60_000, scope: 'shared' } as const

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('fixed-window rate limiter', () => {
  it('allows up to the route budget, denies beyond it and restarts after the window', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now)

    expect(limiter.hit('k', LIMIT).allowed).toBe(true)
    expect(limiter.hit('k', LIMIT)).toMatchObject({ allowed: true, remaining: 0 })
    const denied = limiter.hit('k', LIMIT)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBe(60)

    clock.advance(30_000)
    expect(limiter.hit('k', LIMIT)).toMatchObject({ allowed: false, retryAfterSeconds: 30 })

    clock.advance(30_000)
    expect(limiter.hit('k', LIMIT).allowed).toBe(true)
  })

  it('keeps separate budgets per key, so per-route limits do not share a bucket', () => {
    const limiter = createLimiter(fakeClock().now)
    const verify = { max: 1, timeWindowMs: 60_000, scope: 'route' } as const
    expect(limiter.hit('/v1/verify|198.51.100.10', verify).allowed).toBe(true)
    expect(limiter.hit('/v1/verify|198.51.100.10', verify).allowed).toBe(false)
    // A different route and a different client each keep their own budget.
    expect(limiter.hit('/v1/networks|198.51.100.10', LIMIT).allowed).toBe(true)
    expect(limiter.hit('/v1/verify|198.51.100.11', verify).allowed).toBe(true)
  })

  it('prunes windows that can no longer deny a request', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now)
    limiter.hit('k', LIMIT)
    expect(limiter.size()).toBe(1)
    clock.advance(3_600_001)
    limiter.prune()
    expect(limiter.size()).toBe(0)
  })

  it('keys a bucket by the resolved client address, honouring forwarded IPs only behind a trusted proxy', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now)
    const trusted = ['127.0.0.1']
    const single = { max: 1, timeWindowMs: 60_000, scope: 'route' } as const
    const requestFrom = (forwarded: string) =>
      limiter.hit(`/v1/networks|${resolveClientAddress('127.0.0.1', forwarded, trusted)}`, single)
        .allowed

    expect(requestFrom('198.51.100.10')).toBe(true)
    expect(requestFrom('198.51.100.11')).toBe(true)
    expect(requestFrom('198.51.100.10')).toBe(false)

    // Without a trusted immediate peer the forwarded header cannot rotate buckets.
    const untrusted = (forwarded: string) =>
      limiter.hit(`/v1/stats|${resolveClientAddress('203.0.113.9', forwarded, trusted)}`, single)
        .allowed
    expect(untrusted('198.51.100.20')).toBe(true)
    expect(untrusted('198.51.100.21')).toBe(false)
  })
})

describe('budgets over the real route table', () => {
  /** The route table only; no assertion here reaches a handler, so the
   * repository, resolver and pinning service are never called. */
  function routeTable(): ApiHandlers {
    return createApiHandlers({
      repository: {} as never,
      resolver: { resolve: async () => new Uint8Array() },
      trustPolicy: new StaticTrustPolicy(),
      pinningService: {} as unknown as DemoPinningService,
    })
  }

  const CLIENT = '198.51.100.10'

  /** Sends one request to `route` through the limiter, as the middleware does. */
  function request(limiter: ReturnType<typeof createLimiter>, route: RouteDefinition): boolean {
    if (route.rateLimit === undefined || route.rateLimit === false) return true
    return limiter.hit(rateLimitBucketKey(route, CLIENT), route.rateLimit).allowed
  }

  let handlers: ApiHandlers
  beforeAll(() => {
    handlers = routeTable()
  })
  afterAll(async () => {
    await handlers.close()
  })

  function route(method: 'GET' | 'POST', path: string): RouteDefinition {
    const found = handlers.routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    )
    expect(found, `${method} ${path} is not in the route table`).toBeDefined()
    return found!
  }

  it('spends one 100-request budget across every default-limited route, not one each', () => {
    const limiter = createLimiter(fakeClock().now)
    const first = route('GET', '/v1/networks')
    const second = route('GET', '/v1/networks/:network/schemas')
    expect(first.rateLimit).toMatchObject({ max: 100, timeWindowMs: 60_000 })
    expect(second.rateLimit).toMatchObject({ max: 100, timeWindowMs: 60_000 })

    // 100 requests spread over the two paths exhaust the single shared budget.
    for (let index = 0; index < 100; index += 1) {
      expect(request(limiter, index % 2 === 0 ? first : second)).toBe(true)
    }
    expect(request(limiter, first)).toBe(false)
    expect(request(limiter, second)).toBe(false)
    // A third default-limited route is spending the same exhausted budget.
    expect(request(limiter, route('GET', '/v1/networks/:network/stats'))).toBe(false)
  })

  it('keeps the routes that declared their own budget on their own counters', () => {
    const limiter = createLimiter(fakeClock().now)
    const verify = route('POST', '/v1/verify')
    const pinning = route('POST', '/v1/pinning/challenges')
    const pinningPins = route('POST', '/v1/pinning/pins')

    // The shared budget is already spent; the declared ones are untouched by it.
    for (let index = 0; index < 101; index += 1) request(limiter, route('GET', '/v1/networks'))

    for (let index = 0; index < 20; index += 1) expect(request(limiter, verify)).toBe(true)
    expect(request(limiter, verify)).toBe(false)

    for (let index = 0; index < 10; index += 1) expect(request(limiter, pinning)).toBe(true)
    expect(request(limiter, pinning)).toBe(false)
    // The second pinning route counts separately, as its own declared budget did.
    expect(request(limiter, pinningPins)).toBe(true)
  })

  it('gives every rate-limited route a scope, sharing all but the declared budgets', () => {
    const limited = handlers.routes.filter(
      (candidate) => candidate.rateLimit !== undefined && candidate.rateLimit !== false,
    )
    const declared = new Set(['/v1/verify', '/v1/pinning/challenges', '/v1/pinning/pins'])
    expect(limited.length).toBeGreaterThan(10)
    for (const candidate of limited) {
      const rateLimit = candidate.rateLimit as { scope: string; max: number }
      expect(rateLimit.scope).toBe(declared.has(candidate.path) ? 'route' : 'shared')
      if (rateLimit.scope === 'shared') expect(rateLimit.max).toBe(100)
    }
  })
})

describe('limiter memory', () => {
  it('stays bounded as distinct clients keep arriving', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now, 100)
    for (let index = 0; index < 10_000; index += 1) {
      limiter.hit(`default|198.51.100.${index}`, LIMIT)
    }
    expect(limiter.size()).toBeLessThanOrEqual(100)
  })

  it('does not drop a client still inside its window while there is room', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now, 100)
    const victim = 'default|198.51.100.1'
    expect(limiter.hit(victim, LIMIT).allowed).toBe(true)
    expect(limiter.hit(victim, LIMIT)).toMatchObject({ allowed: true, remaining: 0 })
    // Unrelated traffic, well under the cap, must not refund the spent budget.
    for (let index = 0; index < 50; index += 1) limiter.hit(`default|203.0.113.${index}`, LIMIT)
    expect(limiter.hit(victim, LIMIT).allowed).toBe(false)
  })

  it('reclaims windows that have expired before evicting live ones', () => {
    const clock = fakeClock()
    const limiter = createLimiter(clock.now, 10)
    for (let index = 0; index < 10; index += 1) limiter.hit(`default|203.0.113.${index}`, LIMIT)
    clock.advance(3_600_001)
    const fresh = 'default|198.51.100.7'
    expect(limiter.hit(fresh, LIMIT).allowed).toBe(true)
    // Every stale entry went, so the new one is alone rather than crowding the cap.
    expect(limiter.size()).toBe(1)
    expect(limiter.hit(fresh, LIMIT)).toMatchObject({ allowed: true, remaining: 0 })
  })
})

describe('rate-limited response', () => {
  it('matches the declared 429 contract', () => {
    const body = {
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded, retry in 60 seconds',
    }
    const schema = rateLimitResponseSchema
    expect(schema.required.every((field) => field in body)).toBe(true)
    expect(Object.keys(body).every((field) => field in schema.properties)).toBe(true)
    expect(body.statusCode).toBe(schema.properties.statusCode.const)
  })
})

describe('handler-table path matching', () => {
  it('matches a parameterised route and rejects a different shape', () => {
    expect(matchesPath('/v1/networks/:network/status', '/v1/networks/testnet/status')).toBe(true)
    expect(matchesPath('/v1/networks/:network/status', '/v1/networks/testnet/status?x=1')).toBe(
      true,
    )
    expect(matchesPath('/v1/networks', '/v1/networks/testnet/status')).toBe(false)
    expect(matchesPath('/v1/networks/:network/status', '/v1/networks//status')).toBe(false)
    expect(
      matchesPath(
        '/v1/networks/:network/credentials/:issuer/:subject/:schemaUid/events/:transactionHash',
        '/v1/networks/testnet/credentials/rA/rB/0xuid/events/0xhash',
      ),
    ).toBe(true)
  })
})

describe('in-process request detection', () => {
  const realSocket = { remoteAddress: '198.51.100.10' }

  it('limits a request that arrives on a socket, including one whose address cannot be resolved', () => {
    expect(isInProcessRequest({ node: { req: { socket: realSocket } } } as never)).toBe(false)
    // A real peer whose address does not parse still keys a bucket; it is not exempt.
    expect(isInProcessRequest({ node: { req: { socket: { remoteAddress: '' } } } } as never)).toBe(
      false,
    )
    expect(resolveClientAddress('', undefined, [])).toBe('unresolved-peer')
  })

  it('exempts the synthetic request Nitro builds for an in-process call', () => {
    const synthetic = new MockIncomingMessage()
    expect(Object.prototype.hasOwnProperty.call(synthetic, '__unenv__')).toBe(true)
    expect(isInProcessRequest({ node: { req: synthetic } } as never)).toBe(true)
    expect(isInProcessRequest({ node: { req: undefined } } as never)).toBe(true)
    expect(isInProcessRequest({ node: { req: { socket: undefined } } } as never)).toBe(true)
  })

  it('cannot be turned on by anything a client sends', () => {
    const spoofed = {
      socket: realSocket,
      headers: { __unenv__: '1', 'x-forwarded-for': '198.51.100.10' },
    }
    expect(isInProcessRequest({ node: { req: spoofed } } as never)).toBe(false)
  })
})

describe('bounded request body reading', () => {
  function source(chunks: string[]): BoundedBodySource & { yielded: number } {
    const state = {
      yielded: 0,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          state.yielded += 1
          yield Buffer.from(chunk, 'utf8')
        }
      },
    }
    return state
  }

  it('reads a body within the limit', async () => {
    await expect(readBoundedBody(source(['{"a":', '1}']), 32)).resolves.toBe('{"a":1}')
    await expect(readBoundedBody(source([]), 32)).resolves.toBeUndefined()
  })

  it('stops reading as soon as the limit is passed, with no declared length', async () => {
    const stream = source(['x'.repeat(8), 'x'.repeat(8), 'x'.repeat(8)])
    await expect(readBoundedBody(stream, 10)).rejects.toBeInstanceOf(BodyTooLargeError)
    // The third chunk is never pulled, so nothing beyond the limit is buffered.
    expect(stream.yielded).toBe(2)
  })

  it('raises a 413 that the error mapper shapes into the request-error envelope', async () => {
    const error = await readBoundedBody(source(['x'.repeat(64)]), 8).catch(
      (raised: unknown) => raised,
    )
    expect((error as BodyTooLargeError).statusCode).toBe(413)
    expect(mapError(error)).toEqual({
      statusCode: 413,
      headers: {},
      body: { error: 'REQUEST_ERROR', message: 'Request body is too large' },
    })
  })

  it('keeps the declared-length fast path', () => {
    expect(() => assertDeclaredLength('4', 8)).not.toThrow()
    expect(() => assertDeclaredLength(undefined, 8)).not.toThrow()
    // An understated length passes the fast path; the streaming count is what bounds it.
    expect(() => assertDeclaredLength('1', 8)).not.toThrow()
    expect(() => assertDeclaredLength('9', 8)).toThrow(BodyTooLargeError)
  })
})
