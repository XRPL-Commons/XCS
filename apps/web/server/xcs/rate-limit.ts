import type { RouteRateLimit } from './http.js'

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

export interface RateLimiter {
  hit(key: string, limit: RouteRateLimit): RateLimitDecision
  prune(): void
  size(): number
}

interface Window {
  count: number
  windowStart: number
}

/**
 * Fixed-window counters, in memory, keyed by route and client address. This
 * reproduces the budgets the previous HTTP framework enforced per route: a
 * request is allowed while the count within the current window is at or below
 * `max`, and the window restarts `timeWindowMs` after its first request.
 */
export function createLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, Window>()
  let lastPrune = now()

  function prune(): void {
    const current = now()
    for (const [key, window] of windows) {
      // A window is only ever `timeWindowMs` long; an hour of inactivity is
      // past every configured budget, so the entry can no longer deny anything.
      if (current - window.windowStart > 3_600_000) windows.delete(key)
    }
    lastPrune = current
  }

  return {
    hit(key, limit) {
      const current = now()
      if (current - lastPrune > 3_600_000) prune()
      const existing = windows.get(key)
      const window =
        existing === undefined || current - existing.windowStart >= limit.timeWindowMs
          ? { count: 0, windowStart: current }
          : existing
      window.count += 1
      windows.set(key, window)
      const elapsed = current - window.windowStart
      return {
        allowed: window.count <= limit.max,
        limit: limit.max,
        remaining: Math.max(0, limit.max - window.count),
        retryAfterSeconds: Math.max(1, Math.ceil((limit.timeWindowMs - elapsed) / 1000)),
      }
    },
    prune,
    size() {
      return windows.size
    },
  }
}
