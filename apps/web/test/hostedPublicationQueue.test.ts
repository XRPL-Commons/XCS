import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '#xcs/core/index.js'
import {
  assertHostedPayloadSize,
  createHostedPayloadLocation,
  encodePayloadBase64,
  HOSTED_PAYLOAD_MAX_BYTES,
} from '../app/utils/hostedPayload'
import { createHostedPublicationQueue } from '../app/utils/hostedPublicationQueue'
import type { StoredOperation } from '../app/utils/operationJournal'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  clear() {
    this.values.clear()
  }
}

const canonicalPayload = canonicalJson({ claims: { course: 'synthetic-course' } })
const location = createHostedPayloadLocation('https://payload.example', canonicalPayload)
const draft = {
  network: 'testnet',
  canonicalPayload,
  locator: location.locator,
  credentialUri: location.credentialUri,
}
// Transport fixtures only: the real API independently validates signed blobs.
const signature = { txHash: 'AB'.repeat(32), txBlob: 'AB'.repeat(200) }
const receipt = {
  ...location,
  uri: location.credentialUri,
  byteLength: new TextEncoder().encode(canonicalPayload).byteLength,
  transactionHash: signature.txHash,
}
const readPayload = async () =>
  new Response(canonicalPayload, {
    headers: { 'content-type': 'application/json' },
  })

describe('hosted payload size before signing', () => {
  it('uses canonical UTF-8 bytes, rejecting oversized content before constructing its location', () => {
    const exact = 'é'.repeat(HOSTED_PAYLOAD_MAX_BYTES / 2)
    expect(() => assertHostedPayloadSize(exact)).not.toThrow()
    expect(encodePayloadBase64(exact).length).toBeLessThanOrEqual(90_000)
    expect(() => createHostedPayloadLocation('https://payload.example', exact + 'a')).toThrow(
      'PAYLOAD_SIZE_INVALID',
    )
    expect(() => encodePayloadBase64(exact + 'a')).toThrow('PAYLOAD_SIZE_INVALID')
    expect(() => assertHostedPayloadSize('')).toThrow('PAYLOAD_SIZE_INVALID')
  })
})

describe('reload-safe hosted publication queue', () => {
  it('retains the exact consented bytes before signing, and refuses publication without a signature', async () => {
    const storage = new MemoryStorage()
    const job = createHostedPublicationQueue(storage).begin(draft)
    const reloaded = createHostedPublicationQueue(storage)
    expect(reloaded.list()).toEqual([job])
    const publish = vi.fn()
    await expect(reloaded.publish(job.id, publish)).rejects.toThrow(
      'PAYLOAD_RECOVERY_SIGNATURE_MISSING',
    )
    expect(publish).not.toHaveBeenCalled()
    expect(reloaded.list()).toHaveLength(1)
  })

  it('survives reload and an indexing timeout, retrying the same publication without a signer or submission', async () => {
    const storage = new MemoryStorage()
    const queue = createHostedPublicationQueue(storage)
    const job = queue.begin(draft)
    queue.signed(job.id, signature)
    const reloaded = createHostedPublicationQueue(storage)
    const publish = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: 'SIGNED_TRANSACTION_NOT_INDEXED' } })
      .mockResolvedValue(receipt)
    await expect(reloaded.publish(job.id, publish, readPayload)).rejects.toThrow(
      'SIGNED_TRANSACTION_NOT_INDEXED',
    )
    expect(reloaded.list()[0]?.payload.signedTransactionBlob).toBe(signature.txBlob)
    const proof = await reloaded.publish(job.id, publish, readPayload)
    expect(proof.credentialUri).toBe(location.credentialUri)
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1])
    expect(publish).toHaveBeenLastCalledWith({
      network: draft.network,
      locator: draft.locator,
      payloadBase64: encodePayloadBase64(canonicalPayload),
      signedTransactionBlob: signature.txBlob,
    })
    expect(reloaded.list()).toEqual([])
  })

  it('retains recovery until the uploaded bytes and receipt have both been verified', async () => {
    const storage = new MemoryStorage()
    const queue = createHostedPublicationQueue(storage)
    const job = queue.begin(draft)
    queue.signed(job.id, signature)
    await expect(
      queue.publish(
        job.id,
        async () => ({ ...receipt, transactionHash: 'CD'.repeat(32) }),
        readPayload,
      ),
    ).rejects.toThrow('SIGNED_TRANSACTION_PAYLOAD_MISMATCH')
    await expect(
      queue.publish(
        job.id,
        async () => receipt,
        async () => {
          throw new Error('offline')
        },
      ),
    ).rejects.toThrow('PAYLOAD_FETCH_FAILED')
    expect(queue.list()).toHaveLength(1)
  })

  it('fails before signing when browser storage refuses the recovery copy', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => {
      throw new Error('quota')
    }
    expect(() => createHostedPublicationQueue(storage).begin(draft)).toThrow(
      'PAYLOAD_RECOVERY_STORAGE_UNAVAILABLE',
    )
  })

  it('keeps separate jobs across tabs and never evicts pending publication data', () => {
    const storage = new MemoryStorage()
    const first = createHostedPublicationQueue(storage)
    const second = createHostedPublicationQueue(storage)
    const jobs = Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).begin(draft))
    expect(() => first.begin(draft)).toThrow('PAYLOAD_RECOVERY_QUEUE_FULL')
    expect(second.list()).toHaveLength(20)
    first.remove(jobs[0]!.id)
    expect(second.list()).toHaveLength(19)
  })

  it('isolates corrupt recovery instead of publishing modified bytes or blocking other jobs', () => {
    const storage = new MemoryStorage()
    const queue = createHostedPublicationQueue(storage)
    const job = queue.begin(draft)
    storage.setItem(
      storage.key(0)!,
      JSON.stringify({ ...job, payload: { ...job.payload, canonicalPayload: '{}' } }),
    )
    const good = queue.begin(draft)
    expect(queue.list()).toEqual([good])
    expect(queue.inspect().invalidKeys).toHaveLength(1)
    queue.removeInvalid(queue.inspect().invalidKeys[0]!)
    expect(queue.inspect().invalidKeys).toEqual([])
    expect(queue.list()).toEqual([good])
  })

  it('recovers from the signed journal when the second storage write fails, even after ledger confirmation', async () => {
    const storage = new MemoryStorage()
    const queue = createHostedPublicationQueue(storage)
    const job = queue.begin(draft)
    storage.setItem = () => {
      throw new Error('quota')
    }
    expect(() => queue.signed(job.id, signature)).toThrow('PAYLOAD_RECOVERY_STORAGE_UNAVAILABLE')
    const operation: StoredOperation = {
      operationId: crypto.randomUUID(),
      account: 'rIssuer',
      profileId: draft.network,
      networkId: 1,
      transactionType: 'CredentialCreate',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      stage: 'validated',
      engineResult: 'tesSUCCESS',
      txHash: signature.txHash,
      txBlob: signature.txBlob,
      business: {
        action: 'credential-issue',
        issuer: 'rIssuer',
        subject: 'rSubject',
        schemaUid: 'ab'.repeat(32),
        credentialUri: draft.credentialUri,
        publicationJobId: job.id,
      },
    }
    const publish = vi.fn(async () => receipt)
    const reloaded = createHostedPublicationQueue(storage)
    await expect(
      reloaded.publish(job.id, publish, readPayload, [
        { ...operation, profileId: 'another-network' },
      ]),
    ).rejects.toThrow('PAYLOAD_RECOVERY_SIGNATURE_MISSING')
    expect(publish).not.toHaveBeenCalled()
    await reloaded.publish(job.id, publish, readPayload, [operation])
    expect(publish).toHaveBeenCalledOnce()
    expect(reloaded.list()).toEqual([])
  })
})
