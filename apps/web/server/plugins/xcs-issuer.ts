import { defineNitroPlugin } from 'nitropack/runtime'
import { createError } from 'h3'
import { createDatabaseClient } from '../lib/db/index.js'
import { loadIssuerConfig } from '../xcs/issuer/config'
import { apiEnvironment } from '../xcs/settings'
import { createIssuerHandler } from '../xcs/issuer/http'
import { IssuerRepository } from '../xcs/issuer/repository'
import { PrivateDocumentStorage } from '../xcs/issuer/storage'
import { sendIssuerNotification } from '../xcs/issuer/notifications'
import { createSmtpDelivery } from '../xcs/notifications/smtp'
import type { IssuerServices } from '../xcs/issuer/services'
import { createPrivateDocumentBackend } from '../xcs/documents/storage'

export default defineNitroPlugin((nitroApp) => {
  const config = loadIssuerConfig(apiEnvironment())
  if (!config) return
  const database = createDatabaseClient(config.databaseUrl, { onNotice: () => undefined })
  const { transport, sender } = createSmtpDelivery(process.env)
  const documentBackend = createPrivateDocumentBackend(config.storage)
  const repository = new IssuerRepository(database, {
    ...config,
    documents: new PrivateDocumentStorage(documentBackend),
    notify: (message) => sendIssuerNotification(transport, message, sender),
  })
  const handler = createIssuerHandler({
    repository,
    authorize: (event, mutation) => {
      if (!event.context.xcsRequireSession)
        throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
      return event.context.xcsRequireSession(event, mutation)
    },
    readSession: (event) => {
      if (!event.context.xcsReadSession)
        throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
      return event.context.xcsReadSession(event)
    },
  })
  const services: IssuerServices = { database, repository, config }
  nitroApp.hooks.hook('request', (event) => {
    event.context.xcsIssuer = handler
    event.context.xcsIssuerServices = services
  })
  nitroApp.hooks.hook('close', async () => {
    documentBackend.close?.()
    transport.close()
    await database.close()
  })
})
