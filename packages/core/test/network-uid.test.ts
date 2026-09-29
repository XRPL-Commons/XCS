import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  computeSchemaUid,
  encodeUtf8Hex,
  decodeUtf8Hex,
  validateNetworkProfile,
  XcsError,
  type SchemaUidInput,
} from '../src/index.js'

interface UidVectors {
  cases: Array<{ name: string; input: SchemaUidInput; uid: string }>
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../conformance/v0.1/schema-uid.json', import.meta.url), 'utf8'),
) as UidVectors

describe('network profile', () => {
  it('validates and normalizes hexadecimal identifiers', () => {
    const profile = validateNetworkProfile({
      profileId: 'xrpl-testnet-xcs-v0.1',
      xcsVersion: '0.1',
      networkId: 1,
      requiredAmendment: 'ab'.repeat(32),
      registryAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      registrationAmountDrops: '1',
      activationLedgerIndex: 1,
      activationLedgerHash: 'CD'.repeat(32),
    })
    expect(profile.requiredAmendment).toBe('AB'.repeat(32))
    expect(profile.activationLedgerHash).toBe('cd'.repeat(32))
  })

  it('rejects a malformed registry account', () => {
    expect(() =>
      validateNetworkProfile({
        profileId: 'test',
        xcsVersion: '0.1',
        networkId: 1,
        requiredAmendment: 'ab'.repeat(32),
        registryAddress: 'rNotChecksummed',
        registrationAmountDrops: '1',
        activationLedgerIndex: 1,
        activationLedgerHash: 'cd'.repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_PROFILE_INVALID' }))
  })

  it('rejects ledger zero because activation starts at a real validated ledger', () => {
    expect(() =>
      validateNetworkProfile({
        profileId: 'test',
        xcsVersion: '0.1',
        networkId: 1,
        requiredAmendment: 'ab'.repeat(32),
        registryAddress: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
        registrationAmountDrops: '1',
        activationLedgerIndex: 0,
        activationLedgerHash: 'cd'.repeat(32),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'NETWORK_PROFILE_INVALID',
        message: 'activationLedgerIndex must be a positive uint32',
      }),
    )
  })
})

describe('schema UID', () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(computeSchemaUid(vector.input)).toBe(vector.uid)
    })
  }

  it('encodes memo strings as uppercase UTF-8 hex', () => {
    expect(encodeUtf8Hex('xcs:schema_register')).toBe(
      '7863733A736368656D615F7265676973746572'.toUpperCase(),
    )
    expect(decodeUtf8Hex(encodeUtf8Hex('é'))).toBe('é')
  })
})
