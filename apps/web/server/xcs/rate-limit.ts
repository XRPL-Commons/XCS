import type { RouteDefinition, RouteRateLimit } from './http.js'

/**
 * The bucket a request counts against. A `'shared'` budget is counted once
 * across every route that carries it, reproducing the single global counter
 * store the previous HTTP framework used for routes that declared no budget of
 * their own; a `'route'` budget gets a bucket per route, as a declared one did.
 */
export function rateLimitBucketKey(route: RouteDefinition, address: string): string {
  if (route.rateLimit === undefined || route.rateLimit === false) return `none|${address}`
  return `${route.rateLimit.scope === 'shared' ? 'default' : route.path}|${address}`
}

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
 * The most windows kept at once. The previous HTTP framework bounded each of
 * its counter stores with a 5000-entry LRU, so memory could not grow with the
 * number of distinct clients seen; this reproduces that bound.
 */
const MAX_WINDOWS = 5000

/**
 * Fixed-window counters, in memory, keyed by bucket and client address. This
 * reproduces the budgets the previous HTTP framework enforced: a
 * request is allowed while the count within the current window is at or below
 * `max`, and the window restarts `timeWindowMs` after its first request.
 */
export function createLimiter(now: () => number = Date.now, maxWindows = MAX_WINDOWS): RateLimiter {
  // Insertion order is iteration order, so the first entries are the oldest
  // ones inserted and re-inserting a key moves it to the end.
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

  /**
   * Keeps the map at or under its cap before a new key is added. Entries that
   * can no longer deny anything go first; only if that is not enough are the
   * oldest live entries dropped, which is what the previous LRU did.
   */
  function makeRoom(current: number): void {
    if (windows.size < maxWindows) return
    for (const [key, window] of windows) {
      if (current - window.windowStart > 3_600_000) windows.delete(key)
    }
    for (const key of windows.keys()) {
      if (windows.size < maxWindows) break
      windows.delete(key)
    }
  }

  return {
    hit(key, limit) {
      const current = now()
      if (current - lastPrune > 3_600_000) prune()
      const existing = windows.get(key)
      if (existing === undefined) makeRoom(current)
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
