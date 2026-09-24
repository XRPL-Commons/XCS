import { defineNitroPlugin } from 'nitropack/runtime'
import { createError } from 'h3'
import { createDatabaseClient } from '../lib/db/index.js'
import { loadIssuerConfig } from '../xcs/issuer/config'
import { createIssuerHandler } from '../xcs/issuer/http'
import { IssuerRepository } from '../xcs/issuer/repository'
import { PrivateDocumentStorage } from '../xcs/issuer/storage'
import { createLocalSmtpTransport, sendIssuerNotification } from '../xcs/issuer/notifications'
import type { IssuerServices } from '../xcs/issuer/services'

export default defineNitroPlugin((nitroApp) => {
  const config = loadIssuerConfig(process.env)
  if (!config) return
  const database = createDatabaseClient(config.databaseUrl, { onNotice: () => undefined })
  const transport = createLocalSmtpTransport(process.env)
  const repository = new IssuerRepository(database, {
    ...config,
    documents: new PrivateDocumentStorage(config.directory),
    notify: (message) => sendIssuerNotification(transport, message),
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
    transport.close()
    await database.close()
  })
})
