import { computeSchemaUid, encodeCredentialPayload, payloadDigest } from '#xcs/core/index.js'
import { buildCredentialCreate } from '#xcs/sdk/index.js'
import { describe, expect, it, vi } from 'vitest'
import { Wallet } from 'xrpl'

import {
  HostedPayloadService,
  hostedPayloadLocator,
  type HostedPayloadRecord,
  type HostedPayloadRepository,
} from '../../server/xcs/hosted-payloads.js'
import { HostedPayloadResolver } from '../../server/xcs/hosted-payload-resolver.js'
import type { ApiRepository } from '../../server/xcs/types.js'
import { createApiHandlers, type CreateApiOptions } from '../../server/xcs/handlers.js'
import { createInjector } from './inject.js'
import { DisabledPayloadResolver } from '../../server/xcs/payload-resolver.js'
import { StaticTrustPolicy } from '../../server/xcs/verification.js'
async function createApi(options: CreateApiOptions) {
  const handlers = createApiHandlers(options)
  return { inject: createInjector(handlers), close: () => handlers.close() }
}

// Test repositories model projection/storage boundaries; signatures and canonical payload validation are real.
function fixture(claims: Record<string, string> = { course: 'Test course' }) {
  const issuer = Wallet.generate()
  const subject = Wallet.generate().address
  const now = new Date()
  const fields = Object.fromEntries(
    Object.keys(claims).map((key) => [key, { type: 'string' as const }]),
  )
  const definition = {
    xcsVersion: '0.1' as const,
    name: 'Completion',
    description: 'Test only',
    fields,
  }
  const ledgerHash = 'a'.repeat(64)
  const uid = computeSchemaUid({
    schema: definition,
    networkId: 1,
    ledgerHash,
    ledgerIndex: 1,
    transactionIndex: 0,
    publisher: issuer.address,
  })
  const schema = {
    profileId: 'testnet',
    schemaUid: uid,
    publisher: issuer.address,
    name: definition.name,
    description: definition.description,
    parentUid: null,
    supersedesUid: null,
    definition,
    resolvedDefinition: { definition, fields, lineage: [] },
    ledgerIndex: 1,
    transactionIndex: 0,
    registrationTransactionHash: 'b'.repeat(64),
  }
  const evidence = {
    schema,
    registration: {
      profileId: 'testnet',
      transactionHash: schema.registrationTransactionHash,
      ledgerIndex: 1,
      ledgerHash,
      transactionIndex: 0,
      publisher: issuer.address,
      status: 'accepted',
      reasonCode: null,
      schemaUid: uid,
      memoJson: definition,
    },
  }
  const payload = encodeCredentialPayload(claims, {
    issuer: issuer.address,
    subject,
    schemaUid: uid,
    fields,
  })
  const digest = payloadDigest(payload.bytes)
  const locator = hostedPayloadLocator(digest)
  const uri = `https://payload.test/p/${locator}#xcs-sha256=${digest}`
  const transaction = buildCredentialCreate({
    issuer: issuer.address,
    subject,
    schemaUid: uid,
    uri,
  })
  const signed = issuer.sign({ ...transaction, Fee: '12', Sequence: 1, LastLedgerSequence: 20 })
  const event = { eventType: 'created', uriHex: transaction.URI, ledgerIndex: 2 }
  const api = {
    withConsistentSnapshot: async <T>(fn: (repository: ApiRepository) => Promise<T>) =>
      fn(api as unknown as ApiRepository),
    getNetwork: async () => ({
      profileId: 'testnet',
      xcsVersion: '0.1',
      networkId: 1,
      requiredAmendment: 'c'.repeat(64),
      registryAddress: issuer.address,
      registrationAmountDrops: 1,
      activationLedgerIndex: 1,
      activationLedgerHash: 'd'.repeat(64),
    }),
    getDatabaseTime: async () => now,
    getIndexerStatus: async () => ({
      profileId: 'testnet',
      state: 'ready',
      primarySourceTip: 10,
      secondarySourceTip: 10,
      lastAgreedLedgerIndex: 10,
      lastAgreedLedgerHash: ledgerHash,
      errorCode: null,
      writerId: 'test-writer',
      writerEpoch: 1,
      leaseExpiresAt: new Date(now.getTime() + 60000),
      updatedAt: now,
    }),
    getLatestCheckpoint: async () => ({
      profileId: 'testnet',
      ledgerIndex: 10,
      ledgerHash,
      closeTime: Math.floor(now.getTime() / 1000) - 946684800,
    }),
    getSchema: async () => schema,
    getSchemaProjectionEvidence: async () => [evidence],
    getCredentialEventsByTransaction: vi.fn(async () => [event]),
  }
  let stored: HostedPayloadRecord | undefined
  const repository: HostedPayloadRepository = {
    get: vi.fn(async () => stored),
    publish: vi.fn(async (input) => {
      stored = { locator: input.locator, digestHex: input.digestHex, content: input.content }
      return stored
    }),
  }
  const service = new HostedPayloadService({
    repository,
    apiRepository: api as unknown as ApiRepository,
    publicBaseUrl: 'https://payload.test',
    ipHashSecret: 'test-only-ip-hash-secret-000000000000',
    enabledNetworks: new Set(['testnet']),
  })
  const input = {
    network: 'testnet',
    locator,
    payloadBase64: Buffer.from(payload.bytes).toString('base64'),
    signedTransactionBlob: signed.tx_blob,
    ipAddress: '127.0.0.1',
  }
  return { service, repository, api, input, signed, payload, digest, uri }
}

describe('hosted public payload authorization', () => {
  it('serves the publication HTTP contract and immutable exact bytes', async () => {
    const f = fixture()
    const app = await createApi({
      repository: f.api as unknown as ApiRepository,
      resolver: new DisabledPayloadResolver(),
      trustPolicy: new StaticTrustPolicy(),
      hostedPayloadService: f.service,
    })
    try {
      const { ipAddress: _ip, locator, ...body } = f.input
      const publication = await app.inject({
        method: 'POST',
        url: `/v1/payloads/${locator}`,
        payload: body,
      })
      expect(publication.statusCode).toBe(200)
      expect(publication.json()).toMatchObject({ uri: f.uri })
      const payload = await app.inject({ method: 'GET', url: `/p/${locator}` })
      expect(payload.statusCode).toBe(200)
      expect(payload.body).toBe(f.payload.json)
      expect(payload.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(payload.headers.etag).toBe(`"${f.digest}"`)
      const oversized = await app.inject({
        method: 'POST',
        url: `/v1/payloads/${locator}`,
        payload: { ...body, payloadBase64: Buffer.alloc(65537).toString('base64') },
      })
      expect(oversized.statusCode).toBe(413)
      expect(oversized.json()).toMatchObject({ error: 'PAYLOAD_SIZE_INVALID' })
    } finally {
      await app.close()
    }
  })
  it('publishes exact canonical bytes with a valid indexed CredentialCreate signature', async () => {
    const f = fixture()
    expect(await f.service.publish(f.input)).toMatchObject({
      uri: f.uri,
      transactionHash: f.signed.hash.toLowerCase(),
      byteLength: f.payload.bytes.length,
    })
    expect(await f.service.get(f.input.locator)).toMatchObject({
      content: f.payload.json,
      digestHex: f.digest,
    })
    expect(f.api.getCredentialEventsByTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ transactionHash: f.signed.hash.toLowerCase() }),
    )
  })

  it.each(['!!!=', '', 'e30'])(
    'rejects malformed base64 before storage: %s',
    async (payloadBase64) => {
      const f = fixture()
      await expect(f.service.publish({ ...f.input, payloadBase64 })).rejects.toMatchObject({
        code: 'PAYLOAD_BASE64_INVALID',
      })
      expect(f.repository.publish).not.toHaveBeenCalled()
    },
  )

  it('rejects decoded payloads larger than 64 KiB before signature or storage', async () => {
    const f = fixture()
    await expect(
      f.service.publish({ ...f.input, payloadBase64: Buffer.alloc(65537).toString('base64') }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_SIZE_INVALID', statusCode: 413 })
    expect(f.repository.publish).not.toHaveBeenCalled()
  })

  it('rejects unsigned data and altered signed transaction bytes', async () => {
    const f = fixture()
    for (const blob of [
      '00',
      f.signed.tx_blob.slice(0, -2) + (f.signed.tx_blob.endsWith('FF') ? '00' : 'FF'),
    ]) {
      await expect(
        f.service.publish({ ...f.input, signedTransactionBlob: blob }),
      ).rejects.toMatchObject({ code: 'SIGNED_TRANSACTION_INVALID' })
    }
    expect(f.repository.publish).not.toHaveBeenCalled()
  })

  it('requires exactly one matching indexed creation event before publication', async () => {
    const f = fixture()
    f.api.getCredentialEventsByTransaction.mockResolvedValue([])
    await expect(f.service.publish(f.input)).rejects.toMatchObject({
      code: 'SIGNED_TRANSACTION_NOT_INDEXED',
      statusCode: 409,
    })
    f.api.getCredentialEventsByTransaction.mockResolvedValue([
      { eventType: 'created', uriHex: '00', ledgerIndex: 2 },
    ])
    await expect(f.service.publish(f.input)).rejects.toMatchObject({
      code: 'SIGNED_TRANSACTION_NOT_INDEXED',
    })
    expect(f.repository.publish).not.toHaveBeenCalled()
  })

  it("rejects another valid signer's transaction and duplicate projection events", async () => {
    const f = fixture()
    const other = fixture()
    await expect(
      f.service.publish({ ...f.input, signedTransactionBlob: other.input.signedTransactionBlob }),
    ).rejects.toMatchObject({ code: 'SIGNED_TRANSACTION_PAYLOAD_MISMATCH' })
    const events = await f.api.getCredentialEventsByTransaction()
    f.api.getCredentialEventsByTransaction.mockResolvedValue([...events, ...events])
    await expect(f.service.publish(f.input)).rejects.toMatchObject({
      code: 'SIGNED_TRANSACTION_NOT_INDEXED',
    })
    expect(f.repository.publish).not.toHaveBeenCalled()
  })

  it('publishes schema-valid synthetic claims regardless of field names', async () => {
    const f = fixture({
      prenom: 'Fictional',
      firstname: 'Synthetic',
      email: 'test@example.invalid',
    })
    await f.service.publish(f.input)
    expect(await f.service.get(f.input.locator)).toMatchObject({
      content: f.payload.json,
    })
  })

  it('keeps publication restricted to allowed Testnet profiles', async () => {
    const f = fixture({ prenom: 'fictional' })
    await expect(f.service.publish({ ...f.input, network: 'mainnet' })).rejects.toMatchObject({
      code: 'PAYLOAD_HOSTING_NETWORK_DISABLED',
    })
    expect(f.repository.publish).not.toHaveBeenCalled()
  })

  it('resolves its own immutable hosted URLs directly and delegates other origins', async () => {
    const f = fixture()
    await f.service.publish(f.input)
    const external = { resolve: vi.fn(async () => new Uint8Array([1])) }
    const resolver = new HostedPayloadResolver('https://payload.test', f.service, external)
    expect(await resolver.resolve(f.uri)).toEqual(f.payload.bytes)
    expect(external.resolve).not.toHaveBeenCalled()
    await resolver.resolve(f.uri.replace('payload.test', 'other.test'))
    expect(external.resolve).toHaveBeenCalledOnce()
  })
})
