// Copied from packages/sdk/src/network.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import {
  parseNetworkProfile as parseCoreNetworkProfile,
  type NetworkProfile,
} from '../core/index.js'
import { isValidClassicAddress, type Client } from 'xrpl'

import { XcsSdkError } from './errors.js'

export function assertClassicAddress(address: string, field: string): void {
  if (!isValidClassicAddress(address)) {
    throw new XcsSdkError(
      'XCS_SDK_INVALID_ADDRESS',
      `${field} must be a valid XRPL classic address. X-addresses are not accepted by XCS v0.1.`,
      { field, address },
    )
  }
}

export function parseNetworkProfile(input: unknown): NetworkProfile {
  const profile = parseCoreNetworkProfile(input)
  assertClassicAddress(profile.registryAddress, 'registryAddress')
  return profile
}

export async function connectAndValidateNetwork(
  client: Client,
  profileInput: unknown,
): Promise<NetworkProfile> {
  const profile = parseNetworkProfile(profileInput)
  if (!client.isConnected()) {
    await client.connect()
  }

  const actualNetworkId = client.networkID
  if (actualNetworkId === undefined) {
    throw new XcsSdkError(
      'XCS_SDK_CLIENT_NOT_CONNECTED',
      'The connected XRPL server did not report a network ID.',
    )
  }
  if (actualNetworkId !== profile.networkId) {
    throw new XcsSdkError(
      'XCS_SDK_NETWORK_MISMATCH',
      `XRPL server network ID ${actualNetworkId} does not match profile network ID ${profile.networkId}.`,
      { expectedNetworkId: profile.networkId, actualNetworkId },
    )
  }

  const request = client.request.bind(client) as unknown as (
    request: Record<string, unknown>,
  ) => Promise<{ result: unknown }>
  let featureResult: unknown
  try {
    featureResult = (await request({ command: 'feature', feature: profile.requiredAmendment }))
      .result
  } catch (error) {
    throw new XcsSdkError(
      'XCS_SDK_AMENDMENT_UNAVAILABLE',
      'The connected XRPL server could not prove the required amendment status.',
      { requiredAmendment: profile.requiredAmendment, cause: String(error) },
    )
  }
  const featureMap = asRecord(featureResult)
  const amendmentKey = Object.keys(featureMap).find(
    (key) => key.toUpperCase() === profile.requiredAmendment.toUpperCase(),
  )
  const amendment = amendmentKey === undefined ? undefined : asRecord(featureMap[amendmentKey])
  if (amendment?.enabled !== true || amendment.supported !== true) {
    throw new XcsSdkError(
      'XCS_SDK_AMENDMENT_UNAVAILABLE',
      'The required XRPL amendment is not enabled and supported by the connected server.',
      { requiredAmendment: profile.requiredAmendment },
    )
  }

  return profile
}

/**
 * Verify the immutable activation anchor against a server that retains the
 * profile's historical ledger. Submission-only endpoints may not retain this
 * range, so callers opt into this stronger check explicitly.
 */
export async function verifyNetworkProfileActivation(
  client: Client,
  profileInput: unknown,
): Promise<NetworkProfile> {
  const profile = await connectAndValidateNetwork(client, profileInput)
  const request = client.request.bind(client) as unknown as (
    request: Record<string, unknown>,
  ) => Promise<{ result: unknown }>
  let raw: unknown
  try {
    raw = (
      await request({
        command: 'ledger',
        ledger_index: profile.activationLedgerIndex,
        transactions: false,
        expand: false,
      })
    ).result
  } catch (error) {
    throw new XcsSdkError(
      'XCS_SDK_ACTIVATION_UNAVAILABLE',
      'The XRPL server could not provide the profile activation ledger.',
      { cause: String(error) },
    )
  }
  const result = asRecord(raw)
  const ledger = asRecord(result.ledger)
  const ledgerIndex = result.ledger_index ?? ledger.ledger_index
  const ledgerHash = result.ledger_hash ?? ledger.ledger_hash
  if (
    result.validated !== true ||
    ledgerIndex !== profile.activationLedgerIndex ||
    typeof ledgerHash !== 'string' ||
    ledgerHash.toLowerCase() !== profile.activationLedgerHash
  ) {
    throw new XcsSdkError(
      'XCS_SDK_ACTIVATION_MISMATCH',
      'The XRPL activation ledger does not match the immutable network profile.',
      { activationLedgerIndex: profile.activationLedgerIndex },
    )
  }
  return profile
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
