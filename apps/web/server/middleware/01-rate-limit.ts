import type { XcsApiContext } from '../xcs/context'
import { createLimiter } from '../xcs/rate-limit'
import type { HttpMethod } from '../xcs/http'
import { isApiPath, matchesPath } from '../utils/apiPaths'
import { requestClientAddress } from '../utils/dispatch'

const limiter = createLimiter()

export default defineEventHandler((event) => {
  if (!isApiPath(event.path)) return
  const method = event.method as HttpMethod
  if (method !== 'GET' && method !== 'POST') return
  const { handlers, trustedProxyCidrs } = event.context.xcs as XcsApiContext
  const route = handlers.routes.find(
    (candidate) => candidate.method === method && matchesPath(candidate.path, event.path),
  )
  if (route === undefined || route.rateLimit === undefined || route.rateLimit === false) return

  const key = `${route.path}|${requestClientAddress(event, trustedProxyCidrs)}`
  const decision = limiter.hit(key, route.rateLimit)
  setResponseHeader(event, 'x-ratelimit-limit', String(decision.limit))
  setResponseHeader(event, 'x-ratelimit-remaining', String(decision.remaining))
  if (decision.allowed) return

  handlers.recordRateLimited(route.path)
  if (route.cacheControl !== undefined)
    setResponseHeader(event, 'cache-control', route.cacheControl)
  setResponseHeader(event, 'retry-after', String(decision.retryAfterSeconds))
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  setResponseStatus(event, 429)
  // Returning a body from middleware ends the request. The envelope is the one
  // the previous framework's rate limiter sent, as `rateLimitResponseSchema`
  // still declares it.
  return {
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded, retry in ${decision.retryAfterSeconds} second${
      decision.retryAfterSeconds === 1 ? '' : 's'
    }`,
  }
})
