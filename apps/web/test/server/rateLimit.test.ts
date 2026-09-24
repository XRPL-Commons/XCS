import { describe, expect, it } from 'vitest'

import { matchesPath } from '../../server/utils/apiPaths'
import { resolveClientAddress } from '../../server/utils/clientAddress'
import { createLimiter } from '../../server/xcs/rate-limit'
import { rateLimitResponseSchema } from '../../server/xcs/http-schemas'

const LIMIT = { max: 2, timeWindowMs: 60_000 }

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
    const verify = { max: 1, timeWindowMs: 60_000 }
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
    const single = { max: 1, timeWindowMs: 60_000 }
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
