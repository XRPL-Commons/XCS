import { readdirSync, readFileSync } from 'node:fs'

import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import {
  credentialEvents,
  credentialGenerations,
  demoPins,
  indexerIncidents,
  indexerStatuses,
  ledgerCheckpoints,
  networkProfiles,
  pinChallenges,
  schemaEvents,
  schemas,
} from '../src/schema/index.js'

const DRIZZLE_DIRECTORY = new URL('../drizzle/', import.meta.url)

const PROJECTION_INTEGRITY_CHECKS = [
  [ledgerCheckpoints, ['ledger_checkpoints_index_uint32', 'ledger_checkpoints_close_time_uint32']],
  [schemaEvents, ['schema_events_ledger_index_uint32']],
  [schemas, ['schemas_ledger_index_uint32', 'schemas_transaction_index']],
  [
    credentialGenerations,
    [
      'credential_generations_expiration_uint32',
      'credential_generations_created_ledger_uint32',
      'credential_generations_created_transaction_index',
      'credential_generations_last_ledger_uint32',
      'credential_generations_deleted_ledger_uint32',
      'credential_generations_ledger_order',
    ],
  ],
  [
    credentialEvents,
    [
      'credential_events_node_index',
      'credential_events_ledger_index_uint32',
      'credential_events_transaction_index',
      'credential_events_expiration_uint32',
    ],
  ],
] as const

describe('database schema', () => {
  it('uses the stable public table names', () => {
    expect(
      [
        networkProfiles,
        ledgerCheckpoints,
        indexerStatuses,
        indexerIncidents,
        schemaEvents,
        schemas,
        credentialGenerations,
        credentialEvents,
        pinChallenges,
        demoPins,
      ].map(getTableName),
    ).toEqual([
      'network_profiles',
      'ledger_checkpoints',
      'indexer_status',
      'indexer_incidents',
      'schema_events',
      'schemas',
      'credential_generations',
      'credential_events',
      'pin_challenges',
      'demo_pins',
    ])
  })

  it('declares the final projection constraints directly', () => {
    for (const [table, expectedNames] of PROJECTION_INTEGRITY_CHECKS) {
      const declaredNames = getTableConfig(table).checks.map((constraint) => constraint.name)
      expect(declaredNames).toEqual(expect.arrayContaining([...expectedNames]))
    }

    const statusChecks = getTableConfig(indexerStatuses).checks.map(({ name }) => name)
    expect(statusChecks).toEqual(
      expect.arrayContaining([
        'indexer_status_agreed_ledger',
        'indexer_status_ready_shape',
        'indexer_status_writer_epoch',
        'indexer_status_lease_window',
      ]),
    )

    const incidentConfig = getTableConfig(indexerIncidents)
    expect(incidentConfig.primaryKeys.map((key) => key.getName())).toContain('indexer_incidents_pk')
    expect(incidentConfig.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'indexer_incidents_writer_epoch',
        'indexer_incidents_error_code',
        'indexer_incidents_primary_tip',
        'indexer_incidents_secondary_tip',
        'indexer_incidents_agreed_ledger',
      ]),
    )
  })

  it('makes fields required when every valid current row needs them', () => {
    expect(ledgerCheckpoints.transactionRoot.notNull).toBe(true)
    expect(credentialEvents.generationId.notNull).toBe(true)
    expect(indexerStatuses.writerEpoch.notNull).toBe(true)
    expect(indexerStatuses.writerId.notNull).toBe(false)
    expect(indexerStatuses.leaseExpiresAt.notNull).toBe(false)
  })

  it('ships one generated baseline instead of pre-production migration history', () => {
    const migrationFiles = readdirSync(DRIZZLE_DIRECTORY).filter((name) => name.endsWith('.sql'))
    const snapshotFiles = readdirSync(new URL('meta/', DRIZZLE_DIRECTORY)).filter((name) =>
      name.endsWith('_snapshot.json'),
    )
    expect(migrationFiles).toEqual(['0000_baseline.sql'])
    expect(snapshotFiles).toEqual(['0000_snapshot.json'])

    const baseline = readFileSync(new URL('0000_baseline.sql', DRIZZLE_DIRECTORY), 'utf8')
    expect(baseline).toContain('CREATE TABLE "ledger_checkpoints"')
    expect(baseline).toContain('"transaction_root" text NOT NULL')
    expect(baseline).toContain('CREATE TABLE "credential_events"')
    expect(baseline).toContain('"generation_id" text NOT NULL')
    expect(baseline).toContain('CREATE TABLE "indexer_incidents"')

    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> }
    expect(journal.entries).toEqual([expect.objectContaining({ idx: 0, tag: '0000_baseline' })])
  })
})
