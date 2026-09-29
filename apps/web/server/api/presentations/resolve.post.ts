import { createError, defineEventHandler } from 'h3'

export default defineEventHandler((event) => {
  if (!event.context.xcsPresentation)
    throw createError({ statusCode: 503, message: 'PRESENTATION_DISABLED' })
  return event.context.xcsPresentation(event)
})
