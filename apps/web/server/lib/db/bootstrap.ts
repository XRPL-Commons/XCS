// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
import type { DatabaseClient } from './client.js'
import { migrateDatabase, migrateDatabaseInTransaction } from './migrations.js'
import {
  applyRuntimeDatabasePrivilegesInTransaction,
  parseDatabaseClusterScope,
  prepareRuntimeDatabaseProvisioningInTransaction,
  type RuntimeDatabaseProvisioning,
  type RuntimeDatabaseProvisioningReport,
} from './provision.js'

export {
  DatabaseBootstrapConfigurationError,
  MissingRuntimeDatabaseRolesError,
  UnsafeRuntimeDatabaseRolesError,
  parseDatabaseClusterScope,
  provisionRuntimeDatabasePrivileges,
  XCS_API_DATABASE_CONNECTION_LIMIT,
  XCS_API_DATABASE_ROLE,
  XCS_APP_DATABASE_ROLE,
  XCS_ADMIN_APP_DATABASE_ROLE,
  XCS_NOTIFIER_DATABASE_ROLE,
  XCS_ISSUER_DATABASE_ROLE,
  XCS_PAYLOAD_WRITER_DATABASE_ROLE,
  XCS_DATABASE_CLUSTER_SCOPE,
  XCS_INDEXER_DATABASE_CONNECTION_LIMIT,
  XCS_INDEXER_DATABASE_ROLE,
  XCS_MONITOR_DATABASE_CONNECTION_LIMIT,
  XCS_MONITOR_DATABASE_ROLE,
  XCS_RUNTIME_DATABASE_ROLES,
  type RuntimeDatabaseProvisioning,
  type RuntimeDatabaseProvisioningReport,
  type UnappliedRuntimeRoleResourceControl,
} from './provision.js'

export async function initializeDatabase(client: DatabaseClient): Promise<void> {
  await migrateDatabase(client)
}

export async function bootstrapDatabase(
  client: DatabaseClient,
  provisioning: RuntimeDatabaseProvisioning,
): Promise<RuntimeDatabaseProvisioningReport> {
  // Reject an invalid acknowledgement before reserving a connection.
  parseDatabaseClusterScope(provisioning.clusterScope)
  return await client.sql.begin(async (transaction) => {
    // DigitalOcean must have created every user before any migration changes state.
    const administrator = await prepareRuntimeDatabaseProvisioningInTransaction(
      transaction,
      provisioning,
    )
    await migrateDatabaseInTransaction(transaction)
    return await applyRuntimeDatabasePrivilegesInTransaction(transaction, administrator)
  })
}
