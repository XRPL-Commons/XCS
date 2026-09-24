import { createHttpsPayloadUri, payloadDigest } from '#xcs/core/index.js'
import { describe, expect, it } from 'vitest'
import {
  assertIssuerPayloadReceipt,
  assertIssuerWallet,
  assertIssuanceContextUnchanged,
  claimPublicPointer,
  clearIssuerEngineRecord,
  issuerVisibilityPreview,
  readIssuerEngineRecord,
  saveIssuerEngineRecord,
  type IssuerIssuanceContext,
} from '../app/utils/issuerEngine'

const context: IssuerIssuanceContext = {
  invite: {
    id: 'invite',
    organizationId: 'organization',
    profileId: 'testnet',
    schemaUid: 'a'.repeat(64),
    claimedBy: 'claimant',
    expiresAt: '2030-01-01T00:00:00Z',
    revokedAt: null,
  },
  schema: {
    schemaUid: 'a'.repeat(64),
    profileId: 'testnet',
    name: 'Course',
    publisher: 'issuer',
    definition: {
      xcsVersion: '0.1',
      name: 'Course',
      description: 'Completion',
      fields: { name: { type: 'string' } },
    },
    resolvedDefinition: {
      definition: {
        xcsVersion: '0.1',
        name: 'Course',
        description: 'Completion',
        fields: { name: { type: 'string' } },
      },
      fields: { name: { type: 'string' } },
      lineage: [],
    },
  },
  recipient: {
    id: 'claimant',
    displayName: 'Real claimant',
    wallets: [{ address: 'subject', networkId: 1 }],
  },
  organization: { id: 'organization', name: 'Issuer' },
  issuerWallets: [{ address: 'issuer', networkId: 1 }],
}

describe('issuer signing context', () => {
  it('accepts the currently verified Testnet wallets', () => {
    expect(() => assertIssuerWallet(context.issuerWallets, 'issuer')).not.toThrow()
    expect(() =>
      assertIssuanceContextUnchanged(context, structuredClone(context), 'subject', 'issuer'),
    ).not.toThrow()
  })
  it.each([
    [
      'recipient changed',
      (value: IssuerIssuanceContext) => {
        value.recipient.id = 'someone-else'
      },
    ],
    [
      'claimant changed',
      (value: IssuerIssuanceContext) => {
        value.invite.claimedBy = 'someone-else'
      },
    ],
    [
      'wallet unlinked',
      (value: IssuerIssuanceContext) => {
        value.recipient.wallets = []
      },
    ],
    [
      'wrong network',
      (value: IssuerIssuanceContext) => {
        value.recipient.wallets[0]!.networkId = 0
      },
    ],
    [
      'organization changed',
      (value: IssuerIssuanceContext) => {
        value.invite.organizationId = 'other'
      },
    ],
    [
      'schema changed',
      (value: IssuerIssuanceContext) => {
        value.schema.schemaUid = 'b'.repeat(64)
      },
    ],
    [
      'revoked invitation',
      (value: IssuerIssuanceContext) => {
        value.invite.revokedAt = '2026-09-23'
      },
    ],
  ])('blocks %s after preview', (_name, change) => {
    const current = structuredClone(context)
    change(current)
    expect(() => assertIssuanceContextUnchanged(context, current, 'subject', 'issuer')).toThrow(
      'ISSUER_CONTEXT_CHANGED',
    )
  })
  it('blocks an unlinked issuer even if the recipient is unchanged', () => {
    expect(() =>
      assertIssuanceContextUnchanged(
        context,
        { ...context, issuerWallets: [] },
        'subject',
        'issuer',
      ),
    ).toThrow('ISSUER_VERIFIED_WALLET_REQUIRED')
  })
  it('blocks a second issuance when another confirmed transaction already consumed the invitation', () => {
    expect(() =>
      assertIssuanceContextUnchanged(
        context,
        { ...context, existingCredential: { profileId: 'testnet', generationId: 'b'.repeat(64) } },
        'subject',
        'issuer',
      ),
    ).toThrow('ISSUER_INVITE_ALREADY_ISSUED')
  })
})

describe('issuer payload disclosure', () => {
  const claims = { learner: 'Camille', course: 'Security', 'a/b~c': 'escaped', __proto__: null }
  it('starts private with no publicly visible claims', () => {
    expect(issuerVisibilityPreview(claims, { visibility: 'private', publicFields: [] })).toEqual({
      public: {},
      private: claims,
    })
  })
  it('shows only explicitly selected whole fields and handles JSON pointer escapes', () => {
    expect(claimPublicPointer('a/b~c')).toBe('/a~1b~0c')
    expect(
      issuerVisibilityPreview(claims, {
        visibility: 'private',
        publicFields: ['/course', '/a~1b~0c'],
      }),
    ).toEqual({
      public: { course: 'Security', 'a/b~c': 'escaped' },
      private: { learner: 'Camille' },
    })
  })
  it('warnable public mode exposes all fields regardless of selectors', () => {
    expect(issuerVisibilityPreview(claims, { visibility: 'public', publicFields: [] })).toEqual({
      public: claims,
      private: {},
    })
  })
  it('requires exact payload commitment in both receipt and signed URI', () => {
    const payload = '{"claim":"private"}'
    const receipt = {
      payloadId: '12345678-1234-1234-1234-123456789abc',
      credentialUri: createHttpsPayloadUri('https://x.test/q/123456789012345678', payload),
      payloadDigest: payloadDigest(payload),
    }
    expect(() => assertIssuerPayloadReceipt(receipt, payload)).not.toThrow()
    expect(() =>
      assertIssuerPayloadReceipt({ ...receipt, payloadDigest: 'a'.repeat(64) }, payload),
    ).toThrow('ISSUER_PAYLOAD_DIGEST_MISMATCH')
    expect(() =>
      assertIssuerPayloadReceipt(
        {
          ...receipt,
          credentialUri: createHttpsPayloadUri('https://x.test/q/123456789012345678', '{}'),
        },
        payload,
      ),
    ).toThrow('ISSUER_PAYLOAD_DIGEST_MISMATCH')
    expect(() =>
      assertIssuerPayloadReceipt(
        {
          ...receipt,
          credentialUri: createHttpsPayloadUri(
            'https://x.test/api/issuer/payloads/12345678-1234-1234-1234-123456789abc',
            payload,
          ),
        },
        payload,
      ),
    ).toThrow('ISSUER_PAYLOAD_DIGEST_MISMATCH')
  })
})

describe('issuer reconciliation after reload', () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      },
    }
  }
  it('persists only references and recovers the same signed transaction', () => {
    const store = storage()
    const receipt = {
      transactionHash: 'a'.repeat(64),
      payloadId: '12345678-1234-1234-1234-123456789abc',
      visibility: 'private' as const,
      publicFields: ['/course'],
      claims: { secret: 'never persist' },
    }
    saveIssuerEngineRecord(store, 'account:invite', receipt)
    expect([...store.values.values()].join('')).not.toContain('never persist')
    expect(readIssuerEngineRecord(store, 'account:invite')).toEqual({
      transactionHash: receipt.transactionHash,
      payloadId: receipt.payloadId,
      visibility: 'private',
      publicFields: ['/course'],
    })
    expect(readIssuerEngineRecord(store, 'other-account:invite')).toBeNull()
    clearIssuerEngineRecord(store, 'account:invite')
    expect(readIssuerEngineRecord(store, 'account:invite')).toBeNull()
  })
  it.each([
    '{',
    '{"transactionHash":"bad"}',
    JSON.stringify({ transactionHash: 'a'.repeat(64), visibility: 'unsafe' }),
    JSON.stringify({ transactionHash: 'a'.repeat(64), publicFields: [3] }),
  ])('rejects corrupt stored references %s', (value) => {
    const store = storage()
    store.setItem('xcs-issuer-engine:test', value)
    expect(readIssuerEngineRecord(store, 'test')).toBeNull()
  })
})
