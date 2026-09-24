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
} from '#db/schema/index.js'

const DRIZZLE_DIRECTORY = new URL('../../../../db/migrations/', import.meta.url)

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

  it('preserves deployed migrations and appends the application model', () => {
    const migrationFiles = readdirSync(DRIZZLE_DIRECTORY).filter((name) => name.endsWith('.sql'))
    const snapshotFiles = readdirSync(new URL('meta/', DRIZZLE_DIRECTORY)).filter((name) =>
      name.endsWith('_snapshot.json'),
    )
    expect(migrationFiles).toEqual([
      '0000_baseline.sql',
      '0001_hosted_payloads.sql',
      '0002_hosted_payload_locator_compatibility.sql',
      '0003_application_model.sql',
      '0004_auth_sessions.sql',
      '0005_admin_review.sql',
      '0006_issuer_workspace.sql',
      '0007_recipient_verifier.sql',
      '0008_presentation_wallet_proof.sql',
    ])
    expect(snapshotFiles).toEqual([
      '0000_snapshot.json',
      '0001_snapshot.json',
      '0002_snapshot.json',
      '0003_snapshot.json',
      '0004_snapshot.json',
      '0005_snapshot.json',
      '0006_snapshot.json',
      '0007_snapshot.json',
      '0008_snapshot.json',
    ])

    const baseline = readFileSync(new URL('0000_baseline.sql', DRIZZLE_DIRECTORY), 'utf8')
    expect(baseline).toContain('CREATE TABLE "ledger_checkpoints"')
    expect(baseline).toContain('"transaction_root" text NOT NULL')
    expect(baseline).toContain('CREATE TABLE "credential_events"')
    expect(baseline).toContain('"generation_id" text NOT NULL')
    expect(baseline).toContain('CREATE TABLE "indexer_incidents"')

    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', DRIZZLE_DIRECTORY), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> }
    expect(journal.entries).toEqual([
      expect.objectContaining({ idx: 0, tag: '0000_baseline' }),
      expect.objectContaining({ idx: 1, tag: '0001_hosted_payloads' }),
      expect.objectContaining({ idx: 2, tag: '0002_hosted_payload_locator_compatibility' }),
      expect.objectContaining({ idx: 3, tag: '0003_application_model' }),
      expect.objectContaining({ idx: 4, tag: '0004_auth_sessions' }),
      expect.objectContaining({ idx: 5, tag: '0005_admin_review' }),
      expect.objectContaining({ idx: 6, tag: '0006_issuer_workspace' }),
      expect.objectContaining({ idx: 7, tag: '0007_recipient_verifier' }),
      expect.objectContaining({ idx: 8, tag: '0008_presentation_wallet_proof' }),
    ])

    const previous = JSON.parse(
      readFileSync(new URL('meta/0002_snapshot.json', DRIZZLE_DIRECTORY), 'utf8'),
    ) as { tables: Record<string, unknown> }
    const current = JSON.parse(
      readFileSync(new URL('meta/0003_snapshot.json', DRIZZLE_DIRECTORY), 'utf8'),
    ) as { tables: Record<string, unknown> }
    for (const [name, definition] of Object.entries(previous.tables)) {
      expect(current.tables[name]).toEqual(definition)
    }
    expect(Object.keys(current.tables).filter((name) => !(name in previous.tables))).toHaveLength(
      10,
    )
  })
})
