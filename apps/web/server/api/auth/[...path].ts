import { defineEventHandler, setResponseHeader, setResponseStatus, type EventHandler } from 'h3'

declare module 'h3' {
  interface H3EventContext {
    xcsAuth?: EventHandler
  }
}

export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'private, no-store')
  if (event.context.xcsAuth) return event.context.xcsAuth(event)
  if (event.method === 'GET' && event.path.split('?')[0] === '/api/auth/session') {
    return { enabled: false, user: null }
  }
  setResponseStatus(event, 503)
  return { error: 'AUTH_UNAVAILABLE' }
})
