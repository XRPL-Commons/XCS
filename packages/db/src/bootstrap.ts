import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/postgres-js/migrator'

import type { DatabaseClient } from './client.js'
import { provisionRuntimeDatabaseRoles, type RuntimeDatabasePasswords } from './provision.js'

const BASELINE_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

export {
  databasePasswordFromUrl,
  parseDatabaseClusterScope,
  provisionRuntimeDatabaseRoles,
  XCS_API_DATABASE_CONNECTION_LIMIT,
  XCS_API_DATABASE_ROLE,
  XCS_DATABASE_CLUSTER_SCOPE,
  XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
  XCS_INDEXER_DATABASE_ROLE,
  XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
  XCS_MONITOR_DATABASE_ROLE,
  type RuntimeDatabasePasswords,
} from './provision.js'

export async function initializeDatabase(client: DatabaseClient): Promise<void> {
  await migrate(client.db, { migrationsFolder: BASELINE_FOLDER })
}

export async function bootstrapDatabase(
  client: DatabaseClient,
  passwords: RuntimeDatabasePasswords,
): Promise<void> {
  await initializeDatabase(client)
  await provisionRuntimeDatabaseRoles(client, passwords)
}
