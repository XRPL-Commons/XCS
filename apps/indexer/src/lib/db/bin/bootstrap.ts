// Copied from packages/db/src/bin/bootstrap.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import {
  bootstrapDatabase,
  databasePasswordFromUrl,
  parseDatabaseClusterScope,
} from '../bootstrap.js'
import { createDatabaseClient } from '../client.js'
import { optionalEnvironment, requiredEnvironment } from './environment.js'

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')
  const applicationPassword = optionalEnvironment('XCS_APP_DATABASE_PASSWORD')
  const adminApplicationPassword = optionalEnvironment('XCS_ADMIN_DATABASE_PASSWORD')
  const notifierPassword = optionalEnvironment('XCS_NOTIFIER_DATABASE_PASSWORD')
  const issuerPassword = optionalEnvironment('XCS_ISSUER_DATABASE_PASSWORD')
  const client = createDatabaseClient(databaseUrl, { onNotice: () => undefined })

  try {
    await bootstrapDatabase(client, {
      clusterScope: parseDatabaseClusterScope(process.env.XCS_DATABASE_CLUSTER_SCOPE),
      administratorPassword: databasePasswordFromUrl(databaseUrl),
      indexerPassword: requiredEnvironment('XCS_INDEXER_DATABASE_PASSWORD'),
      apiPassword: requiredEnvironment('XCS_API_DATABASE_PASSWORD'),
      payloadWriterPassword: requiredEnvironment('XCS_PAYLOAD_DATABASE_PASSWORD'),
      monitorPassword: requiredEnvironment('XCS_MONITOR_DATABASE_PASSWORD'),
      ...(applicationPassword === undefined ? {} : { applicationPassword }),
      ...(adminApplicationPassword === undefined ? {} : { adminApplicationPassword }),
      ...(notifierPassword === undefined ? {} : { notifierPassword }),
      ...(issuerPassword === undefined ? {} : { issuerPassword }),
    })
    process.stdout.write(
      `${JSON.stringify({ ok: true, roles: ['xcs_indexer', 'xcs_api', 'xcs_monitor', 'xcs_payload_writer', ...(applicationPassword === undefined ? [] : ['xcs_app']), ...(adminApplicationPassword === undefined ? [] : ['xcs_admin_app']), ...(notifierPassword === undefined ? [] : ['xcs_notifier']), ...(issuerPassword === undefined ? [] : ['xcs_issuer'])] })}\n`,
    )
  } finally {
    await client.close()
  }
}

try {
  await main()
} catch {
  // Do not serialize the thrown error: connection errors may contain a URL or password.
  process.stderr.write(`${JSON.stringify({ ok: false, code: 'DATABASE_BOOTSTRAP_FAILED' })}\n`)
  process.exitCode = 1
}
