import type { NitroErrorHandler } from 'nitropack'
import { joinURL, withQuery } from 'ufo'

import { isApiPath } from './utils/apiPaths'

const NUXT_ERROR_ROUTE = '/__nuxt_error'

function isJsonRequest(event: Parameters<NitroErrorHandler>[1]): boolean {
  const accept = getRequestHeader(event, 'accept')?.toLowerCase() ?? ''
  if (accept.includes('text/html')) return false
  const userAgent = getRequestHeader(event, 'user-agent')?.toLowerCase() ?? ''
  return (
    accept.includes('application/json') ||
    userAgent.includes('curl/') ||
    userAgent.includes('httpie/') ||
    (getRequestHeader(event, 'sec-fetch-mode')?.toLowerCase().includes('cors') ?? false) ||
    event.path.startsWith('/api/') ||
    event.path.endsWith('.json')
  )
}

/**
 * Renders the application's own error page for a page route. Declaring a Nitro
 * error handler replaces the one the framework installs, so this reproduces its
 * delegation to the `/__nuxt_error` route, including dropping the default
 * handler's `content-security-policy` so the page keeps the application policy.
 *
 * Ported from `@nuxt/nitro-server` `runtime/handlers/error` (4.5.2); keep in
 * sync by hand when the framework is upgraded.
 */
const renderPageError: NitroErrorHandler = async (error, event, { defaultHandler }) => {
  if (event.handled || isJsonRequest(event)) return
  const fallback = await defaultHandler(error, event, { json: true })
  const status = error.statusCode ?? 500
  if (status === 404 && fallback.status === 302) return fallback

  const errorObject = fallback.body as Record<string, unknown>
  const url = new URL(String(errorObject.url))
  errorObject.url = url.pathname + url.search + url.hash
  errorObject.message = error.message || String(errorObject.message ?? 'Server Error')
  errorObject.data ??= error.data
  errorObject.statusText ??= error.statusMessage
  delete fallback.headers['content-type']
  delete fallback.headers['content-security-policy']
  setResponseHeaders(event, fallback.headers)

  const requestHeaders = getRequestHeaders(event) as Record<string, string>
  const rendered =
    event.path.startsWith(NUXT_ERROR_ROUTE) || requestHeaders['x-nuxt-error'] !== undefined
      ? null
      : await useNitroApp()
          .localFetch(
            withQuery(joinURL(useRuntimeConfig(event).app.baseURL, NUXT_ERROR_ROUTE), errorObject),
            {
              headers: { ...requestHeaders, 'x-nuxt-error': 'true' },
              redirect: 'manual',
            },
          )
          .catch(() => null)
  if (event.handled) return
  if (rendered === null) return fallback

  const html = await rendered.text()
  for (const [header, value] of rendered.headers.entries()) {
    if (header === 'set-cookie') appendResponseHeader(event, header, value)
    else setResponseHeader(event, header, value)
  }
  setResponseStatus(
    event,
    rendered.status && rendered.status !== 200 ? rendered.status : fallback.status,
    rendered.statusText || fallback.statusText,
  )
  return send(event, html)
}

/**
 * API paths answer with the read API's JSON envelope even when a failure
 * escapes a handler, so a caller never receives the framework's HTML error
 * document. Page routes keep the application's error page.
 */
const errorHandler: NitroErrorHandler = (error, event, context) => {
  if (!isApiPath(event.path)) return renderPageError(error, event, context)

  const statusCode = error.statusCode ?? 500
  const data = error.data as { error?: unknown; message?: unknown } | undefined
  const body =
    data !== null && typeof data === 'object' && typeof data.error === 'string'
      ? { error: data.error, message: typeof data.message === 'string' ? data.message : data.error }
      : {
          error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
          message:
            statusCode >= 500 ? 'Internal server error' : (error.message ?? 'Invalid request'),
        }
  setResponseStatus(event, statusCode)
  setResponseHeader(event, 'content-type', 'application/json; charset=utf-8')
  return send(event, JSON.stringify(body))
}

export default errorHandler
