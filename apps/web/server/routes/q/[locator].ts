import { defineEventHandler, createError } from 'h3'

export default defineEventHandler((event) => {
  if (!event.context.xcsIssuer)
    throw createError({ statusCode: 503, message: 'ISSUER_UNAVAILABLE' })
  return event.context.xcsIssuer(event)
})
