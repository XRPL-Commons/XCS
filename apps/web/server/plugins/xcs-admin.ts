import { defineNitroPlugin } from 'nitropack/runtime'
import { createError } from 'h3'
import { createDatabaseClient } from '../lib/db/index.js'
import { loadAdminConfig } from '../xcs/admin/config'
import { apiEnvironment } from '../xcs/settings'
import { PrivateDocuments } from '../xcs/admin/documents'
import { createAdminHandler } from '../xcs/admin/http'
import { AdminRepository } from '../xcs/admin/repository'
import { createPrivateDocumentBackend } from '../xcs/documents/storage'

export default defineNitroPlugin((nitroApp) => {
  const config = loadAdminConfig(apiEnvironment())
  if (!config) return
  const database = createDatabaseClient(config.databaseUrl, { onNotice: () => undefined })
  const documentBackend = createPrivateDocumentBackend(config.storage)
  const handler = createAdminHandler({
    repository: new AdminRepository(database),
    documents: new PrivateDocuments(documentBackend, config.signingKey),
    authorize: (event, mutation) => {
      if (!event.context.xcsRequireAdmin)
        throw createError({ statusCode: 503, message: 'AUTH_UNAVAILABLE' })
      return event.context.xcsRequireAdmin(event, mutation)
    },
  })
  nitroApp.hooks.hook('request', (event) => {
    event.context.xcsAdmin = handler
  })
  nitroApp.hooks.hook('close', async () => {
    documentBackend.close?.()
    await database.close()
  })
})
