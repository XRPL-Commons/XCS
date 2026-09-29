import { createError, defineEventHandler } from 'h3'

export default defineEventHandler((event) => {
  if (!event.context.xcsRecipient)
    throw createError({ statusCode: 503, message: 'RECIPIENT_DISABLED' })
  return event.context.xcsRecipient(event)
})
