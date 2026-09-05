import { describe, expect, it } from 'vitest'

import {
  LOCAL_PAYLOAD_STORE_MAX_BYTES,
  LOCAL_PAYLOAD_STORE_MAX_ENTRIES,
  LOCAL_PAYLOAD_STORE_TTL_MS,
  LocalPayloadPiiFieldError,
  clearLocalTestPayloads,
  inspectLocalTestPayloadLocation,
  readLocalTestPayload,
  storeLocalTestPayload,
  type LocalPayloadStorage,
} from '../app/utils/localPayloadStore'
import { canonicalJson } from '../app/utils/serialization'

class MemoryStorage implements LocalPayloadStorage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function payload(index = 1): string {
  return canonicalJson({
    xcsVersion: '0.1',
    issuer: 'rIssuer',
    subject: 'rSubject',
    schema: 'ab'.repeat(32),
    claims: { courseId: `course-${index}` },
  } as JsonValue)
}

describe('local Testnet payload store', () => {
  it('stores exact canonical bytes under a content-addressed IPFS URI and reads them back', () => {
    const storage = new MemoryStorage()
    const now = () => new Date('2026-09-01T12:00:00.000Z')
    const first = storeLocalTestPayload({ storage, content: payload(), now })
    const repeated = storeLocalTestPayload({ storage, content: payload(), now })
    const read = readLocalTestPayload({ storage, credentialUri: first.credentialUri, now })

    expect(first.credentialUri).toMatch(/^ipfs:\/\/b[a-z2-7]+$/u)
    expect(repeated).toEqual(first)
    expect(storage.length).toBe(1)
    expect(read).toMatchObject({
      content: payload(),
      fetchUrl: first.credentialUri,
      digestHex: first.digestHex,
      byteLength: first.byteLength,
    })
    expect(
      inspectLocalTestPayloadLocation({ storage, credentialUri: first.credentialUri, now }),
    ).toBe('local-browser-test-store')
  })

  it('fails closed for expired, missing, non-canonical, oversized and PII-shaped payloads', () => {
    const storage = new MemoryStorage()
    const createdAt = new Date('2026-09-01T12:00:00.000Z')
    const stored = storeLocalTestPayload({ storage, content: payload(), now: () => createdAt })
    expect(() =>
      readLocalTestPayload({
        storage,
        credentialUri: stored.credentialUri,
        now: () => new Date(createdAt.getTime() + LOCAL_PAYLOAD_STORE_TTL_MS + 1),
      }),
    ).toThrow('LOCAL_PAYLOAD_EXPIRED')
    expect(() => readLocalTestPayload({ storage, credentialUri: stored.credentialUri })).toThrow(
      'LOCAL_PAYLOAD_NOT_FOUND',
    )
    expect(() => storeLocalTestPayload({ storage, content: '{ "claims": {} }' })).toThrow(
      'LOCAL_PAYLOAD_NOT_CANONICAL_JCS',
    )
    expect(() =>
      storeLocalTestPayload({
        storage,
        content: canonicalJson({ value: 'a'.repeat(LOCAL_PAYLOAD_STORE_MAX_BYTES) }),
      }),
    ).toThrow('LOCAL_PAYLOAD_SIZE_INVALID')
    expect(() =>
      storeLocalTestPayload({
        storage,
        content: canonicalJson({ claims: { email: 'public@example.test' } }),
      }),
    ).toThrow('LOCAL_PAYLOAD_PII_FIELD_REJECTED')
    try {
      storeLocalTestPayload({
        storage,
        content: canonicalJson({ claims: { email: 'public@example.test' } }),
      })
      throw new Error('expected the PII-shaped field to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalPayloadPiiFieldError)
      expect(error).toMatchObject({ fieldPath: '$.claims.email' })
    }
    expect(() =>
      storeLocalTestPayload({
        storage,
        content: canonicalJson({ claims: { 'full name': 'Test Person' } }),
      }),
    ).toThrow('LOCAL_PAYLOAD_PII_FIELD_REJECTED')
    expect(() =>
      storeLocalTestPayload({
        storage,
        content: canonicalJson({ claims: { phoneNumber: '+33000000000' } }),
      }),
    ).toThrow('LOCAL_PAYLOAD_PII_FIELD_REJECTED')
    expect(() =>
      inspectLocalTestPayloadLocation({
        storage,
        credentialUri: storeLocalTestPayload({
          storage,
          content: payload(999),
        }).credentialUri,
        now: () => new Date(Date.now() + LOCAL_PAYLOAD_STORE_TTL_MS + 1),
      }),
    ).toThrow('LOCAL_PAYLOAD_EXPIRED')
  })

  it('accepts generic labels and allows fictitious person-shaped fields only after acknowledgement', () => {
    const storage = new MemoryStorage()
    const content = canonicalJson({
      claims: {
        name: 'Course Completion',
        nom: 'Course test',
        course: { name: 'Advanced course' },
      },
    } as JsonValue)

    expect(() => storeLocalTestPayload({ storage, content })).not.toThrow()
    const fictitiousPersonContent = canonicalJson({
      claims: { prenom: 'Personne Test' },
    } as JsonValue)
    expect(() =>
      storeLocalTestPayload({
        storage,
        content: fictitiousPersonContent,
      }),
    ).toThrow('LOCAL_PAYLOAD_PII_FIELD_REJECTED')

    const acknowledged = storeLocalTestPayload({
      storage,
      content: fictitiousPersonContent,
      nonPersonalTestDataAcknowledged: true,
    })
    expect(
      readLocalTestPayload({ storage, credentialUri: acknowledged.credentialUri }).content,
    ).toBe(fictitiousPersonContent)
  })

  it('enforces a bounded entry quota and supports an explicit purge', () => {
    const storage = new MemoryStorage()
    for (let index = 0; index < LOCAL_PAYLOAD_STORE_MAX_ENTRIES; index += 1) {
      storeLocalTestPayload({ storage, content: payload(index) })
    }
    expect(() =>
      storeLocalTestPayload({ storage, content: payload(LOCAL_PAYLOAD_STORE_MAX_ENTRIES) }),
    ).toThrow('LOCAL_PAYLOAD_STORE_QUOTA_EXCEEDED')
    expect(clearLocalTestPayloads(storage)).toBe(LOCAL_PAYLOAD_STORE_MAX_ENTRIES)
    expect(storage.length).toBe(0)
  })
})
