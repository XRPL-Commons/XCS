// Copied from packages/core/test/network-lifecycle.test.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { describe, expect, it } from 'vitest'

import {
  parseNetworkProfile,
  projectCredentialLifecycle,
  rippleTimeToIso,
} from '../../../src/lib/xcs/index.js'

describe('network and native lifecycle', () => {
  it('parses a network profile with xrpl.js address validation', () => {
    const profile = parseNetworkProfile({
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

  it('wraps xrpl.js Ripple-time conversion with strict protocol bounds', () => {
    expect(rippleTimeToIso(0)).toBe('2000-01-01T00:00:00.000Z')
    expect(() => rippleTimeToIso(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_RIPPLE_TIME' }),
    )
  })

  it('projects pending, active, expired, and deleted credentials', () => {
    expect(projectCredentialLifecycle({ objectExists: true, accepted: false, closeTime: 10 })).toBe(
      'pending',
    )
    expect(projectCredentialLifecycle({ objectExists: true, accepted: true, closeTime: 10 })).toBe(
      'active',
    )
    expect(
      projectCredentialLifecycle({
        objectExists: true,
        accepted: true,
        expiration: 10,
        closeTime: 10,
      }),
    ).toBe('expired')
    expect(projectCredentialLifecycle({ objectExists: false, accepted: true, closeTime: 10 })).toBe(
      'deleted',
    )
  })
})
