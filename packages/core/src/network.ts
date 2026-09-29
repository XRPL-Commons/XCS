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
    return fail('NETWORK_PROFILE_INVALID', 'Network profile must be an object', '$')
  }
  for (const key of Object.keys(input)) {
    if (!PROFILE_PROPERTIES.has(key)) {
      return fail('NETWORK_PROFILE_INVALID', `Unknown property ${key}`, `$.${key}`)
    }
  }
  if (
    typeof input.profileId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.profileId)
  ) {
    return fail('NETWORK_PROFILE_INVALID', 'Invalid profileId', '$.profileId')
  }
  if (input.xcsVersion !== '0.1') {
    return fail('NETWORK_PROFILE_INVALID', 'Unsupported XCS version', '$.xcsVersion')
  }
  if (!isUint32(input.networkId)) {
    return fail('NETWORK_PROFILE_INVALID', 'networkId must be a uint32', '$.networkId')
  }
  if (
    typeof input.requiredAmendment !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(input.requiredAmendment)
  ) {
    return fail(
      'NETWORK_PROFILE_INVALID',
      'requiredAmendment must be a 32-byte hexadecimal value',
      '$.requiredAmendment',
    )
  }
  if (typeof input.registryAddress !== 'string' || !isValidClassicAddress(input.registryAddress)) {
    return fail('NETWORK_PROFILE_INVALID', 'Invalid XRPL registry address', '$.registryAddress')
  }
  if (input.registrationAmountDrops !== '1') {
    return fail(
      'NETWORK_PROFILE_INVALID',
      'registrationAmountDrops must equal "1"',
      '$.registrationAmountDrops',
    )
  }
  if (!isUint32(input.activationLedgerIndex) || input.activationLedgerIndex === 0) {
    return fail(
      'NETWORK_PROFILE_INVALID',
      'activationLedgerIndex must be a positive uint32',
      '$.activationLedgerIndex',
    )
  }
  if (
    typeof input.activationLedgerHash !== 'string' ||
    !/^[0-9a-fA-F]{64}$/.test(input.activationLedgerHash)
  ) {
    return fail(
      'NETWORK_PROFILE_INVALID',
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

/** Normative XCS v0.1 name retained for existing consumers. */
export const validateNetworkProfile = parseNetworkProfile

export function rippleTimeToIso(rippleTime: number): string {
  if (!isUint32(rippleTime)) {
    return fail('RIPPLE_TIME_INVALID', 'Ripple time must be a uint32', '$time')
  }
  return xrplRippleTimeToIso(rippleTime)
}
