import { computeSchemaUid, type CredentialPayload, type ResolvedSchema } from '@xcs-protocol/core'
import type {
  CredentialEventRow,
  CredentialGenerationRow,
  DemoPinRow,
  IndexerStatusRow,
  LedgerCheckpointRow,
  NetworkProfileRow,
  PinChallengeRow,
  SchemaEventRow,
  SchemaRow,
} from '@xcs-protocol/db'
import { describe, expect, it } from 'vitest'

import { DemoPinningService, PinningError } from '../src/pinning.js'
import { canonicalJson } from '../src/serialization.js'
import type {
  ApiRepository,
  ContentPinStore,
  PinningRepository,
  SchemaProjectionEvidence,
} from '../src/types.js'

const NOW = new Date('2026-08-19T00:00:00.000Z')
const NOW_RIPPLE = Math.floor(NOW.getTime() / 1_000) - 946_684_800
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'rLs1MzkFWCxTbuAHgjeTZK4fcCDDnf2KRv'
const PUBLIC_KEY = `ED${'0'.repeat(64)}`
const SIGNATURE = '0'.repeat(128)

const resolved: ResolvedSchema = {
  definition: {
    xcsVersion: '0.1',
    name: 'Completion',
    description: 'Course completion',
    fields: { name: { type: 'string' }, prenom: { type: 'string', optional: true } },
  },
  fields: { name: { type: 'string' }, prenom: { type: 'string', optional: true } },
  lineage: [],
}
const SCHEMA_LEDGER_HASH = 'e'.repeat(64)
const UID = computeSchemaUid({
  schema: resolved.definition,
  networkId: 1,
  ledgerHash: SCHEMA_LEDGER_HASH,
  ledgerIndex: 1,
  transactionIndex: 0,
  publisher: ISSUER,
})
const schema: SchemaRow = {
  profileId: 'testnet',
  schemaUid: UID,
  publisher: ISSUER,
  name: 'Completion',
  description: 'Course completion',
  parentUid: null,
  supersedesUid: null,
  definition: resolved.definition as unknown as Record<string, unknown>,
  resolvedDefinition: resolved as unknown as Record<string, unknown>,
  registrationTransactionHash: 'b'.repeat(64),
  ledgerIndex: 1,
  transactionIndex: 0,
  registeredAt: NOW,
}
const baseEvidence: SchemaProjectionEvidence = {
  schema,
  registration: {
    profileId: 'testnet',
    transactionHash: schema.registrationTransactionHash,
    ledgerIndex: schema.ledgerIndex,
    ledgerHash: SCHEMA_LEDGER_HASH,
    transactionIndex: schema.transactionIndex,
    publisher: ISSUER,
    status: 'accepted',
    reasonCode: null,
    schemaUid: UID,
    memoJson: resolved.definition,
    recordedAt: NOW,
  },
}
const network: NetworkProfileRow = {
  profileId: 'testnet',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'c'.repeat(64),
  registryAddress: ISSUER,
  registrationAmountDrops: 1,
  activationLedgerIndex: 1,
  activationLedgerHash: 'd'.repeat(64),
  enabled: true,
  createdAt: NOW,
}
const checkpoint: LedgerCheckpointRow = {
  profileId: 'testnet',
  ledgerIndex: 10,
  ledgerHash: 'f'.repeat(64),
  parentHash: '1'.repeat(64),
  closeTime: NOW_RIPPLE - 10,
  transactionCount: 0,
  transactionRoot: '2'.repeat(64),
  processedAt: NOW,
}
const readyStatus: IndexerStatusRow = {
  profileId: 'testnet',
  state: 'ready',
  primarySourceTip: checkpoint.ledgerIndex,
  secondarySourceTip: checkpoint.ledgerIndex,
  lastAgreedLedgerIndex: checkpoint.ledgerIndex,
  lastAgreedLedgerHash: checkpoint.ledgerHash,
  errorCode: null,
  writerId: 'writer-1',
  writerEpoch: 1,
  leaseExpiresAt: new Date(NOW.getTime() + 60_000),
  updatedAt: NOW,
}

class FakeApiRepository implements ApiRepository {
  snapshotCalls = 0

  constructor(
    private readonly configuredNetwork: NetworkProfileRow = network,
    private readonly configuredSchema: SchemaRow | null = schema,
    private readonly configuredEvidence: readonly SchemaProjectionEvidence[] = configuredSchema ===
    null
      ? []
      : [{ ...baseEvidence, schema: configuredSchema }],
    private readonly configuredStatus: IndexerStatusRow | null = readyStatus,
    private readonly configuredCheckpoint: LedgerCheckpointRow | null = checkpoint,
    private readonly databaseNow: Date = NOW,
  ) {}

  async withConsistentSnapshot<T>(callback: (repository: ApiRepository) => Promise<T>): Promise<T> {
    this.snapshotCalls += 1
    return callback(this)
  }
  async getDatabaseTime() {
    return this.databaseNow
  }
  async ping() {}
  async listNetworks() {
    return [this.configuredNetwork]
  }
  async getNetwork(profileId: string) {
    return profileId === 'testnet' ? this.configuredNetwork : undefined
  }
  async getIndexerStatus(): Promise<IndexerStatusRow | undefined> {
    return this.configuredStatus ?? undefined
  }
  async getLatestCheckpoint(): Promise<LedgerCheckpointRow | undefined> {
    return this.configuredCheckpoint ?? undefined
  }
  async getSchema(_profileId: string, uid: string) {
    return this.configuredSchema !== null && uid === this.configuredSchema.schemaUid
      ? this.configuredSchema
      : undefined
  }
  async getSchemaProjectionEvidence(
    input: Parameters<ApiRepository['getSchemaProjectionEvidence']>[0],
  ): Promise<SchemaProjectionEvidence[]> {
    return this.configuredEvidence.filter(
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
  async getCredential(): Promise<CredentialGenerationRow | undefined> {
    return undefined
  }
  async getCredentialGenerationById(): Promise<CredentialGenerationRow | undefined> {
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

class FakePinningRepository implements PinningRepository {
  challenge: PinChallengeRow | undefined
  pin: DemoPinRow | undefined
  deletedChallenges = 0
  attempts = 0
  async createChallenge(input: Parameters<PinningRepository['createChallenge']>[0]) {
    this.challenge = { ...input, usedAt: null, createdAt: NOW }
    return this.challenge
  }
  async getChallenge() {
    return this.challenge
  }
  async reservePin(input: Parameters<PinningRepository['reservePin']>[0]) {
    if (this.challenge?.usedAt !== null) throw new PinningError('CHALLENGE_USED', 409)
    if (this.challenge === undefined) throw new PinningError('CHALLENGE_NOT_FOUND', 404)
    if (this.attempts >= input.dailyLimit) {
      throw new PinningError('WALLET_QUOTA_EXCEEDED', 429)
    }
    this.attempts += 1
    this.challenge.usedAt = input.now
    this.pin = {
      pinId: input.pinId,
      challengeId: input.challengeId,
      profileId: input.profileId,
      wallet: input.wallet,
      requesterIpHash: input.requesterIpHash,
      cid: input.cid,
      byteLength: input.byteLength,
      status: 'pending',
      failureCode: null,
      expiresAt: input.expiresAt,
      unpinnedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    return this.pin
  }
  async markPinned(_pinId: string, now: Date) {
    if (this.pin !== undefined) {
      this.pin.status = 'pinned'
      this.pin.updatedAt = now
    }
  }
  async markFailed(_pinId: string, failureCode: string, now: Date) {
    if (this.pin !== undefined) {
      this.pin.status = 'failed'
      this.pin.failureCode = failureCode
      this.pin.updatedAt = now
    }
  }
  async findExpiredPins(): Promise<DemoPinRow[]> {
    return []
  }
  async hasOtherActivePin(): Promise<boolean> {
    return false
  }
  async markUnpinned() {}
  async deleteExpiredUnreferencedChallenges() {
    this.deletedChallenges += 1
    return 1
  }
}

class FakeStore implements ContentPinStore {
  cid: string | undefined
  constructor(private readonly fail = false) {}
  async putRaw(_content: Uint8Array, expectedCid: string) {
    if (this.fail) throw new Error('Kubo unavailable')
    this.cid = expectedCid
  }
  async unpin() {}
}

function service(
  options: {
    storeFails?: boolean
    networkId?: number
    schemaRow?: SchemaRow | null
    status?: IndexerStatusRow | null
    checkpoint?: LedgerCheckpointRow | null
    databaseNow?: Date
  } = {},
) {
  const repository = new FakePinningRepository()
  const store = new FakeStore(options.storeFails)
  const apiRepository = new FakeApiRepository(
    { ...network, networkId: options.networkId ?? 1 },
    options.schemaRow === undefined ? schema : options.schemaRow,
    undefined,
    options.status === undefined ? readyStatus : options.status,
    options.checkpoint === undefined ? checkpoint : options.checkpoint,
    options.databaseNow,
  )
  return {
    repository,
    store,
    apiRepository,
    service: new DemoPinningService({
      repository,
      apiRepository,
      store,
      ipHashSecret: 'x'.repeat(32),
      enabledNetworks: new Set(['testnet']),
      now: () => new Date(NOW),
      verifyWalletSignature: () => true,
    }),
  }
}

function validPayloadBase64(): string {
  const payload: CredentialPayload = {
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: UID,
    claims: { name: 'XRPL 101' },
  }
  return Buffer.from(canonicalJson(payload)).toString('base64')
}

async function attemptValidPin(fixture: ReturnType<typeof service>) {
  const challenge = await fixture.service.createChallenge({
    network: 'testnet',
    wallet: ISSUER,
    ipAddress: '203.0.113.42',
  })
  return fixture.service.pin({
    network: 'testnet',
    wallet: ISSUER,
    challengeId: challenge.challengeId,
    publicKey: PUBLIC_KEY,
    signature: SIGNATURE,
    payloadBase64: validPayloadBase64(),
    ipAddress: '203.0.113.42',
  })
}

describe('demo pinning', () => {
  it('refuses pinning on a non-Testnet network even if it is configured', async () => {
    const fixture = service({ networkId: 0 })
    await expect(
      fixture.service.createChallenge({
        network: 'testnet',
        wallet: ISSUER,
        ipAddress: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ code: 'PINNING_NETWORK_DISABLED', statusCode: 404 })
  })

  it('stores only an HMAC of the requester IP in a one-shot challenge', async () => {
    const fixture = service()
    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })
    expect(challenge.message).toContain(`wallet:${ISSUER}`)
    expect(fixture.repository.challenge?.requesterIpHash).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.repository.challenge?.requesterIpHash).not.toContain('203.0.113.42')
  })

  it('pins canonical payload bytes as a CIDv1 raw block for 90 days', async () => {
    const fixture = service()
    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })
    const result = await fixture.service.pin({
      network: 'testnet',
      wallet: ISSUER,
      challengeId: challenge.challengeId,
      publicKey: PUBLIC_KEY,
      signature: SIGNATURE,
      payloadBase64: validPayloadBase64(),
      ipAddress: '203.0.113.42',
    })
    expect(result.uri).toMatch(/^ipfs:\/\/b[a-z2-7]+$/)
    expect(fixture.store.cid).toBe(result.cid)
    expect(fixture.repository.pin?.status).toBe('pinned')
    expect(fixture.apiRepository.snapshotCalls).toBe(1)
    expect(Date.parse(result.expiresAt) - NOW.getTime()).toBe(90 * 24 * 60 * 60 * 1_000)
  })

  it('rejects person-shaped fields before reserving or publicly storing a pin', async () => {
    const fixture = service()
    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })
    const content = canonicalJson({
      xcsVersion: '0.1',
      issuer: ISSUER,
      subject: SUBJECT,
      schema: UID,
      claims: { name: 'XRPL 101', prenom: 'Personne Test' },
    })

    await expect(
      fixture.service.pin({
        network: 'testnet',
        wallet: ISSUER,
        challengeId: challenge.challengeId,
        publicKey: PUBLIC_KEY,
        signature: SIGNATURE,
        payloadBase64: Buffer.from(content).toString('base64'),
        ipAddress: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ code: 'DEMO_PIN_PII_FIELD_FORBIDDEN', statusCode: 400 })
    expect(fixture.repository.attempts).toBe(0)
    expect(fixture.repository.challenge?.usedAt).toBeNull()
    expect(fixture.store.cid).toBeUndefined()
  })

  it.each([
    {
      label: 'indexer status is absent',
      options: { status: null },
      code: 'INDEXER_STATUS_UNAVAILABLE',
    },
    {
      label: 'checkpoint is absent',
      options: { checkpoint: null },
      code: 'INDEXER_NOT_INITIALIZED',
    },
    {
      label: 'writer lease is absent',
      options: {
        status: {
          ...readyStatus,
          writerId: null,
          leaseExpiresAt: null,
        },
      },
      code: 'INDEXER_LEASE_EXPIRED',
    },
    {
      label: 'database time makes the checkpoint stale',
      options: {
        databaseNow: new Date(NOW.getTime() + 121_000),
        status: {
          ...readyStatus,
          leaseExpiresAt: new Date(NOW.getTime() + 300_000),
        },
      },
      code: 'INDEXER_STALE',
    },
    {
      label: 'indexer is halted',
      options: {
        status: {
          ...readyStatus,
          state: 'halted' as const,
          errorCode: 'LEDGER_SOURCE_DIVERGENCE',
        },
      },
      code: 'INDEXER_HALTED',
    },
    {
      label: 'indexer is halted while the schema is absent',
      options: {
        schemaRow: null,
        status: {
          ...readyStatus,
          state: 'halted' as const,
          errorCode: 'LEDGER_SOURCE_DIVERGENCE',
        },
      },
      code: 'INDEXER_HALTED',
    },
    {
      label: 'status and checkpoint disagree',
      options: {
        status: {
          ...readyStatus,
          lastAgreedLedgerHash: '0'.repeat(64),
        },
      },
      code: 'INDEXER_EVIDENCE_INVALID',
    },
  ])('fails closed before pin side effects when $label', async ({ options, code }) => {
    const fixture = service(options)

    await expect(attemptValidPin(fixture)).rejects.toMatchObject({ code, statusCode: 503 })
    expect(fixture.repository.attempts).toBe(0)
    expect(fixture.repository.pin).toBeUndefined()
    expect(fixture.repository.challenge?.usedAt).toBeNull()
    expect(fixture.store.cid).toBeUndefined()
  })

  it('fails closed before reserving a pin when the schema projection drops required fields', async () => {
    const fixture = service({
      schemaRow: {
        ...schema,
        resolvedDefinition: {
          ...resolved,
          fields: {},
        } as unknown as Record<string, unknown>,
      },
    })
    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })

    await expect(
      fixture.service.pin({
        network: 'testnet',
        wallet: ISSUER,
        challengeId: challenge.challengeId,
        publicKey: PUBLIC_KEY,
        signature: SIGNATURE,
        payloadBase64: Buffer.from(
          canonicalJson({
            xcsVersion: '0.1',
            issuer: ISSUER,
            subject: SUBJECT,
            schema: UID,
            claims: {},
          }),
        ).toString('base64'),
        ipAddress: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ code: 'SCHEMA_PROJECTION_INVALID', statusCode: 503 })
    expect(fixture.repository.pin).toBeUndefined()
    expect(fixture.store.cid).toBeUndefined()
  })

  it('rejects a payload over the 64 KiB demo limit before storage', async () => {
    const fixture = service()
    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })
    await expect(
      fixture.service.pin({
        network: 'testnet',
        wallet: ISSUER,
        challengeId: challenge.challengeId,
        publicKey: PUBLIC_KEY,
        signature: SIGNATURE,
        payloadBase64: Buffer.alloc(65 * 1024, 1).toString('base64'),
        ipAddress: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_SIZE_INVALID', statusCode: 413 })
  })

  it('runs bounded expired-challenge cleanup from the pin janitor', async () => {
    const fixture = service()
    await fixture.service.unpinExpired()
    expect(fixture.repository.deletedChallenges).toBe(1)
  })

  it('counts failed Kubo writes toward the daily attempt quota', async () => {
    const fixture = service({ storeFails: true })
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const challenge = await fixture.service.createChallenge({
        network: 'testnet',
        wallet: ISSUER,
        ipAddress: '203.0.113.42',
      })
      await expect(
        fixture.service.pin({
          network: 'testnet',
          wallet: ISSUER,
          challengeId: challenge.challengeId,
          publicKey: PUBLIC_KEY,
          signature: SIGNATURE,
          payloadBase64: validPayloadBase64(),
          ipAddress: '203.0.113.42',
        }),
      ).rejects.toMatchObject({ code: 'PIN_STORE_UNAVAILABLE' })
    }

    const challenge = await fixture.service.createChallenge({
      network: 'testnet',
      wallet: ISSUER,
      ipAddress: '203.0.113.42',
    })
    await expect(
      fixture.service.pin({
        network: 'testnet',
        wallet: ISSUER,
        challengeId: challenge.challengeId,
        publicKey: PUBLIC_KEY,
        signature: SIGNATURE,
        payloadBase64: validPayloadBase64(),
        ipAddress: '203.0.113.42',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_QUOTA_EXCEEDED', statusCode: 429 })
  })
})
