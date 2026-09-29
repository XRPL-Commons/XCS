// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
import {
  bootstrapDatabase,
  DatabaseBootstrapConfigurationError,
  MissingRuntimeDatabaseRolesError,
  parseDatabaseClusterScope,
  UnsafeRuntimeDatabaseRolesError,
  XCS_RUNTIME_DATABASE_ROLES,
} from '../bootstrap.js'
import { createDatabaseClient } from '../client.js'
import { requiredEnvironment } from './environment.js'

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')
  const client = createDatabaseClient(databaseUrl, {
    onNotice: () => undefined,
  })

  try {
    const report = await bootstrapDatabase(client, {
      clusterScope: parseDatabaseClusterScope(process.env.XCS_DATABASE_CLUSTER_SCOPE),
    })
    // The unapplied controls are named so a cluster that refuses a connection
    // limit or a timeout cannot cost a deployment one silently. They are role
    // names, parameter names and durations, so none of them is a credential.
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        roles: XCS_RUNTIME_DATABASE_ROLES,
        administrator: report.administrator,
        unappliedResourceControls: report.unappliedResourceControls,
      })}\n`,
    )
  } finally {
    await client.close()
  }
}

try {
  await main()
} catch (error) {
  // Never serialize an arbitrary thrown error: a driver error can carry the
  // connection string and therefore the administrator password. Three kinds are
  // built from fixed text and names alone, so their message is safe to print,
  // and for anything else only the driver's own short codes are emitted --
  // enough to tell a refused connection from a failed login or a missing
  // relation, and none of them contain a credential.
  if (
    error instanceof MissingRuntimeDatabaseRolesError ||
    error instanceof UnsafeRuntimeDatabaseRolesError ||
    error instanceof DatabaseBootstrapConfigurationError
  ) {
    const roles =
      error instanceof MissingRuntimeDatabaseRolesError
        ? { roles: error.roles }
        : error instanceof UnsafeRuntimeDatabaseRolesError
          ? { roles: error.roles, findings: error.findings }
          : {}
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code: error.code,
        ...roles,
        message: error.message,
      })}\n`,
    )
  } else {
    // Drivers and migration helpers wrap the original failure, so walk the
    // cause chain for the first entry that carries codes. Only these short
    // fields are read; no message from the chain is ever emitted.
    const codesOf = (value: unknown): Record<string, unknown> => {
      for (let current = value, depth = 0; current !== undefined && depth < 8; depth += 1) {
        const node = current as {
          code?: unknown
          errno?: unknown
          syscall?: unknown
          severity?: unknown
          where?: unknown
          routine?: unknown
          schema_name?: unknown
          table_name?: unknown
          cause?: unknown
        }
        if (typeof node.code === 'string' || typeof node.severity === 'string') return node
        current = node.cause
      }
      return {}
    }
    const detail = codesOf(error)
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code: 'DATABASE_BOOTSTRAP_FAILED',
        driverCode: typeof detail.code === 'string' ? detail.code : undefined,
        errno: typeof detail.errno === 'number' ? detail.errno : undefined,
        syscall: typeof detail.syscall === 'string' ? detail.syscall : undefined,
        severity: typeof detail.severity === 'string' ? detail.severity : undefined,
        // The server's `where` quotes the failing statement. Since provisioning
        // became grants-only, every statement this step runs is our own SQL and
        // carries no password, so naming it costs nothing and saves a round trip.
        where: typeof detail.where === 'string' ? detail.where : undefined,
        routine: typeof detail.routine === 'string' ? detail.routine : undefined,
        schema: typeof detail.schema_name === 'string' ? detail.schema_name : undefined,
        table: typeof detail.table_name === 'string' ? detail.table_name : undefined,
        hint: 'The message is withheld because it can contain the connection string. Reproduce with `psql "$XCS_BOOTSTRAP_DATABASE_URL" -c \'select 1\'` for the full text.',
      })}\n`,
    )
  }
  process.exitCode = 1
}
