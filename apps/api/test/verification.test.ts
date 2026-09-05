import {
  computeSchemaUid,
  createHttpsPayloadUri,
  type CredentialPayload,
  type ResolvedSchema,
  type SchemaDefinition,
} from '@xcs-protocol/core'
import type {
  CredentialEventRow,
  CredentialGenerationRow,
  IndexerStatusRow,
  LedgerCheckpointRow,
  NetworkProfileRow,
  SchemaEventRow,
  SchemaRow,
} from '@xcs-protocol/db'
import { describe, expect, it } from 'vitest'

import {
  DisabledPayloadResolver,
  PayloadInvalidError,
  PayloadUnavailableError,
} from '../src/payload-resolver.js'
import type { ApiRepository, PayloadResolver, SchemaProjectionEvidence } from '../src/types.js'
import { canonicalJson } from '../src/serialization.js'
import { StaticTrustPolicy, verifyCredential } from '../src/verification.js'

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const NOW = new Date('2026-08-19T00:00:00.000Z')
const NOW_RIPPLE = Math.floor(NOW.getTime() / 1_000) - 946_684_800
const FRESHNESS = {
  now: () => NOW,
  maxLedgerAgeSeconds: 120,
} as const

function registeredProjection(input: {
  definition: SchemaDefinition
  fields: ResolvedSchema['fields']
  lineage: string[]
  ledgerIndex: number
  transactionIndex: number
  ledgerHash: string
  transactionHash: string
}): SchemaProjectionEvidence {
  const schemaUid = computeSchemaUid({
    schema: input.definition,
    networkId: 1,
    ledgerHash: input.ledgerHash,
    ledgerIndex: input.ledgerIndex,
    transactionIndex: input.transactionIndex,
    publisher: ISSUER,
  })
  const schema: SchemaRow = {
    profileId: 'testnet',
    schemaUid,
    publisher: ISSUER,
    name: input.definition.name,
    description: input.definition.description,
    parentUid: input.definition.extends ?? null,
    supersedesUid: input.definition.supersedes ?? null,
    definition: input.definition as unknown as Record<string, unknown>,
    resolvedDefinition: {
      definition: input.definition,
      fields: input.fields,
      lineage: input.lineage,
    },
    registrationTransactionHash: input.transactionHash,
    ledgerIndex: input.ledgerIndex,
    transactionIndex: input.transactionIndex,
    registeredAt: NOW,
  }
  return {
    schema,
    registration: {
      profileId: 'testnet',
      transactionHash: input.transactionHash,
      ledgerIndex: input.ledgerIndex,
      ledgerHash: input.ledgerHash,
      transactionIndex: input.transactionIndex,
      publisher: ISSUER,
      status: 'accepted',
      reasonCode: null,
      schemaUid,
      memoJson: input.definition,
      recordedAt: NOW,
    },
  }
}

const resolved: ResolvedSchema = {
  definition: {
    xcsVersion: '0.1',
    name: 'Completion',
    description: 'Course completion',
    fields: { programId: { type: 'string' } },
  },
  fields: { programId: { type: 'string' } },
  lineage: [],
}
const baseEvidence = registeredProjection({
  definition: resolved.definition,
  fields: resolved.fields,
  lineage: [],
  ledgerIndex: 100,
  transactionIndex: 0,
  ledgerHash: '4'.repeat(64),
  transactionHash: 'b'.repeat(64),
})
const schema = baseEvidence.schema
const UID = schema.schemaUid

const payload: CredentialPayload = {
  xcsVersion: '0.1',
  issuer: ISSUER,
  subject: SUBJECT,
  schema: UID,
  claims: { programId: 'xrpl-101' },
}
const payloadText = canonicalJson(payload)
const uri = createHttpsPayloadUri('https://issuer.example/credential.json', payloadText)

const generation: CredentialGenerationRow = {
  profileId: 'testnet',
  generationId: 'c'.repeat(64),
  ledgerObjectId: 'd'.repeat(64),
  issuer: ISSUER,
  subject: SUBJECT,
  schemaUid: UID,
  uriHex: Buffer.from(uri, 'utf8').toString('hex'),
  expiration: null,
  accepted: true,
  createdLedgerIndex: 101,
  createdTransactionIndex: 0,
  lastLedgerIndex: 102,
  deletedLedgerIndex: null,
  deletionCause: null,
  createdAt: NOW,
  updatedAt: NOW,
}

const checkpoint: LedgerCheckpointRow = {
  profileId: 'testnet',
  ledgerIndex: 102,
  ledgerHash: 'e'.repeat(64),
  parentHash: 'f'.repeat(64),
  closeTime: NOW_RIPPLE - 10,
  transactionCount: 0,
  transactionRoot: '1'.repeat(64),
  processedAt: NOW,
}
const readyStatus: IndexerStatusRow = {
  profileId: 'testnet',
  state: 'ready',
  primarySourceTip: 102,
  secondarySourceTip: 102,
  lastAgreedLedgerIndex: 102,
  lastAgreedLedgerHash: checkpoint.ledgerHash,
  errorCode: null,
  writerId: 'writer-1',
  writerEpoch: 1,
  leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  updatedAt: NOW,
}
const network: NetworkProfileRow = {
  profileId: 'testnet',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: '2'.repeat(64),
  registryAddress: ISSUER,
  registrationAmountDrops: 1,
  activationLedgerIndex: 1,
  activationLedgerHash: '3'.repeat(64),
  enabled: true,
  createdAt: NOW,
}

class VerificationRepository implements ApiRepository {
  snapshotCalls = 0

  constructor(
    private readonly credential: CredentialGenerationRow | undefined,
    private readonly schemaRow: SchemaRow | undefined,
    private readonly checkpointRow: LedgerCheckpointRow | null = checkpoint,
    private readonly statusRow: IndexerStatusRow | null = readyStatus,
    private readonly schemaEvidence: readonly SchemaProjectionEvidence[] = schemaRow === undefined
      ? []
      : [{ ...baseEvidence, schema: schemaRow }],
  ) {}

  async withConsistentSnapshot<T>(callback: (repository: ApiRepository) => Promise<T>): Promise<T> {
    this.snapshotCalls += 1
    return callback(this)
  }
  async getDatabaseTime() {
    return NOW
  }
  async ping() {}
  async listNetworks(): Promise<NetworkProfileRow[]> {
    return []
  }
  async getNetwork(profileId: string): Promise<NetworkProfileRow | undefined> {
    return profileId === network.profileId ? network : undefined
  }
  async getIndexerStatus() {
    return this.statusRow ?? undefined
  }
  async getLatestCheckpoint() {
    return this.checkpointRow ?? undefined
  }
  async getSchema() {
    return this.schemaRow
  }
  async getSchemaProjectionEvidence(
    input: Parameters<ApiRepository['getSchemaProjectionEvidence']>[0],
  ): Promise<SchemaProjectionEvidence[]> {
    return this.schemaEvidence.filter(
      (item) =>
        item.schema.profileId === input.profileId &&
        input.schemaUids.includes(item.schema.schemaUid),
    )
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
  async searchSchemas(): Promise<SchemaRow[]> {
    return []
  }
  async listSchemaRegistrations(): Promise<SchemaEventRow[]> {
    return []
  }
  async getDiscoveryStats(): Promise<Awaited<ReturnType<ApiRepository['getDiscoveryStats']>>> {
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
  async getCredential() {
    return this.credential
  }
  async getCredentialGenerationById() {
    return this.credential
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
  async getCredentialEventsByGeneration(): Promise<CredentialEventRow[]> {
    return []
  }
  async getTransactionProjectionSummary(): Promise<
    Awaited<ReturnType<ApiRepository['getTransactionProjectionSummary']>>
  > {
    return {
      registration: undefined,
      firstCredentialEvent: undefined,
      credentialEventCount: 0,
    }
  }
  async getCredentialEventsByTransactionPage(): Promise<CredentialEventRow[]> {
    return []
  }
}

const neverResolver: PayloadResolver = {
  resolve: async () => {
    throw new Error('resolver should not be called')
  },
}

const request = {
  network: 'testnet',
  issuer: ISSUER,
  subject: SUBJECT,
  schemaUid: UID,
}

function multiLevelEvidence() {
  const root = registeredProjection({
    definition: {
      xcsVersion: '0.1',
      name: 'Course',
      description: 'Course identifier',
      fields: { programId: { type: 'string' } },
    },
    fields: { programId: { type: 'string' } },
    lineage: [],
    ledgerIndex: 90,
    transactionIndex: 0,
    ledgerHash: '5'.repeat(64),
    transactionHash: '6'.repeat(64),
  })
  const middleDefinition: SchemaDefinition = {
    xcsVersion: '0.1',
    name: 'Named course',
    description: 'Course identifier and name',
    extends: root.schema.schemaUid,
    fields: { courseName: { type: 'string' } },
  }
  const middle = registeredProjection({
    definition: middleDefinition,
    fields: { programId: { type: 'string' }, courseName: { type: 'string' } },
    lineage: [root.schema.schemaUid],
    ledgerIndex: 91,
    transactionIndex: 0,
    ledgerHash: '7'.repeat(64),
    transactionHash: '8'.repeat(64),
  })
  const leafDefinition: SchemaDefinition = {
    xcsVersion: '0.1',
    name: 'Dated completion',
    description: 'Course completion with its issued date',
    extends: middle.schema.schemaUid,
    fields: { issuedAt: { type: 'string' } },
  }
  const leaf = registeredProjection({
    definition: leafDefinition,
    fields: {
      programId: { type: 'string' },
      courseName: { type: 'string' },
      issuedAt: { type: 'string' },
    },
    lineage: [root.schema.schemaUid, middle.schema.schemaUid],
    ledgerIndex: 92,
    transactionIndex: 0,
    ledgerHash: '9'.repeat(64),
    transactionHash: 'a'.repeat(64),
  })
  return { root, middle, leaf }
}

describe('verifyCredential', () => {
  it('reads projections and authority evidence from one repository snapshot', async () => {
    const repository = new VerificationRepository(generation, schema)

    await verifyCredential(request, {
      repository,
      resolver: neverResolver,
      trustPolicy: new StaticTrustPolicy(),
      ...FRESHNESS,
    })

    expect(repository.snapshotCalls).toBe(1)
  })

  it('rejects a missing network from inside the same repository snapshot', async () => {
    const repository = new VerificationRepository(generation, schema)

    await expect(
      verifyCredential(
        { ...request, network: 'missing' },
        {
          repository,
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_NOT_FOUND', statusCode: 404 })
    expect(repository.snapshotCalls).toBe(1)
  })

  it('reports independent on-chain, schema, payload and trust results', async () => {
    await expect(
      verifyCredential(
        { ...request, payload },
        {
          repository: new VerificationRepository(generation, schema),
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy({ trusted: [ISSUER] }),
          ...FRESHNESS,
        },
      ),
    ).resolves.toEqual({
      onChain: 'active',
      schema: 'valid',
      payload: 'valid',
      issuerTrust: 'trusted',
      generationId: generation.generationId,
    })
  })

  it('fails closed when an indexed expiration exceeds the XRPL uint32 range', async () => {
    await expect(
      verifyCredential(request, {
        repository: new VerificationRepository(
          { ...generation, expiration: 4_294_967_296 },
          schema,
        ),
        resolver: neverResolver,
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      }),
    ).rejects.toMatchObject({ code: 'INDEXER_EVIDENCE_INVALID', statusCode: 503 })
  })

  it('fails closed when indexed deletion evidence contradicts the lifecycle timeline', async () => {
    await expect(
      verifyCredential(request, {
        repository: new VerificationRepository(
          { ...generation, deletedLedgerIndex: generation.lastLedgerIndex, deletionCause: null },
          schema,
        ),
        resolver: neverResolver,
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      }),
    ).rejects.toMatchObject({ code: 'INDEXER_EVIDENCE_INVALID', statusCode: 503 })
  })

  it('fails closed when an authoritative schema projection drops required fields', async () => {
    const corruptedSchema: SchemaRow = {
      ...schema,
      resolvedDefinition: {
        ...resolved,
        fields: {},
      } as unknown as Record<string, unknown>,
    }

    await expect(
      verifyCredential(
        { ...request, payload: { ...payload, claims: {} } },
        {
          repository: new VerificationRepository(generation, corruptedSchema),
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_PROJECTION_INVALID', statusCode: 503 })
  })

  it('accepts a coherent multi-level inherited schema projection', async () => {
    const hierarchy = multiLevelEvidence()

    await expect(
      verifyCredential(
        { ...request, schemaUid: hierarchy.leaf.schema.schemaUid },
        {
          repository: new VerificationRepository(
            undefined,
            hierarchy.leaf.schema,
            checkpoint,
            readyStatus,
            [hierarchy.root, hierarchy.middle, hierarchy.leaf],
          ),
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ).resolves.toMatchObject({ schema: 'valid', payload: 'not_checked' })
  })

  it.each(['ancestor type altered', 'inherited field missing', 'inherited field added'] as const)(
    'fails closed when a multi-level projection has an %s',
    async (corruption) => {
      const hierarchy = multiLevelEvidence()
      let evidence: SchemaProjectionEvidence[] = [hierarchy.root, hierarchy.middle, hierarchy.leaf]
      if (corruption === 'ancestor type altered') {
        const definition = {
          ...hierarchy.middle.schema.definition,
          fields: { courseName: { type: 'bool' } },
        }
        evidence = evidence.map((item) =>
          item === hierarchy.middle
            ? {
                ...item,
                schema: {
                  ...item.schema,
                  definition,
                  resolvedDefinition: {
                    definition,
                    fields: { programId: { type: 'string' }, courseName: { type: 'bool' } },
                    lineage: [hierarchy.root.schema.schemaUid],
                  },
                },
              }
            : item,
        )
      } else {
        const fields = {
          ...(corruption === 'inherited field added'
            ? { programId: { type: 'string' as const } }
            : {}),
          courseName: { type: 'string' },
          issuedAt: { type: 'string' },
          ...(corruption === 'inherited field added'
            ? { unexpected: { type: 'string' as const } }
            : {}),
        }
        evidence = evidence.map((item) =>
          item === hierarchy.leaf
            ? {
                ...item,
                schema: {
                  ...item.schema,
                  resolvedDefinition: {
                    ...(item.schema.resolvedDefinition as unknown as ResolvedSchema),
                    fields,
                  },
                },
              }
            : item,
        )
      }
      const leaf = evidence.at(-1)!.schema

      await expect(
        verifyCredential(
          { ...request, schemaUid: leaf.schemaUid },
          {
            repository: new VerificationRepository(
              undefined,
              leaf,
              checkpoint,
              readyStatus,
              evidence,
            ),
            resolver: neverResolver,
            trustPolicy: new StaticTrustPolicy(),
            ...FRESHNESS,
          },
        ),
      ).rejects.toMatchObject({ code: 'SCHEMA_PROJECTION_INVALID', statusCode: 503 })
    },
  )

  it('distinguishes a valid payload whose digest was changed', async () => {
    const changed = {
      ...payload,
      claims: { programId: 'different' },
    }
    const report = await verifyCredential(
      { ...request, payload: changed },
      {
        repository: new VerificationRepository(generation, schema),
        resolver: neverResolver,
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      },
    )
    expect(report.payload).toBe('tampered')
  })

  it('uses the same integrity-first precedence for direct and resolved payloads', async () => {
    const wrongSubject = {
      ...payload,
      subject: ISSUER,
    }
    const resolvedBytes = new TextEncoder().encode(canonicalJson(wrongSubject))
    const repository = new VerificationRepository(generation, schema)

    const [direct, resolvedReport] = await Promise.all([
      verifyCredential(
        { ...request, payload: wrongSubject },
        {
          repository,
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
      verifyCredential(
        { ...request, resolvePayload: true },
        {
          repository,
          resolver: { resolve: async () => resolvedBytes },
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ])

    expect(direct.payload).toBe('tampered')
    expect(resolvedReport.payload).toBe(direct.payload)
  })

  it('reports an unreachable resolved payload as unavailable', async () => {
    const report = await verifyCredential(
      { ...request, resolvePayload: true },
      {
        repository: new VerificationRepository(generation, schema),
        resolver: {
          resolve: async () => {
            throw new PayloadUnavailableError('offline')
          },
        },
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      },
    )
    expect(report.payload).toBe('unavailable')
  })

  it('reports an observed oversized resolved payload as invalid', async () => {
    const report = await verifyCredential(
      { ...request, resolvePayload: true },
      {
        repository: new VerificationRepository(generation, schema),
        resolver: {
          resolve: async () => {
            throw new PayloadInvalidError('too large')
          },
        },
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      },
    )
    expect(report.payload).toBe('invalid')
  })

  it('does not hide an unexpected resolver failure as invalid payload evidence', async () => {
    await expect(
      verifyCredential(
        { ...request, resolvePayload: true },
        {
          repository: new VerificationRepository(generation, schema),
          resolver: {
            resolve: async () => {
              throw new Error('resolver invariant failed')
            },
          },
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ).rejects.toThrow('resolver invariant failed')
  })

  it('fails closed without network access when server-side fetching is disabled', async () => {
    const report = await verifyCredential(
      { ...request, resolvePayload: true },
      {
        repository: new VerificationRepository(generation, schema),
        resolver: new DisabledPayloadResolver(),
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      },
    )
    expect(report.payload).toBe('unavailable')
  })

  it('reports not_found without collapsing the other dimensions', async () => {
    const report = await verifyCredential(request, {
      repository: new VerificationRepository(undefined, schema),
      resolver: neverResolver,
      trustPolicy: new StaticTrustPolicy(),
      ...FRESHNESS,
    })
    expect(report).toMatchObject({
      onChain: 'not_found',
      schema: 'valid',
      payload: 'not_checked',
      issuerTrust: 'unknown',
    })
  })

  it.each([
    ['stale', NOW_RIPPLE - 121],
    ['too far in the future', NOW_RIPPLE + 31],
  ])('fails closed when the indexed proof is %s', async (_label, closeTime) => {
    const repository = new VerificationRepository(generation, schema, {
      ...checkpoint,
      closeTime,
    })
    await expect(
      verifyCredential(
        { ...request, resolvePayload: true },
        {
          repository,
          resolver: neverResolver,
          trustPolicy: new StaticTrustPolicy(),
          ...FRESHNESS,
        },
      ),
    ).rejects.toMatchObject({ code: 'INDEXER_STALE', statusCode: 503 })
  })

  it('fails closed when the indexer has no checkpoint', async () => {
    await expect(
      verifyCredential(request, {
        repository: new VerificationRepository(generation, schema, null),
        resolver: neverResolver,
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      }),
    ).rejects.toMatchObject({ code: 'INDEXER_NOT_INITIALIZED', statusCode: 503 })
  })

  it.each([
    ['missing', null, 'INDEXER_STATUS_UNAVAILABLE'],
    ['starting', { ...readyStatus, state: 'starting' as const }, 'INDEXER_NOT_READY'],
    ['catching up', { ...readyStatus, state: 'catching_up' as const }, 'INDEXER_NOT_READY'],
    [
      'halted',
      { ...readyStatus, state: 'halted' as const, errorCode: 'LEDGER_SOURCE_DIVERGENCE' },
      'INDEXER_HALTED',
    ],
  ])('fails closed before verification when durable status is %s', async (_label, status, code) => {
    const repository = new VerificationRepository(generation, schema, checkpoint, status)
    await expect(
      verifyCredential(request, {
        repository,
        resolver: neverResolver,
        trustPolicy: new StaticTrustPolicy(),
        ...FRESHNESS,
      }),
    ).rejects.toMatchObject({ code, statusCode: 503 })
  })
})
