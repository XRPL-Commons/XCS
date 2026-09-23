import type { XcsDatabase } from '@xcs-protocol/db'
import { describe, expect, it, vi } from 'vitest'

import { PostgresOperationalMetricsRepository } from '../../server/xcs/operational-metrics-repository.js'

const NOW = new Date('2026-08-26T14:30:00.000Z')

describe('PostgresOperationalMetricsRepository', () => {
  it('reads database, indexer and registration gauges in one read-only snapshot', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          observedAt: NOW,
          usedConnections: '7',
          maxConnections: '100',
          sizeBytes: '1234567',
        },
      ])
      .mockResolvedValueOnce([
        {
          profileId: 'missing',
          activationLedgerIndex: '100',
          state: null,
          primarySourceTip: null,
          secondarySourceTip: null,
          lastAgreedLedgerIndex: null,
          lastAgreedLedgerHash: null,
          errorCode: null,
          writerPresent: false,
          leaseExpiresAt: null,
          statusUpdatedAt: null,
          checkpointLedgerIndex: null,
          checkpointLedgerHash: null,
          checkpointCloseTime: null,
          checkpointTransactionRootPresent: false,
          acceptedRegistrations: '0',
          rejectedRegistrations: '0',
          haltCount: '0',
          latestHaltWriterEpoch: null,
          latestHaltErrorCode: null,
          latestHaltPrimarySourceTip: null,
          latestHaltSecondarySourceTip: null,
          latestHaltLastAgreedLedgerIndex: null,
          latestHaltLastAgreedLedgerHashPresent: false,
          latestHaltRecordedAt: null,
        },
        {
          profileId: 'testnet',
          activationLedgerIndex: '100',
          state: 'ready',
          primarySourceTip: '1002',
          secondarySourceTip: '1001',
          lastAgreedLedgerIndex: '1001',
          lastAgreedLedgerHash: 'a'.repeat(64),
          errorCode: null,
          writerPresent: true,
          leaseExpiresAt: new Date(NOW.getTime() + 60_000),
          statusUpdatedAt: NOW,
          checkpointLedgerIndex: '1001',
          checkpointLedgerHash: 'a'.repeat(64),
          checkpointCloseTime: '841000000',
          checkpointTransactionRootPresent: true,
          acceptedRegistrations: '42',
          rejectedRegistrations: '3',
          haltCount: '1',
          latestHaltWriterEpoch: '6',
          latestHaltErrorCode: 'SOURCE_DIVERGENCE',
          latestHaltPrimarySourceTip: '999',
          latestHaltSecondarySourceTip: '998',
          latestHaltLastAgreedLedgerIndex: '997',
          latestHaltLastAgreedLedgerHashPresent: true,
          latestHaltRecordedAt: new Date(NOW.getTime() - 60_000),
        },
      ])
    const transaction = vi.fn(
      async <T>(
        callback: (database: { execute: typeof execute }) => Promise<T>,
        _config: { isolationLevel: string; accessMode: string },
      ) => callback({ execute }),
    )
    const repository = new PostgresOperationalMetricsRepository({
      transaction,
    } as unknown as XcsDatabase)

    await expect(repository.getSnapshot()).resolves.toEqual({
      observedAt: NOW,
      database: { usedConnections: 7, maxConnections: 100, sizeBytes: 1_234_567 },
      profiles: [
        {
          profileId: 'missing',
          activationLedgerIndex: 100,
          status: undefined,
          checkpoint: undefined,
          acceptedRegistrations: 0,
          rejectedRegistrations: 0,
          haltHistory: { total: 0, latest: undefined },
        },
        {
          profileId: 'testnet',
          activationLedgerIndex: 100,
          status: {
            state: 'ready',
            primarySourceTip: 1_002,
            secondarySourceTip: 1_001,
            lastAgreedLedgerIndex: 1_001,
            lastAgreedLedgerHash: 'a'.repeat(64),
            errorCode: null,
            writerPresent: true,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
            updatedAt: NOW,
          },
          checkpoint: {
            ledgerIndex: 1_001,
            ledgerHash: 'a'.repeat(64),
            closeTime: 841_000_000,
            transactionRootPresent: true,
          },
          acceptedRegistrations: 42,
          rejectedRegistrations: 3,
          haltHistory: {
            total: 1,
            latest: {
              writerEpoch: 6,
              errorCode: 'SOURCE_DIVERGENCE',
              primarySourceTip: 999,
              secondarySourceTip: 998,
              lastAgreedLedgerIndex: 997,
              recordedAt: new Date(NOW.getTime() - 60_000),
            },
          },
        },
      ],
    })
    expect(transaction).toHaveBeenCalledOnce()
    expect(transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('fails closed on unsafe counters or partial status evidence', async () => {
    const invalidRows = [
      {
        profileId: 'testnet',
        activationLedgerIndex: '100',
        state: null,
        primarySourceTip: '1',
        secondarySourceTip: null,
        lastAgreedLedgerIndex: null,
        lastAgreedLedgerHash: null,
        errorCode: null,
        writerPresent: false,
        leaseExpiresAt: null,
        statusUpdatedAt: null,
        checkpointLedgerIndex: null,
        checkpointLedgerHash: null,
        checkpointCloseTime: null,
        checkpointTransactionRootPresent: false,
        acceptedRegistrations: '0',
        rejectedRegistrations: '0',
        haltCount: '0',
        latestHaltWriterEpoch: null,
        latestHaltErrorCode: null,
        latestHaltPrimarySourceTip: null,
        latestHaltSecondarySourceTip: null,
        latestHaltLastAgreedLedgerIndex: null,
        latestHaltLastAgreedLedgerHashPresent: false,
        latestHaltRecordedAt: null,
      },
    ]
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          observedAt: NOW,
          usedConnections: '7',
          maxConnections: '100',
          sizeBytes: '1234567',
        },
      ])
      .mockResolvedValueOnce(invalidRows)
    const transaction = vi.fn(async <T>(callback: (database: unknown) => Promise<T>) =>
      callback({ execute }),
    )
    const repository = new PostgresOperationalMetricsRepository({
      transaction,
    } as unknown as XcsDatabase)

    await expect(repository.getSnapshot()).rejects.toMatchObject({
      name: 'OperationalMetricsEvidenceError',
      code: 'METRICS_EVIDENCE_INVALID',
      message: 'Operational status evidence is inconsistent',
    })
  })
})
