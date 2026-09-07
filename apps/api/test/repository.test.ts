import {
  credentialEvents,
  credentialGenerations,
  schemaEvents,
  schemas,
  type SchemaEventRow,
  type SchemaRow,
  type XcsDatabase,
} from '@xcs-protocol/db'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

import { PostgresApiRepository } from '../src/repository.js'
import { MAX_SCHEMA_CATALOG_ENTRIES } from '../src/schema-catalog.js'

const NOW = new Date('2026-08-24T12:00:00.000Z')
const schemaRegistration: SchemaEventRow = {
  profileId: 'testnet',
  transactionHash: 'a'.repeat(64),
  ledgerIndex: 100,
  ledgerHash: 'b'.repeat(64),
  transactionIndex: 0,
  publisher: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  status: 'accepted',
  reasonCode: null,
  schemaUid: 'c'.repeat(64),
  memoJson: {},
  recordedAt: NOW,
}
const schemaRow: SchemaRow = {
  profileId: 'testnet',
  schemaUid: schemaRegistration.schemaUid!,
  publisher: schemaRegistration.publisher,
  name: 'Course',
  description: 'Course schema',
  parentUid: null,
  supersedesUid: null,
  definition: {},
  resolvedDefinition: {},
  registrationTransactionHash: schemaRegistration.transactionHash,
  ledgerIndex: schemaRegistration.ledgerIndex,
  transactionIndex: schemaRegistration.transactionIndex,
  registeredAt: NOW,
}

describe('PostgresApiRepository authority reads', () => {
  it('runs callbacks in a read-only repeatable-read transaction and uses database time', async () => {
    // postgres.js exposes raw CURRENT_TIMESTAMP values as strings through
    // Drizzle's execute() path, so the repository requests a numeric epoch.
    const execute = vi.fn(async (_statement: SQL) => [{ nowMilliseconds: NOW.getTime() }])
    const transactionDatabase = { execute } as unknown as XcsDatabase
    const transaction = vi.fn(
      async <T>(
        callback: (database: XcsDatabase) => Promise<T>,
        _config: { isolationLevel: string; accessMode: string },
      ) => callback(transactionDatabase),
    )
    const repository = new PostgresApiRepository({ transaction } as unknown as XcsDatabase)

    const observedAt = await repository.withConsistentSnapshot((snapshot) =>
      snapshot.getDatabaseTime(),
    )

    expect(observedAt).toEqual(NOW)
    expect(transaction).toHaveBeenCalledOnce()
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
    expect(execute).toHaveBeenCalledOnce()
    const statement = execute.mock.calls[0]?.[0]
    expect(statement).toBeDefined()
    expect(new PgDialect().sqlToQuery(statement!).sql).toContain(
      'EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)',
    )
  })

  it('looks up schema registration evidence by its unique profile and transaction key', async () => {
    const limit = vi.fn(async () => [schemaRegistration])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    const repository = new PostgresApiRepository({ select } as unknown as XcsDatabase)

    await expect(
      repository.getSchemaRegistrationByTransaction({
        profileId: 'testnet',
        transactionHash: schemaRegistration.transactionHash,
      }),
    ).resolves.toEqual(schemaRegistration)

    expect(from).toHaveBeenCalledWith(schemaEvents)
    expect(where).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith(1)
  })

  it('loads schema rows and their exact registration events for one UID set', async () => {
    const result = [{ schema: schemaRow, registration: schemaRegistration }]
    const where = vi.fn(async () => result)
    const innerJoin = vi.fn((_table: unknown, _condition: unknown) => ({ where }))
    const from = vi.fn(() => ({ innerJoin }))
    const select = vi.fn(() => ({ from }))
    const repository = new PostgresApiRepository({ select } as unknown as XcsDatabase)

    await expect(
      repository.getSchemaProjectionEvidence({
        profileId: 'testnet',
        schemaUids: [schemaRow.schemaUid],
      }),
    ).resolves.toEqual(result)

    expect(select).toHaveBeenCalledWith({ schema: schemas, registration: schemaEvents })
    expect(from).toHaveBeenCalledWith(schemas)
    expect(innerJoin.mock.calls[0]?.[0]).toBe(schemaEvents)
    expect(where).toHaveBeenCalledOnce()
  })

  it('expands both schema relation types recursively before loading catalog evidence', async () => {
    const parentUid = 'd'.repeat(64)
    const supersededUid = 'e'.repeat(64)
    const execute = vi.fn(async (_statement: SQL) => [
      { schemaUid: schemaRow.schemaUid },
      { schemaUid: parentUid },
      { schemaUid: supersededUid },
    ])
    const repository = new PostgresApiRepository({ execute } as unknown as XcsDatabase)
    const projectionRead = vi
      .spyOn(repository, 'getSchemaProjectionEvidence')
      .mockResolvedValue([{ schema: schemaRow, registration: schemaRegistration }])

    await expect(
      repository.getSchemaCatalogEvidence({
        profileId: 'testnet',
        targetUid: schemaRow.schemaUid,
      }),
    ).resolves.toEqual([{ schema: schemaRow, registration: schemaRegistration }])

    const statement = execute.mock.calls[0]?.[0] as SQL | undefined
    expect(statement).toBeDefined()
    const query = new PgDialect().sqlToQuery(statement!)
    expect(query.sql).toContain('WITH RECURSIVE catalog AS')
    expect(query.sql).toContain('related.schema_uid = catalog_entry.parent_uid')
    expect(query.sql).toContain('related.schema_uid = catalog_entry.supersedes_uid')
    expect(query.sql).toContain('LIMIT')
    expect(query.params).toContain(MAX_SCHEMA_CATALOG_ENTRIES + 1)
    expect(projectionRead).toHaveBeenCalledWith({
      profileId: 'testnet',
      schemaUids: [schemaRow.schemaUid, parentUid, supersededUid],
    })
  })

  it('bounds schema search, schema activity, and transaction event pages with one lookahead row', async () => {
    const limits: number[] = []
    const tables: unknown[] = []
    const select = vi.fn(() => ({
      from: (table: unknown) => {
        tables.push(table)
        return {
          where: () => ({
            orderBy: () => ({
              limit: async (value: number) => {
                limits.push(value)
                return []
              },
            }),
          }),
        }
      },
    }))
    const repository = new PostgresApiRepository({ select } as unknown as XcsDatabase)

    await repository.searchSchemas({ profileId: 'testnet', query: 'course%_', limit: 5 })
    await repository.listSchemaRegistrations({ profileId: 'testnet', limit: 3 })
    await repository.getCredentialEventsByTransactionPage({
      profileId: 'testnet',
      transactionHash: schemaRegistration.transactionHash,
      afterNodeIndex: 4,
      limit: 2,
    })

    expect(tables).toEqual([schemas, schemaEvents, credentialEvents])
    expect(limits).toEqual([6, 4, 3])
  })

  it('looks up a Credential generation only by profile and exact generation id', async () => {
    const limit = vi.fn(async () => [])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    const select = vi.fn(() => ({ from }))
    const repository = new PostgresApiRepository({ select } as unknown as XcsDatabase)

    await expect(
      repository.getCredentialGenerationById({
        profileId: 'testnet',
        generationId: 'd'.repeat(64),
      }),
    ).resolves.toBeUndefined()

    expect(from).toHaveBeenCalledWith(credentialGenerations)
    expect(where).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith(1)
  })

  it('counts out-of-range and contradictory lifecycle evidence in discovery stats', async () => {
    const selections: Array<Record<string, unknown>> = []
    const select = vi.fn((selection: Record<string, unknown>) => {
      selections.push(selection)
      const aggregate =
        selections.length === 1
          ? {
              total: 0,
              publishers: 0,
              minimumLedgerIndex: null,
              maximumLedgerIndex: null,
            }
          : {
              total: 0,
              pending: 0,
              active: 0,
              expired: 0,
              deleted: 0,
              invalidEvidence: 0,
              minimumCreatedLedgerIndex: null,
              maximumLastLedgerIndex: null,
            }
      return { from: () => ({ where: async () => [aggregate] }) }
    })
    const repository = new PostgresApiRepository({ select } as unknown as XcsDatabase)

    await repository.getDiscoveryStats({ profileId: 'testnet', checkpointCloseTime: 1_000 })

    const invalidEvidence = selections[1]?.invalidEvidence as SQL | undefined
    expect(invalidEvidence).toBeDefined()
    const query = new PgDialect().sqlToQuery(invalidEvidence!).sql
    expect(query).toContain('"last_ledger_index" < "credential_generations"."created_ledger_index"')
    expect(query).toContain('"credential_generations"."created_transaction_index" < 0')
    expect(query).toContain(
      '"deleted_ledger_index" < "credential_generations"."created_ledger_index"',
    )
    expect(query).toContain(
      '"deleted_ledger_index" <> "credential_generations"."last_ledger_index"',
    )
  })
})
