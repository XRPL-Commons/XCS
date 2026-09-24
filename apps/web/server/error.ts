import type { NitroErrorHandler } from 'nitropack'

import { isApiPath } from './utils/apiPaths'

/**
 * API paths answer with the read API's JSON envelope even when a failure
 * escapes a handler, so a caller never receives the framework's HTML error
 * document. Page routes keep the default renderer.
 */
const errorHandler: NitroErrorHandler = (error, event, { defaultHandler }) => {
  if (!isApiPath(event.path)) return defaultHandler(error, event)

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
