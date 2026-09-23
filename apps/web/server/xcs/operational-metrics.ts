import { XcsError } from '@xcs-protocol/core'
import { rippleTimeToUnixTime } from 'xrpl'

import {
  DEFAULT_LEDGER_MAX_AGE_SECONDS,
  evaluateLedgerCheckpointFreshness,
} from './ledger-freshness.js'
import { PayloadInvalidError, PayloadUnavailableError } from './payload-resolver.js'
import type { PayloadResolver } from './types.js'

const CONTINUITY_FAILURE_CODES = new Set([
  'LEDGER_BEFORE_ACTIVATION',
  'LEDGER_GAP',
  'LEDGER_PARENT_MISMATCH',
  'ACTIVATION_HASH_MISMATCH',
])

export type OperationalIndexerState = 'starting' | 'catching_up' | 'ready' | 'halted'

export interface OperationalMetricsProfileSnapshot {
  profileId: string
  status:
    | {
        state: OperationalIndexerState
        primarySourceTip: number | null
        secondarySourceTip: number | null
        lastAgreedLedgerIndex: number | null
        lastAgreedLedgerHash: string | null
        errorCode: string | null
        writerPresent: boolean
        leaseExpiresAt: Date | null
        updatedAt: Date
      }
    | undefined
  checkpoint:
    | {
        ledgerIndex: number
        ledgerHash: string
        closeTime: number
        transactionRootPresent: boolean
      }
    | undefined
  activationLedgerIndex: number
  acceptedRegistrations: number
  rejectedRegistrations: number
  haltHistory: {
    total: number
    latest:
      | {
          writerEpoch: number
          errorCode: string
          primarySourceTip: number | null
          secondarySourceTip: number | null
          lastAgreedLedgerIndex: number | null
          recordedAt: Date
        }
      | undefined
  }
}

export interface OperationalMetricsSnapshot {
  observedAt: Date
  database: {
    usedConnections: number
    maxConnections: number
    sizeBytes: number
  }
  profiles: OperationalMetricsProfileSnapshot[]
}

export interface OperationalMetricsRepository {
  getSnapshot(): Promise<OperationalMetricsSnapshot>
}

export class OperationalMetricsEvidenceError extends Error {
  readonly code = 'METRICS_EVIDENCE_INVALID'

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'OperationalMetricsEvidenceError'
  }
}

export type RateLimitMetric = 'global' | 'verify' | 'pinning'

interface PayloadResolutionCounters {
  retrieved: number
  unavailable: number
  invalid: number
  error: number
}

interface RateLimitCounters {
  global: number
  verify: number
  pinning: number
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} is invalid`)
  return value
}

function ledgerLag(
  status: NonNullable<OperationalMetricsProfileSnapshot['status']>,
): number | null {
  if (
    status.primarySourceTip === null ||
    status.secondarySourceTip === null ||
    status.lastAgreedLedgerIndex === null
  ) {
    return null
  }
  const lag =
    Math.min(status.primarySourceTip, status.secondarySourceTip) - status.lastAgreedLedgerIndex
  return Number.isSafeInteger(lag) && lag >= 0 ? lag : null
}

function isProfileReady(
  profile: OperationalMetricsProfileSnapshot,
  observedAt: Date,
  maxLedgerAgeSeconds: number,
): boolean {
  const status = profile.status
  const checkpoint = profile.checkpoint
  if (
    status === undefined ||
    checkpoint === undefined ||
    status.state !== 'ready' ||
    !status.writerPresent ||
    status.leaseExpiresAt === null ||
    status.leaseExpiresAt.getTime() <= observedAt.getTime() ||
    status.primarySourceTip === null ||
    status.secondarySourceTip === null ||
    status.lastAgreedLedgerIndex === null ||
    status.lastAgreedLedgerHash === null ||
    status.lastAgreedLedgerIndex !== Math.min(status.primarySourceTip, status.secondarySourceTip) ||
    status.lastAgreedLedgerIndex !== checkpoint.ledgerIndex ||
    status.lastAgreedLedgerHash !== checkpoint.ledgerHash ||
    checkpoint.ledgerIndex < profile.activationLedgerIndex ||
    !checkpoint.transactionRootPresent
  ) {
    return false
  }
  return (
    evaluateLedgerCheckpointFreshness(checkpoint.closeTime, observedAt, maxLedgerAgeSeconds) ===
    'fresh'
  )
}

function publicProfile(
  profile: OperationalMetricsProfileSnapshot,
  observedAt: Date,
  maxLedgerAgeSeconds: number,
) {
  const status = profile.status
  const checkpoint = profile.checkpoint
  return {
    profileId: profile.profileId,
    ready: isProfileReady(profile, observedAt, maxLedgerAgeSeconds),
    state: status?.state ?? ('missing' as const),
    errorCode: status?.errorCode ?? null,
    statusUpdatedAt: status?.updatedAt.toISOString() ?? null,
    sourceTips: {
      primary: status?.primarySourceTip ?? null,
      secondary: status?.secondarySourceTip ?? null,
    },
    lastAgreedLedger:
      status?.lastAgreedLedgerIndex === null ||
      status?.lastAgreedLedgerIndex === undefined ||
      status.lastAgreedLedgerHash === null
        ? null
        : {
            index: status.lastAgreedLedgerIndex,
            hash: status.lastAgreedLedgerHash,
          },
    ledgerLag: status === undefined ? null : ledgerLag(status),
    checkpoint:
      checkpoint === undefined
        ? null
        : {
            index: checkpoint.ledgerIndex,
            hash: checkpoint.ledgerHash,
            closeTime: checkpoint.closeTime,
            ageSeconds:
              Math.floor(observedAt.getTime() / 1_000) -
              Math.floor(rippleTimeToUnixTime(checkpoint.closeTime) / 1_000),
          },
    continuityFailure:
      status?.state === 'halted' &&
      status.errorCode !== null &&
      CONTINUITY_FAILURE_CODES.has(status.errorCode)
        ? status.errorCode
        : null,
    registrations: {
      accepted: profile.acceptedRegistrations,
      rejected: profile.rejectedRegistrations,
    },
    haltHistory: {
      total: profile.haltHistory.total,
      latest:
        profile.haltHistory.latest === undefined
          ? null
          : {
              writerEpoch: profile.haltHistory.latest.writerEpoch,
              errorCode: profile.haltHistory.latest.errorCode,
              sourceTips: {
                primary: profile.haltHistory.latest.primarySourceTip,
                secondary: profile.haltHistory.latest.secondarySourceTip,
              },
              lastAgreedLedgerIndex: profile.haltHistory.latest.lastAgreedLedgerIndex,
              recordedAt: profile.haltHistory.latest.recordedAt.toISOString(),
            },
    },
  }
}

export function rateLimitMetric(routeUrl: string | undefined): RateLimitMetric {
  if (routeUrl === '/v1/verify') return 'verify'
  if (routeUrl?.startsWith('/v1/pinning/') === true) return 'pinning'
  return 'global'
}

export class OperationalMetricsCollector {
  private readonly processStartedAt: Date
  private serverPayloadResolutionEnabled = false
  private snapshotFailuresSinceStart = 0
  private readonly payloadResolutions: PayloadResolutionCounters = {
    retrieved: 0,
    unavailable: 0,
    invalid: 0,
    error: 0,
  }
  private readonly rateLimitedResponses: RateLimitCounters = {
    global: 0,
    verify: 0,
    pinning: 0,
  }

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly readinessMaxLedgerAgeSeconds = DEFAULT_LEDGER_MAX_AGE_SECONDS,
  ) {
    if (
      !Number.isInteger(readinessMaxLedgerAgeSeconds) ||
      readinessMaxLedgerAgeSeconds < 0 ||
      readinessMaxLedgerAgeSeconds > 3_600
    ) {
      throw new Error('Metrics readiness max ledger age must be an integer between 0 and 3600')
    }
    this.processStartedAt = new Date(validDate(this.now(), 'Metrics process start').getTime())
  }

  observePayloadResolver(resolver: PayloadResolver): PayloadResolver {
    this.serverPayloadResolutionEnabled = true
    return {
      resolve: async (uri) => {
        try {
          const content = await resolver.resolve(uri)
          this.payloadResolutions.retrieved = increment(this.payloadResolutions.retrieved)
          return content
        } catch (error) {
          if (error instanceof PayloadUnavailableError) {
            this.payloadResolutions.unavailable = increment(this.payloadResolutions.unavailable)
          } else if (error instanceof PayloadInvalidError || error instanceof XcsError) {
            this.payloadResolutions.invalid = increment(this.payloadResolutions.invalid)
          } else {
            this.payloadResolutions.error = increment(this.payloadResolutions.error)
          }
          throw error
        }
      },
    }
  }

  recordRateLimited(metric: RateLimitMetric): void {
    this.rateLimitedResponses[metric] = increment(this.rateLimitedResponses[metric])
  }

  async collect(repository: OperationalMetricsRepository) {
    const processGeneratedAt = validDate(this.now(), 'Metrics generation time').toISOString()
    const api = {
      counterScope: 'process' as const,
      processStartedAt: this.processStartedAt.toISOString(),
      serverPayloadResolutions: {
        enabled: this.serverPayloadResolutionEnabled,
        outcomes: { ...this.payloadResolutions },
      },
      rateLimitedResponses: { ...this.rateLimitedResponses },
    }
    const coverage = {
      continuityFailures: 'active_halt_only' as const,
      haltHistory: 'durable_fenced_halts_only' as const,
      submissionOutcomes: 'not_observed_client_local' as const,
      payloadResolution: 'server_only' as const,
      databasePoolSaturation: 'not_observed' as const,
      diskUsage: 'logical_database_size_only' as const,
    }

    try {
      const snapshot = await repository.getSnapshot()
      let observedAt: Date
      let profiles: ReturnType<typeof publicProfile>[]
      try {
        observedAt = validDate(snapshot.observedAt, 'Metrics database observation time')
        profiles = snapshot.profiles.map((profile) =>
          publicProfile(profile, observedAt, this.readinessMaxLedgerAgeSeconds),
        )
      } catch (cause) {
        throw new OperationalMetricsEvidenceError('Operational metrics evidence is invalid', {
          cause,
        })
      }
      return {
        schemaVersion: 2 as const,
        generatedAt: observedAt.toISOString(),
        clockSource: 'database' as const,
        database: {
          available: true as const,
          errorCode: null,
          observedAt: observedAt.toISOString(),
          snapshotFailuresSinceStart: this.snapshotFailuresSinceStart,
          clusterConnections: {
            used: snapshot.database.usedConnections,
            maximum: snapshot.database.maxConnections,
          },
          logicalSizeBytes: snapshot.database.sizeBytes,
        },
        profiles,
        api,
        coverage,
      }
    } catch (error) {
      this.snapshotFailuresSinceStart = increment(this.snapshotFailuresSinceStart)
      const evidenceInvalid = error instanceof OperationalMetricsEvidenceError
      return {
        schemaVersion: 2 as const,
        generatedAt: processGeneratedAt,
        clockSource: 'process' as const,
        database: {
          available: evidenceInvalid,
          errorCode: evidenceInvalid ? error.code : ('DATABASE_UNAVAILABLE' as const),
          observedAt: null,
          snapshotFailuresSinceStart: this.snapshotFailuresSinceStart,
          clusterConnections: null,
          logicalSizeBytes: null,
        },
        profiles: [],
        api,
        coverage,
      }
    }
  }
}

type OperationalMetricsDocument = Awaited<ReturnType<OperationalMetricsCollector['collect']>>

function prometheusLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

function prometheusSample(
  name: string,
  value: number,
  labels: Record<string, string> = {},
): string {
  const renderedLabels = Object.entries(labels)
    .map(([key, label]) => `${key}="${prometheusLabel(label)}"`)
    .join(',')
  return `${name}${renderedLabels.length === 0 ? '' : `{${renderedLabels}}`} ${String(value)}`
}

export function renderPrometheusMetrics(document: OperationalMetricsDocument): string {
  const lines = [
    '# HELP xcs_database_available Whether the operational PostgreSQL snapshot is available.',
    '# TYPE xcs_database_available gauge',
    prometheusSample('xcs_database_available', document.database.available ? 1 : 0),
    '# HELP xcs_api_metrics_snapshot_failures_total Operational snapshot failures in this API process.',
    '# TYPE xcs_api_metrics_snapshot_failures_total counter',
    prometheusSample(
      'xcs_api_metrics_snapshot_failures_total',
      document.database.snapshotFailuresSinceStart,
    ),
  ]

  if (document.database.clusterConnections !== null) {
    lines.push(
      '# HELP xcs_database_connections_used PostgreSQL client backend connections in use.',
      '# TYPE xcs_database_connections_used gauge',
      prometheusSample('xcs_database_connections_used', document.database.clusterConnections.used),
      '# HELP xcs_database_connections_max PostgreSQL maximum configured connections.',
      '# TYPE xcs_database_connections_max gauge',
      prometheusSample(
        'xcs_database_connections_max',
        document.database.clusterConnections.maximum,
      ),
    )
  }
  if (document.database.logicalSizeBytes !== null) {
    lines.push(
      '# HELP xcs_database_logical_size_bytes Logical size of the XCS PostgreSQL database.',
      '# TYPE xcs_database_logical_size_bytes gauge',
      prometheusSample('xcs_database_logical_size_bytes', document.database.logicalSizeBytes),
    )
  }

  lines.push(
    '# HELP xcs_indexer_ready Whether the profile has fresh, lease-backed authoritative evidence.',
    '# TYPE xcs_indexer_ready gauge',
    '# HELP xcs_indexer_state Current durable indexer state for the profile.',
    '# TYPE xcs_indexer_state gauge',
    '# HELP xcs_indexer_source_tip Last observed source tip by profile and source.',
    '# TYPE xcs_indexer_source_tip gauge',
    '# HELP xcs_indexer_ledger_lag Difference between the effective source tip and last agreed ledger.',
    '# TYPE xcs_indexer_ledger_lag gauge',
    '# HELP xcs_indexer_checkpoint_age_seconds Age of the latest indexed checkpoint.',
    '# TYPE xcs_indexer_checkpoint_age_seconds gauge',
    '# HELP xcs_indexer_halts_total Durable fenced halt incidents recorded for the profile.',
    '# TYPE xcs_indexer_halts_total counter',
    '# HELP xcs_indexer_last_halt_timestamp_seconds Timestamp of the latest durable fenced halt.',
    '# TYPE xcs_indexer_last_halt_timestamp_seconds gauge',
    '# HELP xcs_schema_registrations_total Indexed schema registrations by result.',
    '# TYPE xcs_schema_registrations_total counter',
  )
  for (const profile of document.profiles) {
    const profileLabel = { profile_id: profile.profileId }
    lines.push(
      prometheusSample('xcs_indexer_ready', profile.ready ? 1 : 0, profileLabel),
      prometheusSample('xcs_indexer_state', 1, {
        ...profileLabel,
        state: profile.state,
      }),
      prometheusSample('xcs_indexer_halts_total', profile.haltHistory.total, profileLabel),
      prometheusSample('xcs_schema_registrations_total', profile.registrations.accepted, {
        ...profileLabel,
        result: 'accepted',
      }),
      prometheusSample('xcs_schema_registrations_total', profile.registrations.rejected, {
        ...profileLabel,
        result: 'rejected',
      }),
    )
    if (profile.sourceTips.primary !== null) {
      lines.push(
        prometheusSample('xcs_indexer_source_tip', profile.sourceTips.primary, {
          ...profileLabel,
          source: 'primary',
        }),
      )
    }
    if (profile.sourceTips.secondary !== null) {
      lines.push(
        prometheusSample('xcs_indexer_source_tip', profile.sourceTips.secondary, {
          ...profileLabel,
          source: 'secondary',
        }),
      )
    }
    if (profile.ledgerLag !== null) {
      lines.push(prometheusSample('xcs_indexer_ledger_lag', profile.ledgerLag, profileLabel))
    }
    if (profile.checkpoint !== null) {
      lines.push(
        prometheusSample(
          'xcs_indexer_checkpoint_age_seconds',
          profile.checkpoint.ageSeconds,
          profileLabel,
        ),
      )
    }
    if (profile.haltHistory.latest !== null) {
      lines.push(
        prometheusSample(
          'xcs_indexer_last_halt_timestamp_seconds',
          new Date(profile.haltHistory.latest.recordedAt).getTime() / 1_000,
          { ...profileLabel, error_code: profile.haltHistory.latest.errorCode },
        ),
      )
    }
  }

  lines.push(
    '# HELP xcs_api_rate_limited_responses_total Rate-limited responses in this API process.',
    '# TYPE xcs_api_rate_limited_responses_total counter',
  )
  for (const [scope, value] of Object.entries(document.api.rateLimitedResponses)) {
    lines.push(prometheusSample('xcs_api_rate_limited_responses_total', value, { scope }))
  }
  lines.push('# EOF')
  return `${lines.join('\n')}\n`
}
