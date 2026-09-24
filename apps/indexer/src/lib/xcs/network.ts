// Copied from packages/core/src/network.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { isValidClassicAddress, rippleTimeToISOTime as xrplRippleTimeToIso } from 'xrpl'

import { fail } from './errors.js'

export interface NetworkProfile {
  profileId: string
  xcsVersion: '0.1'
  networkId: number
  requiredAmendment: string
  registryAddress: string
  registrationAmountDrops: '1'
  activationLedgerIndex: number
  activationLedgerHash: string
}

const PROFILE_PROPERTIES = new Set([
  'profileId',
  'xcsVersion',
  'networkId',
  'requiredAmendment',
  'registryAddress',
  'registrationAmountDrops',
  'activationLedgerIndex',
  'activationLedgerHash',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff
}

export function parseNetworkProfile(input: unknown): NetworkProfile {
  if (!isRecord(input)) {
    return fail('INVALID_NETWORK_PROFILE', 'Network profile must be an object', '$')
  }
  for (const key of Object.keys(input)) {
    if (!PROFILE_PROPERTIES.has(key)) {
      return fail('INVALID_NETWORK_PROFILE', `Unknown property ${key}`, `$.${key}`)
    }
  }
  if (
    typeof input.profileId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.profileId)
  ) {
    return fail('INVALID_NETWORK_PROFILE', 'Invalid profileId', '$.profileId')
  }
  if (input.xcsVersion !== '0.1') {
    return fail('INVALID_NETWORK_PROFILE', 'Unsupported XCS version', '$.xcsVersion')
  }
  if (!isUint32(input.networkId)) {
    return fail('INVALID_NETWORK_PROFILE', 'networkId must be a uint32', '$.networkId')
  }
  if (
    typeof input.requiredAmendment !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(input.requiredAmendment)
  ) {
    return fail(
      'INVALID_NETWORK_PROFILE',
      'requiredAmendment must be a 32-byte hexadecimal value',
      '$.requiredAmendment',
    )
  }
  if (typeof input.registryAddress !== 'string' || !isValidClassicAddress(input.registryAddress)) {
    return fail('INVALID_NETWORK_PROFILE', 'Invalid XRPL registry address', '$.registryAddress')
  }
  if (input.registrationAmountDrops !== '1') {
    return fail(
      'INVALID_NETWORK_PROFILE',
      'registrationAmountDrops must equal "1"',
      '$.registrationAmountDrops',
    )
  }
  if (!isUint32(input.activationLedgerIndex) || input.activationLedgerIndex === 0) {
    return fail(
      'INVALID_NETWORK_PROFILE',
      'activationLedgerIndex must be a positive uint32',
      '$.activationLedgerIndex',
    )
  }
  if (
    typeof input.activationLedgerHash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(input.activationLedgerHash)
  ) {
    return fail(
      'INVALID_NETWORK_PROFILE',
      'activationLedgerHash must be a 32-byte hexadecimal value',
      '$.activationLedgerHash',
    )
  }

  return {
    profileId: input.profileId,
    xcsVersion: '0.1',
    networkId: input.networkId,
    requiredAmendment: input.requiredAmendment.toUpperCase(),
    registryAddress: input.registryAddress,
    registrationAmountDrops: '1',
    activationLedgerIndex: input.activationLedgerIndex,
    activationLedgerHash: input.activationLedgerHash.toLowerCase(),
  }
}

export function rippleTimeToIso(rippleTime: number): string {
  if (!isUint32(rippleTime)) {
    return fail('INVALID_RIPPLE_TIME', 'Ripple time must be a uint32', '$time')
  }
  return xrplRippleTimeToIso(rippleTime)
}
