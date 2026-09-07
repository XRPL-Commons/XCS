import { isValidClassicAddress } from 'xrpl'

import type { LedgerRange, NetworkProfile, RegistryPolicy } from './types.js'
import { sourceFailure } from './source-errors.js'

export const XRPL_ACCOUNT_ZERO = 'rrrrrrrrrrrrrrrrrrrrrhoLvTp'
export const XRPL_ACCOUNT_ONE = 'rrrrrrrrrrrrrrrrrrrrBZbvji'

const LSF_DISABLE_MASTER = 0x0010_0000
const LSF_DEPOSIT_AUTH = 0x0100_0000
const LSF_REQUIRE_DEST_TAG = 0x0002_0000

export interface SourceServerStatus {
  networkId: number
  validatedLedgerIndex: number
  validatedLedgerHash: string
  completeLedgerRanges: LedgerRange[]
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function uint32(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a uint32`)
  }
  return value
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a 32-byte hexadecimal hash`)
  }
  return value.toLowerCase()
}

export function parseCompleteLedgers(value: unknown): LedgerRange[] {
  if (typeof value !== 'string' || value.length === 0 || value === 'empty') {
    return sourceFailure(
      'SOURCE_HISTORY_INCOMPLETE',
      'XRPL source does not report any complete ledger history',
    )
  }

  const ranges = value.split(',').map((part) => {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part.trim())
    if (match === null) {
      return sourceFailure('SOURCE_RESPONSE_INVALID', 'server_info.complete_ledgers is malformed')
    }
    const min = Number(match[1])
    const max = Number(match[2] ?? match[1])
    uint32(min, 'complete_ledgers minimum')
    uint32(max, 'complete_ledgers maximum')
    if (min > max) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        'server_info.complete_ledgers contains a reversed range',
      )
    }
    return { min, max }
  })

  ranges.sort((left, right) => left.min - right.min || left.max - right.max)
  const merged: LedgerRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous === undefined || range.min > previous.max + 1) {
      merged.push({ ...range })
    } else {
      previous.max = Math.max(previous.max, range.max)
    }
  }
  return merged
}

export function normalizeServerInfo(value: unknown): SourceServerStatus {
  const result = record(value, 'server_info result')
  const info = record(result.info, 'server_info.info')
  const validated = record(info.validated_ledger, 'server_info.info.validated_ledger')
  return {
    networkId: uint32(info.network_id, 'server_info.info.network_id'),
    validatedLedgerIndex: uint32(validated.seq, 'validated_ledger.seq'),
    validatedLedgerHash: hash(validated.hash, 'validated_ledger.hash'),
    completeLedgerRanges: parseCompleteLedgers(info.complete_ledgers),
  }
}

export function assertSourceCoversProfile(
  status: SourceServerStatus,
  profile: NetworkProfile,
): void {
  if (status.networkId !== profile.networkId) {
    return sourceFailure(
      'SOURCE_NETWORK_MISMATCH',
      `XRPL source network ${status.networkId} does not match profile network ${profile.networkId}`,
      { expectedNetworkId: profile.networkId, actualNetworkId: status.networkId },
    )
  }
  if (status.validatedLedgerIndex < profile.activationLedgerIndex) {
    return sourceFailure(
      'SOURCE_HISTORY_INCOMPLETE',
      'XRPL source tip precedes the XCS activation ledger',
      {
        activationLedgerIndex: profile.activationLedgerIndex,
        validatedLedgerIndex: status.validatedLedgerIndex,
      },
    )
  }
  const coveringRange = status.completeLedgerRanges.find(
    (range) =>
      range.min <= profile.activationLedgerIndex && range.max >= status.validatedLedgerIndex,
  )
  if (coveringRange === undefined) {
    return sourceFailure(
      'SOURCE_HISTORY_INCOMPLETE',
      'XRPL source does not have a contiguous validated history from activation to tip',
      {
        activationLedgerIndex: profile.activationLedgerIndex,
        validatedLedgerIndex: status.validatedLedgerIndex,
      },
    )
  }
}

function signerLists(result: Record<string, unknown>, accountData: Record<string, unknown>) {
  const candidates: unknown[] = []
  if (Object.hasOwn(result, 'signer_lists')) candidates.push(result.signer_lists)
  if (Object.hasOwn(accountData, 'signer_lists')) candidates.push(accountData.signer_lists)
  if (candidates.length === 0) return []

  const lists: unknown[] = []
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        'account_info signer_lists must be an array when present',
      )
    }
    lists.push(...candidate)
  }
  return lists
}

function classicAddress(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isValidClassicAddress(value)) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', `${label} must be a classic XRPL address`)
  }
  return value
}

interface RegistryAccountRoot {
  result: Record<string, unknown>
  accountData: Record<string, unknown>
  flags: number
}

function registryAccountRoot(input: {
  accountInfo: unknown
  profile: NetworkProfile
}): RegistryAccountRoot {
  const result = record(input.accountInfo, 'account_info result')
  if (result.validated !== true) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Registry account_info is not validated')
  }
  if (hash(result.ledger_hash, 'account_info.ledger_hash') !== input.profile.activationLedgerHash) {
    return sourceFailure(
      'SOURCE_ACTIVATION_MISMATCH',
      'Registry account_info does not come from the activation ledger',
    )
  }
  if (
    uint32(result.ledger_index, 'account_info.ledger_index') !== input.profile.activationLedgerIndex
  ) {
    return sourceFailure(
      'SOURCE_ACTIVATION_MISMATCH',
      'Registry account_info ledger index does not match the activation profile',
    )
  }

  const accountData = record(result.account_data, 'account_info.account_data')
  if (accountData.LedgerEntryType !== 'AccountRoot') {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'account_info.account_data must be an AccountRoot ledger entry',
    )
  }
  if (accountData.Account !== input.profile.registryAddress) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'account_info account does not match the configured registry',
    )
  }
  return {
    result,
    accountData,
    flags: uint32(accountData.Flags, 'account_info.account_data.Flags'),
  }
}

export function assertRegistryBlackholed(input: {
  accountInfo: unknown
  accountObjects: unknown[]
  profile: NetworkProfile
}): void {
  const { result, accountData, flags } = registryAccountRoot(input)
  const regularKey = accountData.RegularKey
  const failures: string[] = []
  if ((flags & LSF_DISABLE_MASTER) === 0) failures.push('master_key_enabled')
  if ((flags & LSF_DEPOSIT_AUTH) !== 0) failures.push('deposit_auth_enabled')
  if ((flags & LSF_REQUIRE_DEST_TAG) !== 0) failures.push('destination_tag_required')
  if (regularKey !== XRPL_ACCOUNT_ZERO && regularKey !== XRPL_ACCOUNT_ONE) {
    failures.push('regular_key_not_blackholed')
  }
  if (signerLists(result, accountData).length !== 0) failures.push('signer_list_present')

  for (const rawObject of input.accountObjects) {
    const object = record(rawObject, 'account_objects entry')
    if (object.LedgerEntryType === 'SignerList') failures.push('signer_list_present')
    if (object.LedgerEntryType === 'Delegate') {
      const account = classicAddress(object.Account, 'Delegate.Account')
      classicAddress(object.Authorize, 'Delegate.Authorize')
      if (account === input.profile.registryAddress) failures.push('delegate_present')
    }
  }

  if (failures.length > 0) {
    return sourceFailure(
      'SOURCE_REGISTRY_NOT_BLACKHOLED',
      'Registry account does not satisfy the XCS blackhole policy',
      { failures: [...new Set(failures)] },
    )
  }
}

export function assertRegistryReceivable(input: {
  accountInfo: unknown
  profile: NetworkProfile
}): void {
  const { flags } = registryAccountRoot(input)
  const failures: string[] = []
  if ((flags & LSF_DEPOSIT_AUTH) !== 0) failures.push('deposit_auth_enabled')
  if ((flags & LSF_REQUIRE_DEST_TAG) !== 0) failures.push('destination_tag_required')
  if (failures.length > 0) {
    return sourceFailure(
      'SOURCE_REGISTRY_NOT_RECEIVABLE',
      'Registry account cannot receive registration payments without extra authorization',
      { failures },
    )
  }
}

export function assertRegistryPolicy(input: {
  accountInfo: unknown
  accountObjects: unknown[]
  profile: NetworkProfile
  policy: RegistryPolicy
}): void {
  if (input.policy === 'controlled-testnet-pilot') {
    return assertRegistryReceivable(input)
  }
  return assertRegistryBlackholed(input)
}

export function normalizeAccountObjectsPage(
  value: unknown,
  profile: NetworkProfile,
): { objects: Record<string, unknown>[]; marker?: unknown } {
  const result = record(value, 'account_objects result')
  if (result.validated !== true) {
    return sourceFailure('SOURCE_RESPONSE_INVALID', 'Registry account_objects is not validated')
  }
  if (hash(result.ledger_hash, 'account_objects.ledger_hash') !== profile.activationLedgerHash) {
    return sourceFailure(
      'SOURCE_ACTIVATION_MISMATCH',
      'Registry account_objects does not come from the activation ledger',
    )
  }
  if (
    uint32(result.ledger_index, 'account_objects.ledger_index') !== profile.activationLedgerIndex
  ) {
    return sourceFailure(
      'SOURCE_ACTIVATION_MISMATCH',
      'Registry account_objects ledger index does not match the activation profile',
    )
  }
  if (result.account !== profile.registryAddress) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'account_objects account does not match the configured registry',
    )
  }
  if (!Array.isArray(result.account_objects)) {
    return sourceFailure(
      'SOURCE_RESPONSE_INVALID',
      'account_objects.account_objects must be an array',
    )
  }
  const objects = result.account_objects.map((value, index) => {
    const object = record(value, `account_objects.account_objects[${index}]`)
    if (typeof object.LedgerEntryType !== 'string' || object.LedgerEntryType.length === 0) {
      return sourceFailure(
        'SOURCE_RESPONSE_INVALID',
        `account_objects.account_objects[${index}].LedgerEntryType must be a non-empty string`,
      )
    }
    return object
  })
  return {
    objects,
    ...(result.marker === undefined ? {} : { marker: result.marker }),
  }
}
