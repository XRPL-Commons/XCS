import { defineNitroPlugin } from 'nitropack/runtime'
import { createError, defineEventHandler, type EventHandler } from 'h3'
import type {} from '../xcs/issuer/services'
import type {} from '../xcs/verifier/services'
import { RecipientRepository } from '../xcs/recipient/repository'
import { createRecipientHandler } from '../xcs/recipient/http'
import { createPresentationHandler } from '../xcs/presentations/http'
import { evidencePolicyFromConfig } from '../xcs/presentations/evidence'

declare module 'h3' {
  interface H3EventContext {
    xcsRecipient?: EventHandler
    xcsPresentation?: EventHandler
  }
}

export default defineNitroPlugin((nitroApp) => {
  // Resolve shared services after all request hooks; keep repositories and rate limiters per plugin.
  let recipient: EventHandler | undefined
  let presentation: EventHandler | undefined
  const recipientRoute = defineEventHandler((event) => {
    const services = event.context.xcsIssuerServices
    if (!services) throw createError({ statusCode: 503, message: 'RECIPIENT_DISABLED' })
    recipient ??= createRecipientHandler({
      repository: new RecipientRepository(
        services.database,
        services.config.origin,
        evidencePolicyFromConfig(event.context.xcs.config),
      ),
      authorize: (request, mutation) => {
        if (!request.context.xcsRequireSession)
          throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
        return request.context.xcsRequireSession(request, mutation)
      },
    })
    return recipient(event)
  })
  const presentationRoute = defineEventHandler((event) => {
    const issuer = event.context.xcsIssuerServices
    const services = event.context.xcsVerifierServices?.()
    if (!issuer || !services)
      throw createError({ statusCode: 503, message: 'PRESENTATION_DISABLED' })
    presentation ??= createPresentationHandler({
      repository: services.presentations,
      origin: issuer.config.origin,
      readSession: (request) => {
        if (!request.context.xcsReadSession)
          throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
        return request.context.xcsReadSession(request)
      },
    })
    return presentation(event)
  })
  nitroApp.hooks.hook('request', (event) => {
    event.context.xcsRecipient = recipientRoute
    event.context.xcsPresentation = presentationRoute
  })
})
