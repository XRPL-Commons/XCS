import { computeSchemaUid, parseSchema } from '@xcs-protocol/core'
import type {
  CredentialEventRow,
  CredentialGenerationRow,
  IndexerStatusRow,
  LedgerCheckpointRow,
  NetworkProfileRow,
  SchemaEventRow,
  SchemaRow,
} from '@xcs-protocol/db'
import { afterEach, describe, expect, it } from 'vitest'

import { createApi } from '../src/app.js'
import type { OperationalMetricsRepository } from '../src/operational-metrics.js'
import { MAX_SCHEMA_CATALOG_ENTRIES, type SchemaCatalogBundle } from '../src/schema-catalog.js'
import { canonicalJson, encodeUtf8, sha256Hex } from '../src/serialization.js'
import type { ApiRepository, SchemaProjectionEvidence } from '../src/types.js'
import { StaticTrustPolicy } from '../src/verification.js'

const UID = 'a'.repeat(64)
const TX_HASH = 'ab'.repeat(32)
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const NOW = new Date('2026-08-19T00:00:00.000Z')
const NOW_RIPPLE = Math.floor(NOW.getTime() / 1_000) - 946_684_800
const METRICS_TOKEN = 'test-operational-metrics-token-00000001'

const network: NetworkProfileRow = {
  profileId: 'testnet',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'b'.repeat(64),
  registryAddress: ISSUER,
  registrationAmountDrops: 1,
  activationLedgerIndex: 100,
  activationLedgerHash: 'c'.repeat(64),
  enabled: true,
  createdAt: NOW,
}
const checkpoint: LedgerCheckpointRow = {
  profileId: 'testnet',
  ledgerIndex: 100,
  ledgerHash: 'c'.repeat(64),
  parentHash: 'd'.repeat(64),
  closeTime: NOW_RIPPLE - 10,
  transactionCount: 0,
  transactionRoot: '1'.repeat(64),
  processedAt: NOW,
}
const readyStatus: IndexerStatusRow = {
  profileId: 'testnet',
  state: 'ready',
  primarySourceTip: 100,
  secondarySourceTip: 100,
  lastAgreedLedgerIndex: 100,
  lastAgreedLedgerHash: checkpoint.ledgerHash,
  errorCode: null,
  writerId: 'writer-1',
  writerEpoch: 1,
  leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  updatedAt: NOW,
}
const generation: CredentialGenerationRow = {
  profileId: 'testnet',
  generationId: 'e'.repeat(64),
  ledgerObjectId: 'f'.repeat(64),
  issuer: ISSUER,
  subject: SUBJECT,
  schemaUid: UID,
  uriHex: null,
  expiration: null,
  accepted: true,
  createdLedgerIndex: checkpoint.ledgerIndex,
  createdTransactionIndex: 0,
  lastLedgerIndex: checkpoint.ledgerIndex,
  deletedLedgerIndex: null,
  deletionCause: null,
  createdAt: NOW,
  updatedAt: NOW,
}
const credentialEvent: CredentialEventRow = {
  profileId: 'testnet',
  transactionHash: TX_HASH,
  nodeIndex: 0,
  generationId: generation.generationId,
  ledgerObjectId: generation.ledgerObjectId,
  ledgerIndex: checkpoint.ledgerIndex,
  ledgerHash: checkpoint.ledgerHash,
  transactionIndex: 1,
  eventType: 'accepted',
  issuer: ISSUER,
  subject: SUBJECT,
  schemaUid: UID,
  uriHex: null,
  expiration: null,
  accepted: true,
  deletionCause: null,
  snapshot: {},
  recordedAt: NOW,
}
const registeredSchema = {
  xcsVersion: '0.1' as const,
  name: 'Course completion',
  description: 'Completed a course.',
  fields: { programId: { type: 'string' as const } },
}
const registeredSchemaUid = computeSchemaUid({
  schema: registeredSchema,
  networkId: network.networkId,
  ledgerHash: checkpoint.ledgerHash,
  ledgerIndex: checkpoint.ledgerIndex,
  transactionIndex: 2,
  publisher: ISSUER,
})
const acceptedSchemaRegistration: SchemaEventRow = {
  profileId: 'testnet',
  transactionHash: TX_HASH,
  ledgerIndex: checkpoint.ledgerIndex,
  ledgerHash: checkpoint.ledgerHash,
  transactionIndex: 2,
  publisher: ISSUER,
  status: 'accepted',
  reasonCode: null,
  schemaUid: registeredSchemaUid,
  memoJson: registeredSchema,
  recordedAt: NOW,
}
const registeredSchemaRow: SchemaRow = {
  profileId: 'testnet',
  schemaUid: registeredSchemaUid,
  publisher: ISSUER,
  name: registeredSchema.name,
  description: registeredSchema.description,
  parentUid: null,
  supersedesUid: null,
  definition: registeredSchema,
  resolvedDefinition: {
    definition: registeredSchema,
    fields: registeredSchema.fields,
    lineage: [],
  },
  registrationTransactionHash: acceptedSchemaRegistration.transactionHash,
  ledgerIndex: acceptedSchemaRegistration.ledgerIndex,
  transactionIndex: acceptedSchemaRegistration.transactionIndex,
  registeredAt: NOW,
}
const registeredSchemaEvidence: SchemaProjectionEvidence = {
  schema: registeredSchemaRow,
  registration: acceptedSchemaRegistration,
}

function schemaCatalogFixture() {
  const parentDefinition = {
    xcsVersion: '0.1' as const,
    name: 'Course base',
    description: 'Base course evidence.',
    fields: { courseId: { type: 'string' as const } },
  }
  const parentUid = computeSchemaUid({
    schema: parentDefinition,
    networkId: network.networkId,
    ledgerHash: checkpoint.ledgerHash,
    ledgerIndex: checkpoint.ledgerIndex,
    transactionIndex: 0,
    publisher: ISSUER,
  })
  const supersededDefinition = {
    xcsVersion: '0.1' as const,
    name: 'Legacy completion',
    description: 'Legacy completion evidence.',
    fields: { legacyId: { type: 'string' as const } },
  }
  const supersededUid = computeSchemaUid({
    schema: supersededDefinition,
    networkId: network.networkId,
    ledgerHash: checkpoint.ledgerHash,
    ledgerIndex: checkpoint.ledgerIndex,
    transactionIndex: 1,
    publisher: ISSUER,
  })
  const targetDefinition = {
    xcsVersion: '0.1' as const,
    name: 'Course completion v2',
    description: 'Current completion evidence.',
    extends: parentUid,
    supersedes: supersededUid,
    fields: { grade: { type: 'uint' as const } },
  }
  const targetUid = computeSchemaUid({
    schema: targetDefinition,
    networkId: network.networkId,
    ledgerHash: checkpoint.ledgerHash,
    ledgerIndex: checkpoint.ledgerIndex,
    transactionIndex: 2,
    publisher: ISSUER,
  })

  const evidence = [
    {
      uid: parentUid,
      definition: parentDefinition,
      transactionIndex: 0,
      transactionHash: '10'.repeat(32),
      fields: parentDefinition.fields,
      lineage: [],
    },
    {
      uid: supersededUid,
      definition: supersededDefinition,
      transactionIndex: 1,
      transactionHash: '20'.repeat(32),
      fields: supersededDefinition.fields,
      lineage: [],
    },
    {
      uid: targetUid,
      definition: targetDefinition,
      transactionIndex: 2,
      transactionHash: '30'.repeat(32),
      fields: { ...parentDefinition.fields, ...targetDefinition.fields },
      lineage: [parentUid],
    },
  ].map(({ uid, definition, transactionIndex, transactionHash, fields, lineage }) => {
    const normalizedDefinition = parseSchema(definition)
    const registration: SchemaEventRow = {
      profileId: network.profileId,
      transactionHash,
      ledgerIndex: checkpoint.ledgerIndex,
      ledgerHash: checkpoint.ledgerHash,
      transactionIndex,
      publisher: ISSUER,
      status: 'accepted',
      reasonCode: null,
      schemaUid: uid,
      memoJson: normalizedDefinition,
      recordedAt: NOW,
    }
    const schema: SchemaRow = {
      profileId: network.profileId,
      schemaUid: uid,
      publisher: ISSUER,
      name: normalizedDefinition.name,
      description: normalizedDefinition.description,
      parentUid: normalizedDefinition.extends ?? null,
      supersedesUid: normalizedDefinition.supersedes ?? null,
      definition: { ...normalizedDefinition },
      resolvedDefinition: { definition: { ...normalizedDefinition }, fields, lineage },
      registrationTransactionHash: transactionHash,
      ledgerIndex: checkpoint.ledgerIndex,
      transactionIndex,
      registeredAt: NOW,
    }
    return { schema, registration }
  })
  return { parentUid, supersededUid, targetUid, target: evidence[2]!.schema, evidence }
}
function publicSchemaSearchFixture() {
  return {
    schemaUid: registeredSchemaRow.schemaUid,
    publisher: registeredSchemaRow.publisher,
    name: registeredSchemaRow.name,
    description: registeredSchemaRow.description,
    parentUid: registeredSchemaRow.parentUid,
    supersedesUid: registeredSchemaRow.supersedesUid,
    registrationTransactionHash: registeredSchemaRow.registrationTransactionHash,
    ledgerIndex: registeredSchemaRow.ledgerIndex,
    transactionIndex: registeredSchemaRow.transactionIndex,
  }
}
const credentialUrl = `/v1/networks/testnet/credentials/${ISSUER}/${SUBJECT}/${UID}`
const credentialEventsUrl = `${credentialUrl}/events`
const exactCredentialEventUrl = `${credentialEventsUrl}/${TX_HASH.toUpperCase()}`
const schemaRegistrationUrl = `/v1/networks/testnet/schema-registrations/${TX_HASH.toUpperCase()}`
const schemaUrl = `/v1/networks/testnet/schemas/${UID}`

class RouteRepository implements ApiRepository {
  async withConsistentSnapshot<T>(callback: (repository: ApiRepository) => Promise<T>): Promise<T> {
    return callback(this)
  }
  async getDatabaseTime() {
    return NOW
  }
  async ping() {}
  async listNetworks() {
    return [network]
  }
  async getNetwork(profileId: string) {
    return profileId === 'testnet' ? network : undefined
  }
  async getIndexerStatus(): Promise<IndexerStatusRow | undefined> {
    return readyStatus
  }
  async getLatestCheckpoint(): Promise<LedgerCheckpointRow | undefined> {
    return checkpoint
  }
  async getSchema(_profileId: string, _schemaUid: string): Promise<SchemaRow | undefined> {
    return undefined
  }
  async getSchemaProjectionEvidence(): Promise<SchemaProjectionEvidence[]> {
    return []
  }
  async getSchemaCatalogEvidence(): Promise<SchemaProjectionEvidence[]> {
    return []
  }
  async getSchemaRegistrationByTransaction(
    _input: Parameters<ApiRepository['getSchemaRegistrationByTransaction']>[0],
  ): Promise<SchemaEventRow | undefined> {
    return undefined
  }
  async listSchemas(): Promise<SchemaRow[]> {
    return []
  }
  async searchSchemas(_input: Parameters<ApiRepository['searchSchemas']>[0]): Promise<SchemaRow[]> {
    return []
  }
  async listSchemaRegistrations(
    _input: Parameters<ApiRepository['listSchemaRegistrations']>[0],
  ): Promise<SchemaEventRow[]> {
    return []
  }
  async getDiscoveryStats(
    _input: Parameters<ApiRepository['getDiscoveryStats']>[0],
  ): Promise<Awaited<ReturnType<ApiRepository['getDiscoveryStats']>>> {
    return {
      schemas: {
        total: 0,
        publishers: 0,
        minimumLedgerIndex: null,
        maximumLedgerIndex: null,
      },
      credentialGenerations: {
        total: 0,
        pending: 0,
        active: 0,
        expired: 0,
        deleted: 0,
        invalidEvidence: 0,
        minimumCreatedLedgerIndex: null,
        maximumLastLedgerIndex: null,
      },
    }
  }
  async getCredential(): Promise<CredentialGenerationRow | undefined> {
    return undefined
  }
  async getCredentialGenerationById(
    _input: Parameters<ApiRepository['getCredentialGenerationById']>[0],
  ): Promise<CredentialGenerationRow | undefined> {
    return undefined
  }
  async getCredentialEvents(
    _input: Parameters<ApiRepository['getCredentialEvents']>[0],
  ): Promise<CredentialEventRow[]> {
    return []
  }
  async getCredentialEventsByTransaction(
    _input: Parameters<ApiRepository['getCredentialEventsByTransaction']>[0],
  ): Promise<CredentialEventRow[]> {
    return []
  }
  async getCredentialEventsByGeneration(
    _input: Parameters<ApiRepository['getCredentialEventsByGeneration']>[0],
  ): Promise<CredentialEventRow[]> {
    return []
  }
  async getTransactionProjectionSummary(
    _input: Parameters<ApiRepository['getTransactionProjectionSummary']>[0],
  ): Promise<Awaited<ReturnType<ApiRepository['getTransactionProjectionSummary']>>> {
    return {
      registration: undefined,
      firstCredentialEvent: undefined,
      credentialEventCount: 0,
    }
  }
  async getCredentialEventsByTransactionPage(
    _input: Parameters<ApiRepository['getCredentialEventsByTransactionPage']>[0],
  ): Promise<CredentialEventRow[]> {
    return []
  }
}

const apps: Awaited<ReturnType<typeof createApi>>[] = []
async function app() {
  const instance = await createApi({
    repository: new RouteRepository(),
    resolver: { resolve: async () => new Uint8Array() },
    trustPolicy: new StaticTrustPolicy(),
    now: () => NOW,
  })
  apps.push(instance)
  return instance
}

async function configuredApp(overrides: Partial<Parameters<typeof createApi>[0]>) {
  const instance = await createApi({
    repository: new RouteRepository(),
    resolver: { resolve: async () => new Uint8Array() },
    trustPolicy: new StaticTrustPolicy(),
    now: () => NOW,
    ...overrides,
  })
  apps.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()))
})

describe('read API', () => {
  it('exposes liveness and indexer readiness separately', async () => {
    const instance = await app()
    const liveness = await instance.inject({ method: 'GET', url: '/health/live' })
    const readiness = await instance.inject({ method: 'GET', url: '/health/ready' })
    expect(liveness.statusCode).toBe(200)
    expect(readiness.statusCode).toBe(200)
    expect(liveness.headers['cache-control']).toBe('no-store')
    expect(readiness.headers['cache-control']).toBe('no-store')
  })

  it('keeps deployment probes available outside the global request budget', async () => {
    const instance = await configuredApp({ globalRateLimit: 1 })

    for (const url of ['/health/live', '/health', '/health/ready']) {
      const first = await instance.inject({ method: 'GET', url })
      const second = await instance.inject({ method: 'GET', url })
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(first.headers['cache-control']).toBe('no-store')
      expect(second.headers['cache-control']).toBe('no-store')
    }

    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(200)
    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(429)
    expect((await instance.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
  })

  it('keeps operational metrics absent unless explicitly configured', async () => {
    const instance = await app()
    for (const url of ['/internal/metrics', '/internal/metrics/prometheus']) {
      const response = await instance.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(404)
    }
    expect(instance.swagger().paths).not.toHaveProperty('/internal/metrics')
    expect(instance.swagger().paths).not.toHaveProperty('/internal/metrics/prometheus')
  })

  it('protects operational metrics, keeps them outside quotas, and hides them from OpenAPI', async () => {
    let snapshotCalls = 0
    const metricsRepository: OperationalMetricsRepository = {
      getSnapshot: async () => {
        snapshotCalls += 1
        return {
          observedAt: NOW,
          database: { usedConnections: 3, maxConnections: 100, sizeBytes: 9_999 },
          profiles: [],
        }
      },
    }
    const instance = await configuredApp({
      globalRateLimit: 1,
      operationalMetrics: { token: METRICS_TOKEN, repository: metricsRepository },
    })

    for (const authorization of [
      undefined,
      'Basic ignored',
      'Bearer wrong-operational-metrics-token-0001',
      `Bearer ${'é'.repeat(METRICS_TOKEN.length)}`,
    ]) {
      const response = await instance.inject({
        method: 'GET',
        url: '/internal/metrics',
        ...(authorization === undefined ? {} : { headers: { authorization } }),
      })
      expect(response.statusCode).toBe(401)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['www-authenticate']).toBe('Bearer realm="xcs-metrics"')
      expect(response.json()).toEqual({
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
      })
    }
    expect(snapshotCalls).toBe(0)

    const headers = { authorization: `Bearer ${METRICS_TOKEN}` }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await instance.inject({ method: 'GET', url: '/internal/metrics', headers })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.json()).toMatchObject({
        schemaVersion: 2,
        clockSource: 'database',
        database: {
          available: true,
          clusterConnections: { used: 3, maximum: 100 },
          logicalSizeBytes: 9_999,
        },
        api: { counterScope: 'process' },
      })
    }
    expect(snapshotCalls).toBe(2)
    expect(instance.swagger().paths).not.toHaveProperty('/internal/metrics')

    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(200)
    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(429)
    const afterLimit = await instance.inject({ method: 'GET', url: '/internal/metrics', headers })
    expect(afterLimit.statusCode).toBe(200)
    expect(afterLimit.json().api.rateLimitedResponses).toEqual({
      global: 1,
      verify: 0,
      pinning: 0,
    })
  })

  it('serves OpenMetrics behind the metrics token without entering public quotas', async () => {
    let snapshotCalls = 0
    const metricsRepository: OperationalMetricsRepository = {
      getSnapshot: async () => {
        snapshotCalls += 1
        return {
          observedAt: NOW,
          database: { usedConnections: 3, maxConnections: 100, sizeBytes: 9_999 },
          profiles: [],
        }
      },
    }
    const instance = await configuredApp({
      globalRateLimit: 1,
      operationalMetrics: { token: METRICS_TOKEN, repository: metricsRepository },
    })

    const unauthorized = await instance.inject({
      method: 'GET',
      url: '/internal/metrics/prometheus',
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(snapshotCalls).toBe(0)

    const headers = { authorization: `Bearer ${METRICS_TOKEN}` }
    const response = await instance.inject({
      method: 'GET',
      url: '/internal/metrics/prometheus',
      headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-type']).toContain(
      'application/openmetrics-text; version=1.0.0',
    )
    expect(response.body).toContain('xcs_database_available 1')
    expect(response.body.endsWith('# EOF\n')).toBe(true)
    expect(snapshotCalls).toBe(1)
    expect(instance.swagger().paths).not.toHaveProperty('/internal/metrics/prometheus')

    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(200)
    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(429)
    expect(
      (
        await instance.inject({
          method: 'GET',
          url: '/internal/metrics/prometheus',
          headers,
        })
      ).statusCode,
    ).toBe(200)
  })

  it('returns process metrics without leaking database errors when the snapshot fails', async () => {
    const metricsRepository: OperationalMetricsRepository = {
      getSnapshot: async () => {
        throw new Error('postgresql://secret@internal-host/xcs')
      },
    }
    const instance = await configuredApp({
      operationalMetrics: { token: METRICS_TOKEN, repository: metricsRepository },
    })
    const response = await instance.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      clockSource: 'process',
      database: {
        available: false,
        errorCode: 'DATABASE_UNAVAILABLE',
        snapshotFailuresSinceStart: 1,
        clusterConnections: null,
        logicalSizeBytes: null,
      },
      profiles: [],
    })
    expect(response.body).not.toContain('secret')
    expect(response.body).not.toContain('internal-host')
  })

  it('rejects weak or reused operational metrics tokens at construction', async () => {
    await expect(
      configuredApp({
        operationalMetrics: {
          token: 'too-short',
          repository: { getSnapshot: async () => Promise.reject(new Error('not called')) },
        },
      }),
    ).rejects.toThrow('operationalMetrics.token must be 32 to 256')
    await expect(
      configuredApp({
        internalSsrToken: METRICS_TOKEN,
        operationalMetrics: {
          token: METRICS_TOKEN,
          repository: { getSnapshot: async () => Promise.reject(new Error('not called')) },
        },
      }),
    ).rejects.toThrow('must be distinct')
  })

  it.each([
    ['missing', undefined, 'indexer_status_unavailable'],
    ['starting', { ...readyStatus, state: 'starting' as const }, 'indexer_not_ready'],
    ['catching up', { ...readyStatus, state: 'catching_up' as const }, 'indexer_not_ready'],
    [
      'halted',
      { ...readyStatus, state: 'halted' as const, errorCode: 'LEDGER_SOURCE_DIVERGENCE' },
      'indexer_halted',
    ],
  ])('fails readiness when durable status is %s', async (_label, status, reason) => {
    const repository = new RouteRepository()
    repository.getIndexerStatus = async () => status
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({ status: 'not_ready', reason })
  })

  it('exposes a public DTO for durable indexer status and documents it in OpenAPI', async () => {
    const instance = await app()
    const response = await instance.inject({ method: 'GET', url: '/v1/networks/testnet/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      profileId: 'testnet',
      state: 'ready',
      sourceTips: { primary: 100, secondary: 100 },
      lastAgreedLedger: { index: 100, hash: checkpoint.ledgerHash },
      errorCode: null,
      updatedAt: NOW.toISOString(),
    })

    const operation = instance.swagger().paths?.['/v1/networks/{network}/status']?.get
    expect(operation?.responses).toHaveProperty('200')
    expect(operation?.responses).toHaveProperty('404')
    expect(JSON.stringify(instance.swagger())).not.toContain('"type":["integer","null"]')
    expect(response.json()).not.toHaveProperty('writerId')
    expect(response.json()).not.toHaveProperty('writerEpoch')

    const paths = instance.swagger().paths
    expect(paths?.['/v1/networks/{network}/schemas/{uid}']?.get?.responses).toHaveProperty('503')
    expect(paths?.['/v1/networks/{network}/schemas']?.get?.responses).toHaveProperty('503')
    expect(
      paths?.['/v1/networks/{network}/credentials/{issuer}/{subject}/{schemaUid}/events']?.get
        ?.responses,
    ).toHaveProperty('503')
    expect(paths?.['/v1/verify']?.post?.responses).toHaveProperty('503')
    expect(paths?.['/v1/verify']?.post?.responses).toHaveProperty('404')
  })

  it('exposes profile-bound signing readiness from one authoritative snapshot', async () => {
    const repository = new RouteRepository()
    let snapshotCount = 0
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCount += 1
      return callback(repository)
    }
    const instance = await configuredApp({ repository })

    const response = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/readiness',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      profileId: 'testnet',
      status: 'ready',
      checkpoint: {
        ledgerIndex: checkpoint.ledgerIndex,
        ledgerHash: checkpoint.ledgerHash,
        closeTime: checkpoint.closeTime,
        transactionRoot: checkpoint.transactionRoot,
      },
    })
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(snapshotCount).toBe(1)

    const operation = instance.swagger().paths?.['/v1/networks/{network}/readiness']?.get
    expect(operation?.responses).toHaveProperty('200')
    expect(operation?.responses).toHaveProperty('400')
    expect(operation?.responses).toHaveProperty('404')
    expect(operation?.responses).toHaveProperty('429')
    expect(operation?.responses).toHaveProperty('503')
    expect(operation?.responses).toHaveProperty('500')

    const missing = await instance.inject({
      method: 'GET',
      url: '/v1/networks/unknown/readiness',
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBe('private, no-store')
    expect(missing.json()).toEqual({ error: 'NETWORK_NOT_FOUND', message: 'Network not found' })
  })

  it('keeps every profile-readiness outcome non-cacheable', async () => {
    const unavailableRepository = new RouteRepository()
    unavailableRepository.getIndexerStatus = async () => undefined
    const unavailableInstance = await configuredApp({ repository: unavailableRepository })
    const unavailable = await unavailableInstance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/readiness',
    })
    expect(unavailable.statusCode).toBe(503)
    expect(unavailable.headers['cache-control']).toBe('private, no-store')

    const invalid = await unavailableInstance.inject({
      method: 'GET',
      url: '/v1/networks/invalid!/readiness',
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.headers['cache-control']).toBe('private, no-store')

    const failingRepository = new RouteRepository()
    failingRepository.withConsistentSnapshot = async () => {
      throw new Error('synthetic database failure')
    }
    const failingInstance = await configuredApp({ repository: failingRepository })
    const failed = await failingInstance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/readiness',
    })
    expect(failed.statusCode).toBe(500)
    expect(failed.headers['cache-control']).toBe('private, no-store')

    const limitedInstance = await configuredApp({ globalRateLimit: 1 })
    expect(
      (
        await limitedInstance.inject({
          method: 'GET',
          url: '/v1/networks/testnet/readiness',
        })
      ).statusCode,
    ).toBe(200)
    const limited = await limitedInstance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/readiness',
    })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['cache-control']).toBe('private, no-store')
    expect(limited.json()).toMatchObject({ statusCode: 429 })
  })

  it.each([
    ['missing status', undefined, 'INDEXER_STATUS_UNAVAILABLE'],
    ['starting', { ...readyStatus, state: 'starting' as const }, 'INDEXER_NOT_READY'],
    ['catching up', { ...readyStatus, state: 'catching_up' as const }, 'INDEXER_NOT_READY'],
    [
      'halted',
      { ...readyStatus, state: 'halted' as const, errorCode: 'LEDGER_SOURCE_DIVERGENCE' },
      'INDEXER_HALTED',
    ],
    ['expired lease', { ...readyStatus, leaseExpiresAt: NOW }, 'INDEXER_LEASE_EXPIRED'],
  ])(
    'fails profile-bound readiness when the indexer status is %s',
    async (_label, status, code) => {
      const repository = new RouteRepository()
      repository.getIndexerStatus = async () => status
      const instance = await configuredApp({ repository })

      const response = await instance.inject({
        method: 'GET',
        url: '/v1/networks/testnet/readiness',
      })
      expect(response.statusCode).toBe(503)
      expect(response.headers['cache-control']).toBe('private, no-store')
      expect(response.json()).toMatchObject({ error: code })
    },
  )

  it.each([
    ['missing checkpoint', undefined, 'INDEXER_NOT_INITIALIZED'],
    ['stale checkpoint', { ...checkpoint, closeTime: NOW_RIPPLE - 121 }, 'INDEXER_STALE'],
    [
      'checkpoint hash mismatch',
      { ...checkpoint, ledgerHash: '9'.repeat(64) },
      'INDEXER_EVIDENCE_INVALID',
    ],
  ])('fails profile-bound readiness for %s', async (_label, storedCheckpoint, code) => {
    const repository = new RouteRepository()
    repository.getLatestCheckpoint = async () => storedCheckpoint
    const instance = await configuredApp({ repository })

    const response = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/readiness',
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: code })
  })

  it('documents closed success contracts for the developer verification flow', async () => {
    const repository = new RouteRepository()
    const nestedDefinition = parseSchema({
      ...registeredSchema,
      fields: {
        programId: { type: 'string' },
        result: {
          type: 'object',
          fields: {
            score: { type: 'uint' },
            badges: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    })
    const nestedSchemaUid = computeSchemaUid({
      schema: nestedDefinition,
      networkId: network.networkId,
      ledgerHash: checkpoint.ledgerHash,
      ledgerIndex: checkpoint.ledgerIndex,
      transactionIndex: acceptedSchemaRegistration.transactionIndex,
      publisher: ISSUER,
    })
    const nestedSchemaRow: SchemaRow = {
      ...registeredSchemaRow,
      schemaUid: nestedSchemaUid,
      definition: { ...nestedDefinition },
      resolvedDefinition: {
        definition: { ...nestedDefinition },
        fields: nestedDefinition.fields,
        lineage: [],
      },
    }
    const nestedSchemaEvidence: SchemaProjectionEvidence = {
      schema: nestedSchemaRow,
      registration: {
        ...acceptedSchemaRegistration,
        schemaUid: nestedSchemaUid,
        memoJson: { ...nestedDefinition },
      },
    }
    const matchingGeneration = { ...generation, schemaUid: nestedSchemaUid }
    repository.getSchema = async () => nestedSchemaRow
    repository.listSchemas = async () => [nestedSchemaRow]
    repository.getSchemaProjectionEvidence = async () => [nestedSchemaEvidence]
    repository.getCredential = async () => matchingGeneration
    const instance = await configuredApp({ repository })
    const matchingCredentialUrl = `/v1/networks/testnet/credentials/${ISSUER}/${SUBJECT}/${nestedSchemaUid}`

    const [exactSchema, schemaList, exactCredential, verification] = await Promise.all([
      instance.inject({
        method: 'GET',
        url: `/v1/networks/testnet/schemas/${nestedSchemaUid}`,
      }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/schemas' }),
      instance.inject({ method: 'GET', url: matchingCredentialUrl }),
      instance.inject({
        method: 'POST',
        url: '/v1/verify',
        payload: {
          network: 'testnet',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: nestedSchemaUid,
        },
      }),
    ])

    expect(exactSchema.statusCode).toBe(200)
    expect(exactSchema.json()).toEqual({
      ...nestedSchemaRow,
      registeredAt: NOW.toISOString(),
    })
    expect(schemaList.statusCode).toBe(200)
    expect(schemaList.json()).toEqual({
      items: [{ ...nestedSchemaRow, registeredAt: NOW.toISOString() }],
    })
    expect(exactCredential.statusCode).toBe(200)
    expect(exactCredential.json()).toEqual({
      ...matchingGeneration,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      state: 'active',
    })
    expect(verification.statusCode).toBe(200)
    expect(verification.json()).toEqual({
      onChain: 'active',
      schema: 'valid',
      payload: 'not_checked',
      issuerTrust: 'unknown',
      generationId: matchingGeneration.generationId,
    })

    type ContractSchema = {
      type?: string
      additionalProperties?: boolean
      required?: string[]
      properties?: Record<string, unknown>
      oneOf?: ContractSchema[]
    }
    type ContractResponse = {
      content?: Record<string, { schema?: ContractSchema }>
    }
    type ContractOperation = { responses?: Record<string, ContractResponse> }
    const document = instance.swagger() as unknown as {
      paths?: Record<string, { get?: ContractOperation; post?: ContractOperation }>
      components?: { schemas?: Record<string, ContractSchema> }
    }
    const responseSchema = (path: string, method: 'get' | 'post') =>
      document.paths?.[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema

    const exactSchemaContract = responseSchema('/v1/networks/{network}/schemas/{uid}', 'get')
    const schemaListContract = responseSchema('/v1/networks/{network}/schemas', 'get')
    const exactCredentialContract = responseSchema(
      '/v1/networks/{network}/credentials/{issuer}/{subject}/{schemaUid}',
      'get',
    )
    const verificationContract = responseSchema('/v1/verify', 'post')

    expect(exactSchemaContract).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining([
        'profileId',
        'schemaUid',
        'definition',
        'resolvedDefinition',
        'registeredAt',
      ]),
    })
    expect(schemaListContract).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['items'],
    })
    expect(
      (schemaListContract?.properties?.items as { items?: ContractSchema } | undefined)?.items,
    ).toMatchObject({ type: 'object', additionalProperties: false })
    expect(exactCredentialContract).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['generationId', 'createdAt', 'updatedAt', 'state']),
    })
    expect(verificationContract).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['onChain', 'schema', 'payload', 'issuerTrust'],
    })
    expect(verificationContract?.properties).toHaveProperty('generationId')
    const fieldDescriptorContract = Object.values(document.components?.schemas ?? {}).find(
      (schema) => schema.oneOf?.length === 3,
    )
    expect(fieldDescriptorContract?.oneOf).toHaveLength(3)
    for (const descriptor of fieldDescriptorContract?.oneOf ?? []) {
      expect(descriptor).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('returns mutually exclusive discovery statistics at the authoritative checkpoint', async () => {
    const repository = new RouteRepository()
    let observedCloseTime: number | undefined
    repository.getDiscoveryStats = async (input) => {
      observedCloseTime = input.checkpointCloseTime
      return {
        schemas: {
          total: 3,
          publishers: 2,
          minimumLedgerIndex: network.activationLedgerIndex,
          maximumLedgerIndex: checkpoint.ledgerIndex,
        },
        credentialGenerations: {
          total: 4,
          pending: 1,
          active: 1,
          expired: 1,
          deleted: 1,
          invalidEvidence: 0,
          minimumCreatedLedgerIndex: network.activationLedgerIndex,
          maximumLastLedgerIndex: checkpoint.ledgerIndex,
        },
      }
    }
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/stats',
    })

    expect(response.statusCode).toBe(200)
    expect(observedCloseTime).toBe(checkpoint.closeTime)
    expect(response.json()).toEqual({
      network: 'testnet',
      schemas: { total: 3, publishers: 2 },
      credentialGenerations: {
        total: 4,
        pending: 1,
        active: 1,
        expired: 1,
        deleted: 1,
      },
      checkpoint: {
        ledgerIndex: checkpoint.ledgerIndex,
        ledgerHash: checkpoint.ledgerHash,
        closeTime: checkpoint.closeTime,
        transactionRoot: checkpoint.transactionRoot,
      },
    })
  })

  it.each([
    [
      'unsafe bigint conversion',
      {
        total: Number.MAX_SAFE_INTEGER + 1,
        pending: 0,
        active: 0,
        expired: 0,
        deleted: 0,
        invalidEvidence: 0,
        minimumCreatedLedgerIndex: network.activationLedgerIndex,
        maximumLastLedgerIndex: checkpoint.ledgerIndex,
      },
    ],
    [
      'non-exclusive states',
      {
        total: 1,
        pending: 1,
        active: 1,
        expired: 0,
        deleted: 0,
        invalidEvidence: 0,
        minimumCreatedLedgerIndex: network.activationLedgerIndex,
        maximumLastLedgerIndex: checkpoint.ledgerIndex,
      },
    ],
    [
      'out-of-range lifecycle evidence',
      {
        total: 1,
        pending: 1,
        active: 0,
        expired: 0,
        deleted: 0,
        invalidEvidence: 1,
        minimumCreatedLedgerIndex: network.activationLedgerIndex,
        maximumLastLedgerIndex: checkpoint.ledgerIndex,
      },
    ],
  ])('fails closed when discovery aggregates contain %s', async (_label, credentialStats) => {
    const repository = new RouteRepository()
    repository.getDiscoveryStats = async () => ({
      schemas: {
        total: 0,
        publishers: 0,
        minimumLedgerIndex: null,
        maximumLedgerIndex: null,
      },
      credentialGenerations: credentialStats,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/stats',
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('keeps text and address search schema-only and treats wildcard characters as plain text', async () => {
    const repository = new RouteRepository()
    const searches: Parameters<ApiRepository['searchSchemas']>[0][] = []
    repository.searchSchemas = async (input) => {
      searches.push(input)
      return input.publisher === undefined ? [registeredSchemaRow] : []
    }
    repository.getSchemaProjectionEvidence = async () => [registeredSchemaEvidence]
    repository.getCredentialGenerationById = async () => {
      throw new Error('non-hash search must not query Credential generations')
    }
    repository.getTransactionProjectionSummary = async () => {
      throw new Error('non-hash search must not query transaction projections')
    }
    const instance = await configuredApp({ repository })

    const text = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/search?q=Course%25_&limit=5',
    })
    const address = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/search?q=${ISSUER}`,
    })

    expect(text.statusCode).toBe(200)
    expect(text.json()).toEqual({
      items: [{ type: 'schema', ...publicSchemaSearchFixture() }],
      hasMore: false,
    })
    expect(address.statusCode).toBe(200)
    expect(searches).toEqual([
      { profileId: 'testnet', query: 'Course%_', limit: 5 },
      { profileId: 'testnet', publisher: ISSUER, limit: 20 },
    ])
  })

  it('returns only exact hash matches as flat discriminated search results', async () => {
    const repository = new RouteRepository()
    const matchingGeneration = { ...generation, generationId: registeredSchemaUid }
    const matchingEvent = {
      ...credentialEvent,
      transactionHash: registeredSchemaUid,
      generationId: registeredSchemaUid,
      transactionIndex: 0,
      eventType: 'created' as const,
      accepted: false,
    }
    const matchingAcceptance = {
      ...credentialEvent,
      generationId: registeredSchemaUid,
    }
    repository.getSchema = async (_profileId, uid) =>
      uid === registeredSchemaUid ? registeredSchemaRow : undefined
    repository.getSchemaProjectionEvidence = async () => [registeredSchemaEvidence]
    repository.getCredentialGenerationById = async () => matchingGeneration
    repository.getCredentialEventsByGeneration = async () => [matchingEvent, matchingAcceptance]
    repository.getTransactionProjectionSummary = async () => ({
      registration: undefined,
      firstCredentialEvent: matchingEvent,
      credentialEventCount: 1,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/search?q=${registeredSchemaUid.toUpperCase()}&limit=2`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [
        { type: 'schema', ...publicSchemaSearchFixture() },
        {
          type: 'credential_generation',
          generationId: registeredSchemaUid,
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: UID,
          state: 'active',
          createdLedgerIndex: checkpoint.ledgerIndex,
          lastLedgerIndex: checkpoint.ledgerIndex,
        },
      ],
      hasMore: true,
    })
  })

  it('fails closed when an exact generation search has a contradictory timeline', async () => {
    const repository = new RouteRepository()
    const matchingGeneration = { ...generation, generationId: registeredSchemaUid }
    const createdOnly = {
      ...credentialEvent,
      transactionHash: registeredSchemaUid,
      generationId: registeredSchemaUid,
      transactionIndex: 0,
      eventType: 'created' as const,
      accepted: false,
    }
    repository.getCredentialGenerationById = async () => matchingGeneration
    repository.getCredentialEventsByGeneration = async () => [createdOnly]
    repository.getTransactionProjectionSummary = async () => ({
      registration: undefined,
      firstCredentialEvent: createdOnly,
      credentialEventCount: 1,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/search?q=${registeredSchemaUid}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it.each([
    ['/v1/networks/testnet/search?q=%25_', 'SEARCH_QUERY_INVALID'],
    ['/v1/networks/testnet/search?q=%20Course', 'SEARCH_QUERY_INVALID'],
    ['/v1/networks/testnet/search?q=Course&cursor=unexpected', 'VALIDATION_ERROR'],
    ['/v1/networks/testnet/search?q=Course&limit=51', 'VALIDATION_ERROR'],
  ])('strictly validates discovery search %s', async (url, error) => {
    const instance = await app()
    const response = await instance.inject({ method: 'GET', url })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error })
  })

  it('paginates schema-registration activity without exposing memo JSON or Credential events', async () => {
    const rejectedRegistration: SchemaEventRow = {
      ...acceptedSchemaRegistration,
      transactionHash: '9'.repeat(64),
      transactionIndex: 1,
      status: 'rejected',
      reasonCode: 'MEMO_FORMAT_INVALID',
      schemaUid: null,
      memoJson: null,
    }
    const repository = new RouteRepository()
    repository.listSchemaRegistrations = async () => [
      acceptedSchemaRegistration,
      rejectedRegistration,
    ]
    repository.getCredentialEventsByTransactionPage = async () => {
      throw new Error('schema activity must not read Credential events')
    }
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/activity?limit=1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().items).toHaveLength(1)
    expect(response.json().items[0]).toMatchObject({
      transactionHash: TX_HASH,
      status: 'accepted',
      schemaUid: registeredSchemaUid,
    })
    expect(response.json()).toHaveProperty('nextCursor')
    expect(response.body).not.toContain('memoJson')
    expect(response.body).not.toContain('snapshot')
  })

  it('returns an exact generation with an explicit bounded timeline and expires at the boundary', async () => {
    const expiringGeneration = { ...generation, expiration: checkpoint.closeTime }
    const createdEvent: CredentialEventRow = {
      ...credentialEvent,
      transactionHash: generation.generationId,
      transactionIndex: generation.createdTransactionIndex,
      eventType: 'created',
      accepted: false,
      expiration: checkpoint.closeTime,
    }
    const acceptedEvent = { ...credentialEvent, expiration: checkpoint.closeTime }
    const repository = new RouteRepository()
    let timelineLimit: number | undefined
    repository.getCredentialGenerationById = async () => expiringGeneration
    repository.getCredentialEventsByGeneration = async (input) => {
      timelineLimit = input.limit
      return [createdEvent, acceptedEvent]
    }
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/credential-generations/${generation.generationId.toUpperCase()}`,
    })

    expect(response.statusCode).toBe(200)
    expect(timelineLimit).toBe(101)
    expect(response.json()).toMatchObject({
      generation: { generationId: generation.generationId, expiration: checkpoint.closeTime },
      state: 'expired',
      timeline: [
        { eventType: 'created', transactionHash: generation.generationId },
        { eventType: 'accepted', transactionHash: TX_HASH },
      ],
    })
    expect(response.body).not.toContain('snapshot')
    expect(response.body).not.toContain('recordedAt')
    expect(response.body).not.toContain('profileId')
  })

  it('fails closed when a generation expiration exceeds the XRPL uint32 range', async () => {
    const repository = new RouteRepository()
    repository.getCredentialGenerationById = async () => ({
      ...generation,
      expiration: 4_294_967_296,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/credential-generations/${generation.generationId}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('fails closed when a deletion event contradicts the generation acceptance flag', async () => {
    const deletedGeneration: CredentialGenerationRow = {
      ...generation,
      deletedLedgerIndex: checkpoint.ledgerIndex,
      deletionCause: 'issuer_revoked',
    }
    const createdEvent: CredentialEventRow = {
      ...credentialEvent,
      transactionHash: generation.generationId,
      transactionIndex: generation.createdTransactionIndex,
      eventType: 'created',
      accepted: false,
    }
    const deletedEvent: CredentialEventRow = {
      ...credentialEvent,
      transactionHash: '8'.repeat(64),
      transactionIndex: 2,
      eventType: 'deleted',
      accepted: false,
      deletionCause: 'issuer_revoked',
    }
    const repository = new RouteRepository()
    repository.getCredentialGenerationById = async () => deletedGeneration
    repository.getCredentialEventsByGeneration = async () => [
      createdEvent,
      credentialEvent,
      deletedEvent,
    ]
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/credential-generations/${generation.generationId}`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('paginates multiple Credential events on an exact transaction', async () => {
    const first = { ...credentialEvent, nodeIndex: 0 }
    const second = { ...credentialEvent, nodeIndex: 1 }
    const repository = new RouteRepository()
    repository.getTransactionProjectionSummary = async () => ({
      registration: undefined,
      firstCredentialEvent: first,
      credentialEventCount: 2,
    })
    repository.getCredentialEventsByTransactionPage = async () => [first, second]
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/transactions/${TX_HASH.toUpperCase()}?limit=1`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      transactionHash: TX_HASH,
      ledgerIndex: checkpoint.ledgerIndex,
      ledgerHash: checkpoint.ledgerHash,
      transactionIndex: credentialEvent.transactionIndex,
      registration: null,
      credentialEvents: {
        items: [{ transactionHash: TX_HASH, nodeIndex: 0 }],
        nextCursor: '0',
      },
    })
    expect(response.body).not.toContain('snapshot')
  })

  it('returns authoritative 404s for unknown exact discovery identifiers', async () => {
    const instance = await app()
    const [generationResponse, transactionResponse] = await Promise.all([
      instance.inject({
        method: 'GET',
        url: `/v1/networks/testnet/credential-generations/${TX_HASH}`,
      }),
      instance.inject({
        method: 'GET',
        url: `/v1/networks/testnet/transactions/${TX_HASH}`,
      }),
    ])
    expect(generationResponse.statusCode).toBe(404)
    expect(generationResponse.json()).toMatchObject({ error: 'CREDENTIAL_GENERATION_NOT_FOUND' })
    expect(transactionResponse.statusCode).toBe(404)
    expect(transactionResponse.json()).toMatchObject({ error: 'TRANSACTION_NOT_FOUND' })
  })

  it('documents explicit success and failure responses for every discovery endpoint', async () => {
    const instance = await app()
    await instance.ready()
    const paths = instance.swagger().paths
    for (const path of [
      '/v1/networks/{network}/stats',
      '/v1/networks/{network}/search',
      '/v1/networks/{network}/activity',
      '/v1/networks/{network}/credential-generations/{generationId}',
      '/v1/networks/{network}/transactions/{transactionHash}',
    ]) {
      const responses = paths?.[path]?.get?.responses
      expect(responses).toHaveProperty('200')
      expect(responses).toHaveProperty('400')
      expect(responses).toHaveProperty('404')
      expect(responses).toHaveProperty('503')
    }
  })

  it('keeps public network and status endpoints available while authoritative reads are halted', async () => {
    const repository = new RouteRepository()
    repository.getIndexerStatus = async () => ({
      ...readyStatus,
      state: 'halted',
      errorCode: 'SOURCE_DIVERGENCE',
      writerId: null,
      leaseExpiresAt: null,
    })
    const instance = await configuredApp({ repository })

    expect((await instance.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
    expect((await instance.inject({ method: 'GET', url: '/v1/networks' })).statusCode).toBe(200)
    const statusResponse = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/status',
    })
    expect(statusResponse.statusCode).toBe(200)
    expect(statusResponse.json()).toMatchObject({ state: 'halted', errorCode: 'SOURCE_DIVERGENCE' })
  })

  it('does not invent a public status before the indexer writes one', async () => {
    const repository = new RouteRepository()
    repository.getIndexerStatus = async () => undefined
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: '/v1/networks/testnet/status' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'INDEXER_STATUS_NOT_FOUND',
      message: 'Indexer status not found',
    })
  })

  it('serves coherent root schemas through exact and list reads', async () => {
    const repository = new RouteRepository()
    const snapshot = new RouteRepository()
    let snapshotCalls = 0
    snapshot.getSchema = async () => registeredSchemaRow
    snapshot.listSchemas = async () => [registeredSchemaRow]
    snapshot.getSchemaProjectionEvidence = async () => [registeredSchemaEvidence]
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCalls += 1
      return callback(snapshot)
    }
    repository.getSchema = async () => {
      throw new Error('schema read escaped the snapshot')
    }
    repository.listSchemas = async () => {
      throw new Error('schema list escaped the snapshot')
    }
    repository.getSchemaProjectionEvidence = async () => {
      throw new Error('schema evidence read escaped the snapshot')
    }
    const instance = await configuredApp({ repository })

    const [exact, list] = await Promise.all([
      instance.inject({
        method: 'GET',
        url: `/v1/networks/testnet/schemas/${registeredSchemaUid}`,
      }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/schemas' }),
    ])

    expect(exact.statusCode).toBe(200)
    expect(exact.json()).toMatchObject({ schemaUid: registeredSchemaUid })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toHaveLength(1)
    expect(snapshotCalls).toBe(2)
  })

  it('serves an authoritative topological schema catalog from one snapshot', async () => {
    const fixture = schemaCatalogFixture()
    const repository = new RouteRepository()
    let catalogReads = 0
    repository.getSchema = async (_profileId, uid) =>
      uid === fixture.targetUid ? fixture.target : undefined
    repository.getSchemaCatalogEvidence = async () => {
      catalogReads += 1
      return fixture.evidence.toReversed()
    }
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/schemas/${fixture.targetUid}/catalog`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const catalog = response.json() as SchemaCatalogBundle
    expect(catalog.targetUid).toBe(fixture.targetUid)
    expect(catalog.profile).toMatchObject({
      profileId: network.profileId,
      requiredAmendment: network.requiredAmendment.toUpperCase(),
      registrationAmountDrops: '1',
    })
    expect(catalog.checkpoint).toEqual({
      ledgerIndex: checkpoint.ledgerIndex,
      ledgerHash: checkpoint.ledgerHash,
    })
    expect(catalog.schemas.map((entry) => entry.uid)).toEqual([
      fixture.parentUid,
      fixture.supersededUid,
      fixture.targetUid,
    ])
    expect(catalogReads).toBe(1)

    const openApiPath =
      instance.swagger().paths?.['/v1/networks/{network}/schemas/{uid}/catalog']?.get
    expect(openApiPath?.responses).toHaveProperty('200')
    expect(openApiPath?.responses).toHaveProperty('400')
    expect(openApiPath?.responses).toHaveProperty('404')
    expect(openApiPath?.responses).toHaveProperty('429')
    expect(openApiPath?.responses).toHaveProperty('503')
    expect(openApiPath?.responses).toHaveProperty('500')
  })

  it('returns 404 only after authoritative readiness and fails closed on incomplete catalogs', async () => {
    const missingRepository = new RouteRepository()
    const missingInstance = await configuredApp({ repository: missingRepository })
    const missing = await missingInstance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/schemas/${UID}/catalog`,
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')
    expect(missing.json()).toMatchObject({ error: 'SCHEMA_NOT_FOUND' })

    const fixture = schemaCatalogFixture()
    const incompleteRepository = new RouteRepository()
    incompleteRepository.getSchema = async () => fixture.target
    incompleteRepository.getSchemaCatalogEvidence = async () => fixture.evidence.slice(1)
    const incompleteInstance = await configuredApp({ repository: incompleteRepository })
    const incomplete = await incompleteInstance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/schemas/${fixture.targetUid}/catalog`,
    })
    expect(incomplete.statusCode).toBe(503)
    expect(incomplete.headers['cache-control']).toBe('no-store')
    expect(incomplete.json()).toMatchObject({ error: 'SCHEMA_PROJECTION_INVALID' })
  })

  it('fails closed when catalog evidence exceeds the normative closure bound', async () => {
    const fixture = schemaCatalogFixture()
    const repository = new RouteRepository()
    repository.getSchema = async () => fixture.target
    repository.getSchemaCatalogEvidence = async () =>
      Array.from({ length: MAX_SCHEMA_CATALOG_ENTRIES + 1 }, () => fixture.evidence[0]!)
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/schemas/${fixture.targetUid}/catalog`,
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({ error: 'SCHEMA_PROJECTION_INVALID' })
  })

  it.each(['exact', 'list'] as const)(
    'fails closed when the %s schema read contains an incoherent root projection',
    async (surface) => {
      const repository = new RouteRepository()
      const corrupted: SchemaRow = {
        ...registeredSchemaRow,
        resolvedDefinition: {
          definition: registeredSchema,
          fields: { unexpected: { type: 'string' } },
          lineage: [],
        },
      }
      repository.getSchema = async () => corrupted
      repository.listSchemas = async () => [corrupted]
      repository.getSchemaProjectionEvidence = async () => [
        { ...registeredSchemaEvidence, schema: corrupted },
      ]
      const instance = await configuredApp({ repository })
      const response = await instance.inject({
        method: 'GET',
        url:
          surface === 'exact'
            ? `/v1/networks/testnet/schemas/${registeredSchemaUid}`
            : '/v1/networks/testnet/schemas',
      })

      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: 'SCHEMA_PROJECTION_INVALID' })
    },
  )

  it('fails readiness when the last indexed ledger is stale', async () => {
    const repository = new RouteRepository()
    repository.getLatestCheckpoint = async () => ({
      ...checkpoint,
      closeTime: NOW_RIPPLE - 121,
    })
    const instance = await configuredApp({
      repository,
      readinessMaxLedgerAgeSeconds: 120,
    })
    const response = await instance.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'indexer_stale' })
  })

  it('fails readiness when the last indexed ledger is implausibly in the future', async () => {
    const repository = new RouteRepository()
    repository.getLatestCheckpoint = async () => ({
      ...checkpoint,
      closeTime: NOW_RIPPLE + 31,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'indexer_stale' })
  })

  it.each([
    ['stale', NOW_RIPPLE - 121],
    ['implausibly in the future', NOW_RIPPLE + 31],
  ])('refuses verification when the indexed proof is %s', async (_label, closeTime) => {
    const repository = new RouteRepository()
    repository.getLatestCheckpoint = async () => ({ ...checkpoint, closeTime })
    const instance = await configuredApp({
      repository,
      readinessMaxLedgerAgeSeconds: 120,
    })
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      error: 'INDEXER_STALE',
      message: 'The indexed ledger checkpoint is stale or has an invalid timestamp.',
    })
  })

  it('refuses verification until the indexer has a checkpoint', async () => {
    const repository = new RouteRepository()
    repository.getLatestCheckpoint = async () => undefined
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      error: 'INDEXER_NOT_INITIALIZED',
      message: 'The indexer has not produced a ledger checkpoint for this network.',
    })
  })

  it('returns an exact credential state only from a fresh checkpoint', async () => {
    const repository = new RouteRepository()
    repository.getCredential = async () => generation
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialUrl })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      generationId: generation.generationId,
      state: 'active',
    })
  })

  it('fails closed on credential projections older than network activation', async () => {
    const repository = new RouteRepository()
    repository.getCredential = async () => ({
      ...generation,
      createdLedgerIndex: network.activationLedgerIndex - 1,
    })
    const instance = await configuredApp({ repository })

    const state = await instance.inject({ method: 'GET', url: credentialUrl })
    expect(state.statusCode).toBe(503)
    expect(state.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getCredentialEvents = async () => [
      { ...credentialEvent, ledgerIndex: network.activationLedgerIndex - 1 },
    ]
    const history = await instance.inject({ method: 'GET', url: credentialEventsUrl })
    expect(history.statusCode).toBe(503)
    expect(history.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('serves every authoritative credential read from the repository snapshot', async () => {
    const repository = new RouteRepository()
    const snapshot = new RouteRepository()
    let snapshotCalls = 0
    snapshot.getCredential = async () => generation
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCalls += 1
      return callback(snapshot)
    }
    repository.getNetwork = async () => {
      throw new Error('authoritative read escaped the snapshot')
    }
    repository.getIndexerStatus = async () => {
      throw new Error('authoritative read escaped the snapshot')
    }
    repository.getLatestCheckpoint = async () => {
      throw new Error('authoritative read escaped the snapshot')
    }
    repository.getCredential = async () => {
      throw new Error('authoritative read escaped the snapshot')
    }

    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialUrl })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      generationId: generation.generationId,
      state: 'active',
    })
    expect(snapshotCalls).toBe(1)
  })

  it('looks up one exact transaction event inside the authoritative snapshot', async () => {
    const repository = new RouteRepository()
    const snapshot = new RouteRepository()
    let snapshotCalls = 0
    let lookup: Parameters<ApiRepository['getCredentialEventsByTransaction']>[0] | undefined
    snapshot.getCredentialEvents = async () => {
      throw new Error('full event history must not be read')
    }
    snapshot.getCredentialEventsByTransaction = async (input) => {
      lookup = input
      return [credentialEvent]
    }
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCalls += 1
      return callback(snapshot)
    }
    repository.getNetwork = async () => {
      throw new Error('exact event read escaped the snapshot')
    }
    repository.getCredentialEventsByTransaction = async () => {
      throw new Error('exact event read escaped the snapshot')
    }

    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      transactionHash: TX_HASH,
      event: {
        transactionHash: TX_HASH,
        nodeIndex: 0,
        generationId: generation.generationId,
        ledgerIndex: checkpoint.ledgerIndex,
        ledgerHash: credentialEvent.ledgerHash,
        transactionIndex: 1,
        eventType: 'accepted',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        accepted: true,
        deletionCause: null,
      },
    })
    expect(lookup).toEqual({
      profileId: 'testnet',
      transactionHash: TX_HASH,
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      limit: 2,
    })
    expect(snapshotCalls).toBe(1)

    const operation =
      instance.swagger().paths?.[
        '/v1/networks/{network}/credentials/{issuer}/{subject}/{schemaUid}/events/{transactionHash}'
      ]?.get
    expect(operation?.responses).toHaveProperty('200')
    expect(operation?.responses).toHaveProperty('400')
    expect(operation?.responses).toHaveProperty('404')
    expect(operation?.responses).toHaveProperty('503')
  })

  it('returns accepted and rejected schema registration evidence without exposing memo JSON', async () => {
    const repository = new RouteRepository()
    const snapshot = new RouteRepository()
    let snapshotCalls = 0
    let lookup: Parameters<ApiRepository['getSchemaRegistrationByTransaction']>[0] | undefined
    snapshot.getSchemaRegistrationByTransaction = async (input) => {
      lookup = input
      return acceptedSchemaRegistration
    }
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCalls += 1
      return callback(snapshot)
    }
    repository.getNetwork = async () => {
      throw new Error('schema registration read escaped the snapshot')
    }
    repository.getSchemaRegistrationByTransaction = async () => {
      throw new Error('schema registration read escaped the snapshot')
    }
    const instance = await configuredApp({ repository })

    const accepted = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toEqual({
      transactionHash: TX_HASH,
      registration: {
        status: 'accepted',
        publisher: ISSUER,
        ledgerIndex: acceptedSchemaRegistration.ledgerIndex,
        ledgerHash: acceptedSchemaRegistration.ledgerHash,
        transactionIndex: acceptedSchemaRegistration.transactionIndex,
        schemaUid: registeredSchemaUid,
        schemaDigestHex: sha256Hex(encodeUtf8(canonicalJson(acceptedSchemaRegistration.memoJson))),
        reasonCode: null,
      },
    })
    expect(JSON.stringify(accepted.json())).not.toContain('memoJson')
    expect(lookup).toEqual({ profileId: 'testnet', transactionHash: TX_HASH })
    expect(snapshotCalls).toBe(1)

    const rawMemoJson = {
      ...registeredSchema,
      fields: { programId: { type: 'string' as const, optional: false } },
    }
    const normalizedSchema = parseSchema(rawMemoJson)
    const normalizedSchemaUid = computeSchemaUid({
      schema: normalizedSchema,
      networkId: network.networkId,
      ledgerHash: checkpoint.ledgerHash,
      ledgerIndex: checkpoint.ledgerIndex,
      transactionIndex: acceptedSchemaRegistration.transactionIndex,
      publisher: ISSUER,
    })
    snapshot.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      schemaUid: normalizedSchemaUid,
      memoJson: rawMemoJson,
    })
    const acceptedUnnormalizedMemo = await instance.inject({
      method: 'GET',
      url: schemaRegistrationUrl,
    })
    expect(acceptedUnnormalizedMemo.statusCode).toBe(200)
    expect(acceptedUnnormalizedMemo.json()).toMatchObject({
      registration: {
        schemaUid: normalizedSchemaUid,
        schemaDigestHex: sha256Hex(encodeUtf8(canonicalJson(rawMemoJson))),
      },
    })
    expect(acceptedUnnormalizedMemo.json().registration.schemaDigestHex).not.toBe(
      sha256Hex(encodeUtf8(canonicalJson(normalizedSchema))),
    )

    snapshot.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      status: 'rejected',
      schemaUid: null,
      memoJson: null,
      reasonCode: 'REGISTRATION_NOT_CANONICAL',
    })
    const rejected = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(rejected.statusCode).toBe(200)
    expect(rejected.json()).toEqual({
      transactionHash: TX_HASH,
      registration: {
        status: 'rejected',
        publisher: ISSUER,
        ledgerIndex: acceptedSchemaRegistration.ledgerIndex,
        ledgerHash: acceptedSchemaRegistration.ledgerHash,
        transactionIndex: acceptedSchemaRegistration.transactionIndex,
        schemaUid: null,
        schemaDigestHex: null,
        reasonCode: 'REGISTRATION_NOT_CANONICAL',
      },
    })
    expect(snapshotCalls).toBe(3)

    const operation =
      instance.swagger().paths?.['/v1/networks/{network}/schema-registrations/{transactionHash}']
        ?.get
    expect(operation?.responses).toHaveProperty('200')
    expect(operation?.responses).toHaveProperty('400')
    expect(operation?.responses).toHaveProperty('404')
    expect(operation?.responses).toHaveProperty('503')
  })

  it('returns null for an unknown schema registration and validates its route boundary', async () => {
    const instance = await app()
    const missing = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(missing.statusCode).toBe(200)
    expect(missing.json()).toEqual({ transactionHash: TX_HASH, registration: null })

    const malformed = await instance.inject({
      method: 'GET',
      url: '/v1/networks/testnet/schema-registrations/not-a-hash',
    })
    expect(malformed.statusCode).toBe(400)
    const missingNetwork = await instance.inject({
      method: 'GET',
      url: `/v1/networks/missing/schema-registrations/${TX_HASH}`,
    })
    expect(missingNetwork.statusCode).toBe(404)
  })

  it('fails closed on inconsistent schema registration evidence', async () => {
    const repository = new RouteRepository()
    repository.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      memoJson: null,
    })
    const instance = await configuredApp({ repository })
    const malformed = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(malformed.statusCode).toBe(503)
    expect(malformed.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      schemaUid: '0'.repeat(64),
    })
    const wrongUid = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(wrongUid.statusCode).toBe(503)
    expect(wrongUid.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      transactionHash: '1'.repeat(64),
    })
    const wrongTransaction = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(wrongTransaction.statusCode).toBe(503)
    expect(wrongTransaction.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      ledgerIndex: network.activationLedgerIndex - 1,
    })
    const beforeActivation = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(beforeActivation.statusCode).toBe(503)
    expect(beforeActivation.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getSchemaRegistrationByTransaction = async () => ({
      ...acceptedSchemaRegistration,
      ledgerIndex: checkpoint.ledgerIndex + 1,
    })
    const ahead = await instance.inject({ method: 'GET', url: schemaRegistrationUrl })
    expect(ahead.statusCode).toBe(503)
    expect(ahead.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('returns an explicit empty exact lookup and fails closed on ambiguous event rows', async () => {
    const repository = new RouteRepository()
    const instance = await configuredApp({ repository })
    const missing = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })
    expect(missing.statusCode).toBe(200)
    expect(missing.json()).toEqual({ transactionHash: TX_HASH, event: null })

    repository.getCredentialEventsByTransaction = async () => [
      credentialEvent,
      { ...credentialEvent, nodeIndex: 1 },
    ]
    const ambiguous = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })
    expect(ambiguous.statusCode).toBe(503)
    expect(ambiguous.json()).toMatchObject({ error: 'CREDENTIAL_EVENT_AMBIGUOUS' })

    repository.getCredentialEventsByTransaction = async () => [
      { ...credentialEvent, ledgerIndex: network.activationLedgerIndex - 1 },
    ]
    const beforeActivation = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })
    expect(beforeActivation.statusCode).toBe(503)
    expect(beforeActivation.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    repository.getCredentialEventsByTransaction = async () => [
      { ...credentialEvent, accepted: false },
    ]
    const contradictory = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })
    expect(contradictory.statusCode).toBe(503)
    expect(contradictory.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })

    const malformed = await instance.inject({
      method: 'GET',
      url: `${credentialEventsUrl}/not-a-hash`,
    })
    expect(malformed.statusCode).toBe(400)
  })

  it('bounds the legacy credential event history without silently truncating it', async () => {
    const repository = new RouteRepository()
    let requestedLimit: number | undefined
    repository.getCredentialEvents = async (input) => {
      requestedLimit = input.limit
      return Array.from({ length: input.limit }, (_, nodeIndex) => ({
        ...credentialEvent,
        nodeIndex,
      }))
    }
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialEventsUrl })

    expect(requestedLimit).toBe(101)
    expect(response.statusCode).toBe(413)
    expect(response.json()).toMatchObject({ error: 'CREDENTIAL_EVENT_HISTORY_LIMIT_EXCEEDED' })
    expect(
      instance.swagger().paths?.[
        '/v1/networks/{network}/credentials/{issuer}/{subject}/{schemaUid}/events'
      ]?.get?.responses,
    ).toHaveProperty('413')
  })

  it('documents and returns ledger coordinates and acceptance in credential event history', async () => {
    const repository = new RouteRepository()
    repository.getCredentialEvents = async () => [credentialEvent]
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialEventsUrl })

    expect(response.statusCode).toBe(200)
    expect(response.json().items[0]).toMatchObject({
      ledgerHash: credentialEvent.ledgerHash,
      transactionIndex: credentialEvent.transactionIndex,
      accepted: credentialEvent.accepted,
      ledgerObjectId: credentialEvent.ledgerObjectId,
    })
    const operation =
      instance.swagger().paths?.[
        '/v1/networks/{network}/credentials/{issuer}/{subject}/{schemaUid}/events'
      ]?.get
    expect(operation?.responses).toHaveProperty('200')
  })

  it.each([
    ['a mismatched subject', { ...credentialEvent, subject: ISSUER }],
    ['an expiration above uint32', { ...credentialEvent, expiration: 4_294_967_296 }],
  ])('fails closed when event history contains %s', async (_label, malformedEvent) => {
    const repository = new RouteRepository()
    repository.getCredentialEvents = async () => [malformedEvent]
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialEventsUrl })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it('uses PostgreSQL time to reject an expired writer lease in production mode', async () => {
    const repository = new RouteRepository()
    repository.getCredential = async () => generation
    repository.getDatabaseTime = async () => new Date(readyStatus.leaseExpiresAt!.getTime() + 1)
    const instance = await createApi({
      repository,
      resolver: { resolve: async () => new Uint8Array() },
      trustPolicy: new StaticTrustPolicy(),
    })
    apps.push(instance)

    const [credentialResponse, verificationResponse] = await Promise.all([
      instance.inject({ method: 'GET', url: credentialUrl }),
      instance.inject({
        method: 'POST',
        url: '/v1/verify',
        payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
      }),
    ])

    for (const response of [credentialResponse, verificationResponse]) {
      expect(response.statusCode).toBe(503)
      expect(response.json()).toMatchObject({ error: 'INDEXER_LEASE_EXPIRED' })
    }
  })

  it.each([
    [undefined, 'INDEXER_STATUS_UNAVAILABLE'],
    [{ ...readyStatus, state: 'starting' as const }, 'INDEXER_NOT_READY'],
    [{ ...readyStatus, state: 'catching_up' as const }, 'INDEXER_NOT_READY'],
    [
      { ...readyStatus, state: 'halted' as const, errorCode: 'LEDGER_PARENT_MISMATCH' },
      'INDEXER_HALTED',
    ],
  ])(
    'refuses authoritative routes immediately for durable status %#',
    async (status, errorCode) => {
      const repository = new RouteRepository()
      repository.getCredential = async () => generation
      repository.getIndexerStatus = async () => status
      const instance = await configuredApp({ repository })

      const [credentialResponse, verificationResponse] = await Promise.all([
        instance.inject({ method: 'GET', url: credentialUrl }),
        instance.inject({
          method: 'POST',
          url: '/v1/verify',
          payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
        }),
      ])
      for (const response of [credentialResponse, verificationResponse]) {
        expect(response.statusCode).toBe(503)
        expect(response.json()).toMatchObject({ error: errorCode })
        expect(JSON.stringify(response.json())).not.toContain('LEDGER_PARENT_MISMATCH')
      }
    },
  )

  it('rejects every ledger-derived route before reading projections when the lease is unavailable', async () => {
    const repository = new RouteRepository()
    let projectionReads = 0
    repository.getIndexerStatus = async () => undefined
    repository.getLatestCheckpoint = async () => {
      projectionReads += 1
      return checkpoint
    }
    repository.getSchema = async () => {
      projectionReads += 1
      return undefined
    }
    repository.getSchemaRegistrationByTransaction = async () => {
      projectionReads += 1
      return acceptedSchemaRegistration
    }
    repository.listSchemas = async () => {
      projectionReads += 1
      return []
    }
    repository.getSchemaProjectionEvidence = async () => {
      projectionReads += 1
      return []
    }
    repository.getSchemaCatalogEvidence = async () => {
      projectionReads += 1
      return []
    }
    repository.getCredential = async () => {
      projectionReads += 1
      return generation
    }
    repository.getCredentialEvents = async () => {
      projectionReads += 1
      return []
    }
    repository.getCredentialEventsByTransaction = async () => {
      projectionReads += 1
      return []
    }
    repository.searchSchemas = async () => {
      projectionReads += 1
      return []
    }
    repository.listSchemaRegistrations = async () => {
      projectionReads += 1
      return []
    }
    repository.getDiscoveryStats = async () => {
      projectionReads += 1
      throw new Error('unexpected aggregate read')
    }
    repository.getCredentialGenerationById = async () => {
      projectionReads += 1
      return generation
    }
    repository.getCredentialEventsByGeneration = async () => {
      projectionReads += 1
      return []
    }
    repository.getTransactionProjectionSummary = async () => {
      projectionReads += 1
      return {
        registration: undefined,
        firstCredentialEvent: undefined,
        credentialEventCount: 0,
      }
    }
    repository.getCredentialEventsByTransactionPage = async () => {
      projectionReads += 1
      return []
    }
    const instance = await configuredApp({ repository })

    const responses = await Promise.all([
      instance.inject({ method: 'GET', url: schemaUrl }),
      instance.inject({ method: 'GET', url: `/v1/networks/testnet/schemas/${UID}/catalog` }),
      instance.inject({ method: 'GET', url: schemaRegistrationUrl }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/schemas' }),
      instance.inject({ method: 'GET', url: credentialUrl }),
      instance.inject({ method: 'GET', url: credentialEventsUrl }),
      instance.inject({ method: 'GET', url: exactCredentialEventUrl }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/stats' }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/search?q=Course' }),
      instance.inject({ method: 'GET', url: '/v1/networks/testnet/activity' }),
      instance.inject({
        method: 'GET',
        url: `/v1/networks/testnet/credential-generations/${generation.generationId}`,
      }),
      instance.inject({ method: 'GET', url: `/v1/networks/testnet/transactions/${TX_HASH}` }),
      instance.inject({
        method: 'POST',
        url: '/v1/verify',
        payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
      }),
    ])
    expect(responses.map((response) => response.statusCode)).toEqual(Array(13).fill(503))
    expect(projectionReads).toBe(0)
  })

  it('refuses an exact event that is ahead of the authoritative checkpoint', async () => {
    const repository = new RouteRepository()
    repository.getCredentialEventsByTransaction = async () => [
      { ...credentialEvent, ledgerIndex: checkpoint.ledgerIndex + 1 },
    ]
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: exactCredentialEventUrl })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: 'INDEXER_EVIDENCE_INVALID' })
  })

  it.each([
    [
      'expired lease',
      { status: { ...readyStatus, leaseExpiresAt: NOW }, checkpoint },
      'INDEXER_LEASE_EXPIRED',
    ],
    [
      'checkpoint mismatch',
      {
        status: {
          ...readyStatus,
          primarySourceTip: 101,
          secondarySourceTip: 101,
          lastAgreedLedgerIndex: 101,
          lastAgreedLedgerHash: '2'.repeat(64),
        },
        checkpoint,
      },
      'INDEXER_EVIDENCE_INVALID',
    ],
  ])('fails closed on %s', async (_label, evidence, errorCode) => {
    const repository = new RouteRepository()
    repository.getCredential = async () => generation
    repository.getIndexerStatus = async () => evidence.status
    repository.getLatestCheckpoint = async () => evidence.checkpoint
    const instance = await configuredApp({ repository })
    const response = await instance.inject({ method: 'GET', url: credentialUrl })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: errorCode })
  })

  it.each([
    [
      'missing',
      undefined,
      'INDEXER_NOT_INITIALIZED',
      'The indexer has not produced a ledger checkpoint for this network.',
    ],
    [
      'stale',
      { ...checkpoint, closeTime: NOW_RIPPLE - 121 },
      'INDEXER_STALE',
      'The indexed ledger checkpoint is stale or has an invalid timestamp.',
    ],
    [
      'invalid',
      { ...checkpoint, closeTime: -1 },
      'INDEXER_EVIDENCE_INVALID',
      'The indexer integrity evidence is incomplete or inconsistent.',
    ],
    [
      'implausibly in the future',
      { ...checkpoint, closeTime: NOW_RIPPLE + 31 },
      'INDEXER_STALE',
      'The indexed ledger checkpoint is stale or has an invalid timestamp.',
    ],
  ] as const)(
    'refuses to serve an exact credential state when its checkpoint is %s',
    async (_label, checkpointValue, error, message) => {
      const repository = new RouteRepository()
      repository.getCredential = async () => generation
      repository.getLatestCheckpoint = async () => checkpointValue
      const instance = await configuredApp({
        repository,
        readinessMaxLedgerAgeSeconds: 120,
      })
      const response = await instance.inject({ method: 'GET', url: credentialUrl })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({ error, message })
    },
  )

  it('rejects additional verification properties', async () => {
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: {
        network: 'testnet',
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: UID,
        unexpected: true,
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('requires exact credential identifiers and has no account-wide list', async () => {
    const instance = await app()
    const response = await instance.inject({
      method: 'GET',
      url: `/v1/networks/testnet/credentials/${ISSUER}`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns the four verification dimensions', async () => {
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      onChain: 'not_found',
      schema: 'unknown',
      payload: 'not_checked',
      issuerTrust: 'unknown',
    })
  })

  it('returns a stable 503 when verification reads a corrupted schema projection', async () => {
    const repository = new RouteRepository()
    repository.getSchema = async () => ({
      profileId: 'testnet',
      schemaUid: UID,
      publisher: ISSUER,
      name: registeredSchema.name,
      description: registeredSchema.description,
      parentUid: null,
      supersedesUid: null,
      definition: registeredSchema,
      resolvedDefinition: {
        definition: registeredSchema,
        fields: {},
        lineage: [],
      },
      registrationTransactionHash: TX_HASH,
      ledgerIndex: checkpoint.ledgerIndex,
      transactionIndex: 0,
      registeredAt: NOW,
    })
    const instance = await configuredApp({ repository })
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      error: 'SCHEMA_PROJECTION_INVALID',
      message: 'The indexed schema projection is incomplete or inconsistent.',
    })
  })

  it('accepts a verification envelope containing a payload at the 1 MiB protocol limit', async () => {
    const instance = await app()
    const payload = {
      xcsVersion: '0.1',
      issuer: ISSUER,
      subject: SUBJECT,
      schema: UID,
      claims: { proof: '' },
    }
    const emptyPayloadSize = encodeUtf8(canonicalJson(payload)).length
    payload.claims.proof = 'x'.repeat(1024 * 1024 - emptyPayloadSize)
    expect(encodeUtf8(canonicalJson(payload))).toHaveLength(1024 * 1024)

    const requestBody = {
      network: 'testnet',
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
      payload,
    }
    expect(Buffer.byteLength(JSON.stringify(requestBody))).toBeGreaterThan(1024 * 1024)

    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: requestBody,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ payload: 'invalid' })
  })

  it('checks verification network membership inside the authoritative snapshot', async () => {
    const repository = new RouteRepository()
    const snapshot = new RouteRepository()
    let snapshotCalls = 0
    repository.withConsistentSnapshot = async (callback) => {
      snapshotCalls += 1
      return callback(snapshot)
    }
    repository.getNetwork = async () => {
      throw new Error('verification network read escaped the snapshot')
    }
    const instance = await configuredApp({ repository })

    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'testnet', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })

    expect(response.statusCode).toBe(200)
    expect(snapshotCalls).toBe(1)
  })

  it('returns 404 when verification targets a network absent from the snapshot', async () => {
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: { network: 'missing', issuer: ISSUER, subject: SUBJECT, schemaUid: UID },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'NETWORK_NOT_FOUND', message: 'Network not found' })
  })

  it('emits CORS headers only for an explicitly allowed origin', async () => {
    const instance = await configuredApp({
      allowedOrigins: ['http://localhost:3000'],
    })
    const allowed = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    })
    const denied = await instance.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://attacker.example' },
    })
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('rate limits verification independently from the global budget', async () => {
    const instance = await configuredApp({
      globalRateLimit: 100,
      verifyRateLimit: 1,
    })
    const payload = {
      network: 'testnet',
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: UID,
    }
    expect((await instance.inject({ method: 'POST', url: '/v1/verify', payload })).statusCode).toBe(
      200,
    )
    expect((await instance.inject({ method: 'POST', url: '/v1/verify', payload })).statusCode).toBe(
      429,
    )
  })

  it('rate limits authenticated SSR sessions independently and ignores spoofed client keys', async () => {
    const internalSsrToken = 'test-internal-ssr-token-000000000001'
    const trusted = await configuredApp({ globalRateLimit: 1, internalSsrToken })
    const trustedHeaders = (clientKey: string) => ({
      'x-xcs-internal-token': internalSsrToken,
      'x-xcs-client-key': clientKey,
    })
    expect(
      (
        await trusted.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: trustedHeaders('a'.repeat(64)),
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await trusted.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: trustedHeaders('b'.repeat(64)),
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await trusted.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: trustedHeaders('a'.repeat(64)),
        })
      ).statusCode,
    ).toBe(429)

    const spoofed = await configuredApp({ globalRateLimit: 1, internalSsrToken })
    const spoofedHeaders = (clientKey: string) => ({
      'x-xcs-internal-token': 'wrong-internal-ssr-token-0000000000',
      'x-xcs-client-key': clientKey,
    })
    expect(
      (
        await spoofed.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: spoofedHeaders('c'.repeat(64)),
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await spoofed.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: spoofedHeaders('d'.repeat(64)),
        })
      ).statusCode,
    ).toBe(429)

    const nonAscii = await configuredApp({ globalRateLimit: 1, internalSsrToken })
    const nonAsciiHeaders = (clientKey: string) => ({
      'x-xcs-internal-token': 'é'.repeat(internalSsrToken.length),
      'x-xcs-client-key': clientKey,
    })
    expect(
      (
        await nonAscii.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: nonAsciiHeaders('e'.repeat(64)),
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (
        await nonAscii.inject({
          method: 'GET',
          url: '/v1/networks',
          headers: nonAsciiHeaders('f'.repeat(64)),
        })
      ).statusCode,
    ).toBe(429)
  })

  it('uses forwarded client IPs only when the immediate proxy is explicitly trusted', async () => {
    const instance = await configuredApp({
      globalRateLimit: 1,
      trustedProxyCidrs: ['127.0.0.1'],
    })
    const requestFrom = (address: string) =>
      instance.inject({
        method: 'GET',
        url: '/v1/networks',
        headers: { 'x-forwarded-for': address },
      })

    expect((await requestFrom('198.51.100.10')).statusCode).toBe(200)
    expect((await requestFrom('198.51.100.11')).statusCode).toBe(200)
    expect((await requestFrom('198.51.100.10')).statusCode).toBe(429)
  })

  it('keeps demo pinning routes absent unless explicitly configured', async () => {
    const instance = await app()
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/pinning/challenges',
      payload: { network: 'testnet', wallet: ISSUER },
    })
    expect(response.statusCode).toBe(404)
  })
})
