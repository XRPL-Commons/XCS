import { defineEventHandler, createError, type EventHandler } from 'h3'
declare module 'h3' {
  interface H3EventContext {
    xcsIssuer?: EventHandler
  }
}
export default defineEventHandler((event) => {
  if (!event.context.xcsIssuer) throw createError({ statusCode: 503, message: 'ISSUER_DISABLED' })
  return event.context.xcsIssuer(event)
})
