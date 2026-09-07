import { XcsError } from '@xcs-protocol/core'
import { describe, expect, it } from 'vitest'

import {
  OperationalMetricsEvidenceError,
  OperationalMetricsCollector,
  rateLimitMetric,
  renderPrometheusMetrics,
  type OperationalMetricsRepository,
} from '../src/operational-metrics.js'
import { PayloadInvalidError, PayloadUnavailableError } from '../src/payload-resolver.js'

const NOW = new Date('2026-08-26T14:30:00.000Z')
const CLOSE_TIME = Math.floor(NOW.getTime() / 1_000) - 946_684_800 - 4

function repository(): OperationalMetricsRepository {
  return {
    async getSnapshot() {
      return {
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
            status: {
              state: 'halted',
              primarySourceTip: 1_004,
              secondarySourceTip: 1_003,
              lastAgreedLedgerIndex: 1_001,
              lastAgreedLedgerHash: 'a'.repeat(64),
              errorCode: 'LEDGER_PARENT_MISMATCH',
              writerPresent: false,
              leaseExpiresAt: null,
              updatedAt: new Date('2026-08-26T14:29:58.000Z'),
            },
            checkpoint: {
              ledgerIndex: 1_001,
              ledgerHash: 'a'.repeat(64),
              closeTime: CLOSE_TIME,
              transactionRootPresent: true,
            },
            activationLedgerIndex: 100,
            acceptedRegistrations: 42,
            rejectedRegistrations: 3,
            haltHistory: {
              total: 2,
              latest: {
                writerEpoch: 7,
                errorCode: 'LEDGER_PARENT_MISMATCH',
                primarySourceTip: 1_004,
                secondarySourceTip: 1_003,
                lastAgreedLedgerIndex: 1_001,
                recordedAt: new Date('2026-08-26T14:29:59.000Z'),
              },
            },
          },
        ],
      }
    },
  }
}

describe('operational metrics', () => {
  it('renders deterministic durable gauges without turning hashes into labels', async () => {
    const collector = new OperationalMetricsCollector(() => NOW)

    await expect(collector.collect(repository())).resolves.toEqual({
      schemaVersion: 2,
      generatedAt: NOW.toISOString(),
      clockSource: 'database',
      database: {
        available: true,
        errorCode: null,
        observedAt: NOW.toISOString(),
        snapshotFailuresSinceStart: 0,
        clusterConnections: { used: 7, maximum: 100 },
        logicalSizeBytes: 1_234_567,
      },
      profiles: [
        {
          profileId: 'missing',
          ready: false,
          state: 'missing',
          errorCode: null,
          statusUpdatedAt: null,
          sourceTips: { primary: null, secondary: null },
          lastAgreedLedger: null,
          ledgerLag: null,
          checkpoint: null,
          continuityFailure: null,
          registrations: { accepted: 0, rejected: 0 },
          haltHistory: { total: 0, latest: null },
        },
        {
          profileId: 'testnet',
          ready: false,
          state: 'halted',
          errorCode: 'LEDGER_PARENT_MISMATCH',
          statusUpdatedAt: '2026-08-26T14:29:58.000Z',
          sourceTips: { primary: 1_004, secondary: 1_003 },
          lastAgreedLedger: { index: 1_001, hash: 'a'.repeat(64) },
          ledgerLag: 2,
          checkpoint: {
            index: 1_001,
            hash: 'a'.repeat(64),
            closeTime: CLOSE_TIME,
            ageSeconds: 4,
          },
          continuityFailure: 'LEDGER_PARENT_MISMATCH',
          registrations: { accepted: 42, rejected: 3 },
          haltHistory: {
            total: 2,
            latest: {
              writerEpoch: 7,
              errorCode: 'LEDGER_PARENT_MISMATCH',
              sourceTips: { primary: 1_004, secondary: 1_003 },
              lastAgreedLedgerIndex: 1_001,
              recordedAt: '2026-08-26T14:29:59.000Z',
            },
          },
        },
      ],
      api: {
        counterScope: 'process',
        processStartedAt: NOW.toISOString(),
        serverPayloadResolutions: {
          enabled: false,
          outcomes: { retrieved: 0, unavailable: 0, invalid: 0, error: 0 },
        },
        rateLimitedResponses: { global: 0, verify: 0, pinning: 0 },
      },
      coverage: {
        continuityFailures: 'active_halt_only',
        haltHistory: 'durable_fenced_halts_only',
        submissionOutcomes: 'not_observed_client_local',
        payloadResolution: 'server_only',
        databasePoolSaturation: 'not_observed',
        diskUsage: 'logical_database_size_only',
      },
    })
  })

  it('reports readiness only for a live lease and a fresh exact checkpoint', async () => {
    const snapshot = await repository().getSnapshot()
    const profile = snapshot.profiles[1]!
    profile.status = {
      state: 'ready',
      primarySourceTip: 1_002,
      secondarySourceTip: 1_001,
      lastAgreedLedgerIndex: 1_001,
      lastAgreedLedgerHash: 'a'.repeat(64),
      errorCode: null,
      writerPresent: true,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    }
    const readyRepository: OperationalMetricsRepository = {
      getSnapshot: async () => snapshot,
    }

    const fresh = await new OperationalMetricsCollector(() => NOW, 4).collect(readyRepository)
    expect(fresh.profiles[1]?.ready).toBe(true)
    expect(renderPrometheusMetrics(fresh)).toContain('xcs_indexer_ready{profile_id="testnet"} 1')

    const stale = await new OperationalMetricsCollector(() => NOW, 3).collect(readyRepository)
    expect(stale.profiles[1]?.ready).toBe(false)
  })

  it('renders token-ready OpenMetrics without hashes or request identifiers', async () => {
    const collector = new OperationalMetricsCollector(() => NOW)
    collector.recordRateLimited('verify')
    const document = await collector.collect(repository())
    const output = renderPrometheusMetrics(document)

    expect(output).toContain('xcs_database_available 1')
    expect(output).toContain('xcs_indexer_ready{profile_id="testnet"} 0')
    expect(output).toContain('xcs_indexer_state{profile_id="testnet",state="halted"} 1')
    expect(output).toContain('xcs_indexer_halts_total{profile_id="testnet"} 2')
    expect(output).toContain('xcs_api_rate_limited_responses_total{scope="verify"} 1')
    expect(output).not.toContain('a'.repeat(64))
    expect(output).not.toContain('issuer')
    expect(output).not.toContain('subject')
    expect(output).not.toContain('uri')
    expect(output.endsWith('# EOF\n')).toBe(true)
  })

  it('keeps process counters available and increments failures when PostgreSQL is unavailable', async () => {
    const collector = new OperationalMetricsCollector(() => NOW)
    collector.recordRateLimited('global')
    const failing: OperationalMetricsRepository = {
      getSnapshot: async () => {
        throw new Error('sensitive database detail')
      },
    }

    const first = await collector.collect(failing)
    const second = await collector.collect(failing)

    expect(first).toMatchObject({
      database: {
        available: false,
        errorCode: 'DATABASE_UNAVAILABLE',
        observedAt: null,
        snapshotFailuresSinceStart: 1,
        clusterConnections: null,
        logicalSizeBytes: null,
      },
      profiles: [],
      api: { rateLimitedResponses: { global: 1, verify: 0, pinning: 0 } },
    })
    expect(second.database.snapshotFailuresSinceStart).toBe(2)
    expect(JSON.stringify(second)).not.toContain('sensitive database detail')
  })

  it('distinguishes invalid projection evidence from database unavailability', async () => {
    const collector = new OperationalMetricsCollector(() => NOW)
    const result = await collector.collect({
      getSnapshot: async () => {
        throw new OperationalMetricsEvidenceError('partial status row')
      },
    })

    expect(result.database).toMatchObject({
      available: true,
      errorCode: 'METRICS_EVIDENCE_INVALID',
      observedAt: null,
      snapshotFailuresSinceStart: 1,
    })
    expect(JSON.stringify(result)).not.toContain('partial status row')
  })

  it('uses database time for a durable snapshot and process time only during database failure', async () => {
    const processNow = new Date(NOW.getTime() + 5_000)
    const collector = new OperationalMetricsCollector(() => processNow)

    const available = await collector.collect(repository())
    const unavailable = await collector.collect({
      getSnapshot: async () => Promise.reject(new Error('offline')),
    })

    expect(available.clockSource).toBe('database')
    expect(available.generatedAt).toBe(NOW.toISOString())
    expect(available.api.processStartedAt).toBe(processNow.toISOString())
    expect(unavailable.clockSource).toBe('process')
    expect(unavailable.generatedAt).toBe(processNow.toISOString())
  })

  it('classifies resolver outcomes without retaining payload identifiers', async () => {
    const collector = new OperationalMetricsCollector(() => NOW)
    const outcomes = [
      new Uint8Array([1]),
      new PayloadUnavailableError('unavailable'),
      new PayloadInvalidError('invalid'),
      new XcsError('INVALID_PAYLOAD_URI', 'invalid URI'),
      new Error('unexpected'),
    ]
    const resolver = collector.observePayloadResolver({
      resolve: async () => {
        const outcome = outcomes.shift()
        if (outcome instanceof Error) throw outcome
        return outcome!
      },
    })

    await expect(resolver.resolve('https://one.example')).resolves.toEqual(new Uint8Array([1]))
    await expect(resolver.resolve('https://two.example')).rejects.toBeInstanceOf(
      PayloadUnavailableError,
    )
    await expect(resolver.resolve('https://three.example')).rejects.toBeInstanceOf(
      PayloadInvalidError,
    )
    await expect(resolver.resolve('https://four.example')).rejects.toBeInstanceOf(XcsError)
    await expect(resolver.resolve('https://five.example')).rejects.toThrow('unexpected')

    const result = await collector.collect(repository())
    expect(result.api.serverPayloadResolutions).toEqual({
      enabled: true,
      outcomes: {
        retrieved: 1,
        unavailable: 1,
        invalid: 2,
        error: 1,
      },
    })
    expect(JSON.stringify(result)).not.toContain('example')
  })

  it('classifies rate-limit routes without using request identities', () => {
    expect(rateLimitMetric('/v1/verify')).toBe('verify')
    expect(rateLimitMetric('/v1/pinning/pins')).toBe('pinning')
    expect(rateLimitMetric('/v1/networks')).toBe('global')
    expect(rateLimitMetric(undefined)).toBe('global')
  })
})
