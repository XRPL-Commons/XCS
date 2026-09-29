import { describe, expect, it, vi } from 'vitest'

import {
  bootstrapDatabase,
  MissingRuntimeDatabaseRolesError,
  parseDatabaseClusterScope,
  provisionRuntimeDatabasePrivileges,
  UnsafeRuntimeDatabaseRolesError,
  XCS_RUNTIME_DATABASE_ROLES,
} from '../../src/lib/db/bootstrap.js'

import type { DatabaseClient } from '../../src/lib/db/client.js'

interface FakeDatabase extends DatabaseClient {
  unsafeStatements: string[]
}

const ADMINISTRATOR = 'cluster_admin'

function databaseWithRoles(
  existingRoles: readonly string[],
  options: {
    unsafeAttributes?: readonly string[]
    memberships?: ReadonlyArray<{ grantedRole: string; memberRole: string }>
    monitorMembershipPresent?: boolean
    refuse?: RegExp
  } = {},
): FakeDatabase {
  const unsafeStatements: string[] = []
  const transaction = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join('?')
      if (statement.includes('current_user')) return [{ administrator: ADMINISTRATOR }]
      if (statement.includes('SELECT EXISTS') && statement.includes('pg_auth_members')) {
        return [{ present: options.monitorMembershipPresent ?? false }]
      }
      return []
    }),
    {
      unsafe: vi.fn(async (statement: string) => {
        unsafeStatements.push(statement)
        if (statement.includes('FROM pg_roles')) {
          return existingRoles.map((roleName) => ({
            roleName,
            canLogin: true,
            isSuperuser: false,
            canCreateDatabase: false,
            canCreateRole: options.unsafeAttributes?.includes(roleName) ?? false,
            canReplicate: false,
            canBypassRls: false,
            connectionLimit: -1,
            configuration: [],
          }))
        }
        if (statement.includes('FROM pg_auth_members')) return options.memberships ?? []
        if (options.refuse?.test(statement)) throw new Error('statement refused')
        return []
      }),
      savepoint: vi.fn(async (handler: (sql: unknown) => Promise<unknown>) => handler(transaction)),
    },
  )
  return {
    db: {} as DatabaseClient['db'],
    sql: {
      begin: vi.fn(async (handler: (sql: typeof transaction) => Promise<unknown>) =>
        handler(transaction),
      ),
    } as unknown as DatabaseClient['sql'],
    close: vi.fn(),
    unsafeStatements,
  }
}

function appliedStatements(database: FakeDatabase): string {
  return database.unsafeStatements.filter((statement) => !/^\s*SELECT/iu.test(statement)).join('\n')
}

describe('runtime database privilege provisioning', () => {
  it('requires an explicit dedicated-cluster acknowledgement before opening a transaction', async () => {
    expect(parseDatabaseClusterScope('dedicated')).toBe('dedicated')
    expect(() => parseDatabaseClusterScope(undefined)).toThrow('must be dedicated')
    expect(() => parseDatabaseClusterScope('shared')).toThrow('must be dedicated')

    const database = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES)
    await expect(
      provisionRuntimeDatabasePrivileges(database, {
        clusterScope: 'shared' as 'dedicated',
      }),
    ).rejects.toThrow('must be dedicated')
    expect(database.sql.begin).not.toHaveBeenCalled()
  })

  it.each([
    [[], XCS_RUNTIME_DATABASE_ROLES.join(', ')],
    [
      XCS_RUNTIME_DATABASE_ROLES.filter((role) => role !== 'xcs_payload_writer'),
      'xcs_payload_writer',
    ],
    [XCS_RUNTIME_DATABASE_ROLES.filter((role) => role !== 'xcs_issuer'), 'xcs_issuer'],
  ])(
    'fails by name before applying SQL when DigitalOcean has not created every user',
    async (existingRoles, expectedNames) => {
      const database = databaseWithRoles(existingRoles)

      const operation = provisionRuntimeDatabasePrivileges(database, {
        clusterScope: 'dedicated',
      })
      await expect(operation).rejects.toBeInstanceOf(MissingRuntimeDatabaseRolesError)

      const repeated = provisionRuntimeDatabasePrivileges(database, {
        clusterScope: 'dedicated',
      })
      await expect(repeated).rejects.toThrow(expectedNames)
      await expect(
        provisionRuntimeDatabasePrivileges(database, { clusterScope: 'dedicated' }),
      ).rejects.toThrow('doctl databases user create')
      expect(appliedStatements(database)).toBe('')
    },
  )

  it('checks every managed user before bootstrap migration DDL', async () => {
    const database = databaseWithRoles(
      XCS_RUNTIME_DATABASE_ROLES.filter((role) => role !== 'xcs_admin_app'),
    )

    await expect(bootstrapDatabase(database, { clusterScope: 'dedicated' })).rejects.toThrow(
      'xcs_admin_app',
    )
    expect(appliedStatements(database)).toBe('')
  })

  it('validates and grants all eight users without managing their roles or authentication', async () => {
    const database = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES)

    await expect(
      provisionRuntimeDatabasePrivileges(database, { clusterScope: 'dedicated' }),
    ).resolves.toEqual({ administrator: ADMINISTRATOR, unappliedResourceControls: [] })

    const applied = appliedStatements(database)
    expect(applied).not.toMatch(/CREATE ROLE/iu)
    expect(applied).not.toMatch(/PASSWORD/iu)
    expect(applied).not.toMatch(/NOLOGIN/iu)
    expect(applied).not.toMatch(/VALID UNTIL/iu)
    expect(applied).not.toMatch(/RESET ALL/iu)
    for (const attribute of ['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS']) {
      expect(applied).not.toContain(attribute)
    }
    for (const role of XCS_RUNTIME_DATABASE_ROLES) {
      expect(applied).toContain(role)
    }
    expect(applied).toContain('GRANT pg_monitor TO xcs_monitor')
    expect(applied).toContain('hosted_payloads, hosted_payload_publications TO xcs_payload_writer')
    expect(applied).toContain(
      'app_sessions, app_auth_transactions, app_wallet_challenges TO xcs_app',
    )
    expect(applied).toContain('app_admin_decisions, app_admin_notifications TO xcs_admin_app')
    expect(applied).toContain('app_admin_notifications, app_admin_decisions TO xcs_notifier')
    expect(applied).toContain('app_presentation_proofs TO xcs_issuer')
  })

  it('fails closed on elevated attributes or unexpected memberships', async () => {
    const elevated = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      unsafeAttributes: ['xcs_api'],
    })
    await expect(
      provisionRuntimeDatabasePrivileges(elevated, { clusterScope: 'dedicated' }),
    ).rejects.toBeInstanceOf(UnsafeRuntimeDatabaseRolesError)
    expect(appliedStatements(elevated)).toBe('')

    const delegated = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      memberships: [{ grantedRole: 'xcs_issuer', memberRole: 'xcs_app' }],
    })
    await expect(
      provisionRuntimeDatabasePrivileges(delegated, { clusterScope: 'dedicated' }),
    ).rejects.toThrow('xcs_app, xcs_issuer')
    expect(appliedStatements(delegated)).toBe('')

    const administered = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      memberships: XCS_RUNTIME_DATABASE_ROLES.map((grantedRole) => ({
        grantedRole,
        memberRole: ADMINISTRATOR,
      })),
    })
    await expect(
      provisionRuntimeDatabasePrivileges(administered, { clusterScope: 'dedicated' }),
    ).resolves.toEqual({ administrator: ADMINISTRATOR, unappliedResourceControls: [] })

    const monitor = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      memberships: [{ grantedRole: 'pg_monitor', memberRole: 'xcs_monitor' }],
    })
    await expect(
      provisionRuntimeDatabasePrivileges(monitor, { clusterScope: 'dedicated' }),
    ).resolves.toEqual({ administrator: ADMINISTRATOR, unappliedResourceControls: [] })
  })

  it('reports a refused pg_monitor grant without rolling back application grants', async () => {
    const database = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      refuse: /^GRANT pg_monitor/iu,
    })

    await expect(
      provisionRuntimeDatabasePrivileges(database, { clusterScope: 'dedicated' }),
    ).resolves.toEqual({
      administrator: ADMINISTRATOR,
      unappliedResourceControls: [
        {
          role: 'xcs_monitor',
          control: 'pg_monitor membership',
          intended: 'granted',
          actual: 'absent',
        },
      ],
    })
    expect(appliedStatements(database)).toContain('app_presentation_proofs TO xcs_issuer')

    const alreadyHeld = databaseWithRoles(XCS_RUNTIME_DATABASE_ROLES, {
      refuse: /^GRANT pg_monitor/iu,
      monitorMembershipPresent: true,
    })
    await expect(
      provisionRuntimeDatabasePrivileges(alreadyHeld, { clusterScope: 'dedicated' }),
    ).resolves.toEqual({ administrator: ADMINISTRATOR, unappliedResourceControls: [] })
  })
})
