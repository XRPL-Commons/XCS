// Copied from packages/db/src/bootstrap.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import type { DatabaseClient } from './client.js'
import { migrateDatabase } from './migrations.js'
import {
  assertRuntimeDatabasePasswords,
  provisionRuntimeDatabaseRoles,
  type RuntimeDatabasePasswords,
} from './provision.js'

export {
  databasePasswordFromUrl,
  parseDatabaseClusterScope,
  provisionRuntimeDatabaseRoles,
  XCS_API_DATABASE_CONNECTION_LIMIT,
  XCS_API_DATABASE_ROLE,
  XCS_APP_DATABASE_CONNECTION_LIMIT,
  XCS_APP_DATABASE_ROLE,
  XCS_ADMIN_APP_DATABASE_ROLE,
  XCS_NOTIFIER_DATABASE_ROLE,
  XCS_ISSUER_DATABASE_ROLE,
  XCS_PAYLOAD_WRITER_DATABASE_CONNECTION_LIMIT,
  XCS_PAYLOAD_WRITER_DATABASE_ROLE,
  XCS_DATABASE_CLUSTER_SCOPE,
  XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
  XCS_INDEXER_DATABASE_ROLE,
  XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
  XCS_MONITOR_DATABASE_ROLE,
  type RuntimeDatabasePasswords,
} from './provision.js'

export async function initializeDatabase(client: DatabaseClient): Promise<void> {
  await migrateDatabase(client)
}

export async function bootstrapDatabase(
  client: DatabaseClient,
  passwords: RuntimeDatabasePasswords,
): Promise<void> {
  assertRuntimeDatabasePasswords(passwords)
  await initializeDatabase(client)
  await provisionRuntimeDatabaseRoles(client, passwords)
}
