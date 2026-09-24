import { createError, defineEventHandler, type EventHandler } from 'h3'

declare module 'h3' {
  interface H3EventContext {
    xcsVerifier?: EventHandler
  }
}

export default defineEventHandler((event) => {
  if (!event.context.xcsVerifier)
    throw createError({ statusCode: 503, message: 'VERIFIER_DISABLED' })
  return event.context.xcsVerifier(event)
})
