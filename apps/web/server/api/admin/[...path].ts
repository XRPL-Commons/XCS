import { defineEventHandler, setResponseHeader, setResponseStatus, type EventHandler } from 'h3'
declare module 'h3' {
  interface H3EventContext {
    xcsAdmin?: EventHandler
  }
}
export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', 'private, no-store')
  if (event.context.xcsAdmin) return event.context.xcsAdmin(event)
  setResponseStatus(event, 503)
  return { error: 'ADMIN_UNAVAILABLE' }
})
