import { adminSecret } from '../server/xcs/admin/config.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabaseClient } from '../server/lib/db/index.js'
import {
  createLocalSmtpTransport,
  PostgresNotificationRepository,
  processNextNotification,
} from '../server/xcs/admin/notifications.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--once')) throw new Error('Unsupported argument')
  const databaseUrl = adminSecret(process.env, 'XCS_NOTIFIER_DATABASE_URL')
  if (!databaseUrl) throw new Error('XCS_NOTIFIER_DATABASE_URL is required')
  const transport = createLocalSmtpTransport(process.env)
  const client = createDatabaseClient(databaseUrl, { onNotice: () => {} })
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const [role] = await client.sql`SELECT current_user AS role`
    if (role?.role !== 'xcs_notifier')
      throw new Error('The notifier requires the xcs_notifier DB role')
    const repository = new PostgresNotificationRepository(client)
    do {
      const outcome = await processNextNotification(repository, transport)
      if (outcome !== 'idle') console.log(`admin-notifier: ${outcome}`)
      if (args.includes('--once') || controller.signal.aborted) break
      if (outcome === 'idle') {
        await delay(2_000, undefined, { signal: controller.signal }).catch((error: unknown) => {
          if (!controller.signal.aborted) throw error
        })
      }
    } while (!controller.signal.aborted)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    transport.close()
    await client.close()
  }
}

main().catch(() => {
  // Connection/SMTP exceptions may carry credentials, addresses or message content.
  console.error('admin-notifier: stopped; check private configuration and database availability')
  process.exitCode = 1
})
