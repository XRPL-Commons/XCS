import { createError, defineEventHandler, type EventHandler } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'
import { createVerifierHandler } from '../xcs/verifier/http'
import { createVerifierServices, type VerifierServices } from '../xcs/verifier/services'
import { evidencePolicyFromConfig } from '../xcs/presentations/evidence'

export default defineNitroPlugin((nitroApp) => {
  let services: VerifierServices | undefined
  let handler: EventHandler | undefined
  // Initialization happens when a route executes, after all request hooks. The shared pool
  // is owned and closed by the issuer plugin; handlers and rate limiters survive requests.
  nitroApp.hooks.hook('request', (event) => {
    event.context.xcsVerifierServices = () => {
      if (!services) {
        const issuer = event.context.xcsIssuerServices
        if (!issuer) throw createError({ statusCode: 503, message: 'VERIFIER_DISABLED' })
        services = createVerifierServices(
          issuer,
          evidencePolicyFromConfig(event.context.xcs.config),
        )
      }
      return services
    }
    event.context.xcsVerifier = defineEventHandler(async (request) => {
      if (!handler) {
        const { repository, presentations } = request.context.xcsVerifierServices!()
        handler = createVerifierHandler({
          repository,
          authorize: (event, mutation) => {
            if (!event.context.xcsRequireSession)
              throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
            return event.context.xcsRequireSession(event, mutation)
          },
          resolvePresentation: (session, id) => presentations.resolveById(session, id),
        })
      }
      return handler(request)
    })
  })
})
