// Copied from packages/sdk/test/network.test.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import type { Client } from 'xrpl'
import { describe, expect, it, vi } from 'vitest'

import {
  connectAndValidateNetwork,
  parseNetworkProfile,
  verifyNetworkProfileActivation,
  XcsSdkError,
} from '#xcs/sdk/index.js'

const profile = {
  profileId: 'xrpl-testnet-xcs-v0.1',
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'AB'.repeat(32),
  registryAddress: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
  registrationAmountDrops: '1',
  activationLedgerIndex: 1,
  activationLedgerHash: 'CD'.repeat(32),
}

describe('network validation', () => {
  it('connects and accepts only the profile network ID', async () => {
    let connected = false
    const client = {
      networkID: 1,
      isConnected: () => connected,
      connect: vi.fn(async () => {
        connected = true
      }),
      request: vi.fn(async () => ({
        result: {
          [profile.requiredAmendment]: { enabled: true, supported: true },
        },
      })),
    } as unknown as Client

    await expect(connectAndValidateNetwork(client, profile)).resolves.toMatchObject({
      networkId: 1,
    })
    expect(client.connect).toHaveBeenCalledOnce()
  })

  it('rejects server/profile mismatches and malformed registry addresses', async () => {
    const client = {
      networkID: 0,
      isConnected: () => true,
    } as unknown as Client
    await expect(connectAndValidateNetwork(client, profile)).rejects.toMatchObject({
      code: 'XCS_SDK_NETWORK_MISMATCH',
    })
    expect(() => parseNetworkProfile({ ...profile, registryAddress: 'not-an-address' })).toThrow()
  })

  it('rejects a connected client that did not report its network ID', async () => {
    const client = { isConnected: () => true, networkID: undefined } as unknown as Client
    await expect(connectAndValidateNetwork(client, profile)).rejects.toBeInstanceOf(XcsSdkError)
  })

  it('rejects a server that cannot prove the required amendment is enabled and supported', async () => {
    const client = {
      networkID: 1,
      isConnected: () => true,
      request: vi.fn(async () => ({
        result: {
          [profile.requiredAmendment.toLowerCase()]: { enabled: true, supported: false },
        },
      })),
    } as unknown as Client

    await expect(connectAndValidateNetwork(client, profile)).rejects.toMatchObject({
      code: 'XCS_SDK_AMENDMENT_UNAVAILABLE',
    })
  })

  it('verifies the immutable activation ledger on a history-capable server', async () => {
    const request = vi.fn(async (input: { command: string }) =>
      input.command === 'feature'
        ? {
            result: {
              [profile.requiredAmendment]: { enabled: true, supported: true },
            },
          }
        : {
            result: {
              validated: true,
              ledger_index: profile.activationLedgerIndex,
              ledger_hash: profile.activationLedgerHash,
            },
          },
    )
    const client = {
      networkID: 1,
      isConnected: () => true,
      request,
    } as unknown as Client

    await expect(verifyNetworkProfileActivation(client, profile)).resolves.toMatchObject({
      activationLedgerHash: profile.activationLedgerHash.toLowerCase(),
    })
    expect(request).toHaveBeenLastCalledWith({
      command: 'ledger',
      ledger_index: profile.activationLedgerIndex,
      transactions: false,
      expand: false,
    })
  })

  it('rejects an activation ledger that does not match the profile anchor', async () => {
    const client = {
      networkID: 1,
      isConnected: () => true,
      request: vi.fn(async (input: { command: string }) =>
        input.command === 'feature'
          ? {
              result: {
                [profile.requiredAmendment]: { enabled: true, supported: true },
              },
            }
          : {
              result: {
                validated: true,
                ledger_index: profile.activationLedgerIndex,
                ledger_hash: 'EF'.repeat(32),
              },
            },
      ),
    } as unknown as Client

    await expect(verifyNetworkProfileActivation(client, profile)).rejects.toMatchObject({
      code: 'XCS_SDK_ACTIVATION_MISMATCH',
    })
  })
})
