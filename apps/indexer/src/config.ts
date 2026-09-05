import { readFile } from 'node:fs/promises'

import { parseNetworkProfile, type NetworkProfile } from '@xcs-protocol/core'

import { sha256Hex } from './serialization.js'
import type { DatabaseScope, RegistryPolicy } from './types.js'

export const CONTROLLED_PILOT_ACKNOWLEDGEMENT = 'DISPOSABLE_PROFILE_AND_DATABASE' as const
export const CONTROLLED_PILOT_PROFILE_ID = 'commons-testnet-xcs-v0.1-controlled-pilot' as const

export interface IndexerRuntimeConfig {
  databaseUrl: string
  pollIntervalMs: number
  leaseDurationMs: number
  batchSize: number
  profile: NetworkProfile
  registryPolicy: RegistryPolicy
  databaseScope: DatabaseScope
}

export interface IndexerConfig extends IndexerRuntimeConfig {
  /** @deprecated Use xrplRpcUrlPrimary. */
  xrplRpcUrl: string
  xrplRpcUrlPrimary: string
  xrplRpcUrlSecondary: string
}

export interface LedgerRpcConfig {
  xrplRpcUrlPrimary: string
  xrplRpcUrlSecondary: string
}

export interface IndexerPreflightConfig extends LedgerRpcConfig {
  profile: NetworkProfile
  profileSha256: string
  registryPolicy: RegistryPolicy
  databaseScope: DatabaseScope
}

interface LoadedProfileConfig {
  profile: NetworkProfile
  profileSha256: string
  registryPolicy: RegistryPolicy
  databaseScope: DatabaseScope
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function compatibleRequired(
  environment: NodeJS.ProcessEnv,
  primary: string,
  legacy: string,
): string {
  const value = environment[primary] ?? environment[legacy]
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${primary} is required`)
  }
  return value
}

function rpcUrl(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be a valid WebSocket URL`)
  }
  const isLoopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname)
  if (
    !['ws:', 'wss:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.protocol === 'ws:' && !isLoopback)
  ) {
    throw new Error(
      `${name} must use wss without embedded credentials; ws is allowed only for loopback`,
    )
  }
  return parsed.toString()
}

export function loadLedgerRpcConfig(environment: NodeJS.ProcessEnv = process.env): LedgerRpcConfig {
  const primary = rpcUrl(
    environment.XCS_RPC_URL_PRIMARY ??
      compatibleRequired(environment, 'XCS_RPC_URL', 'XRPL_RPC_URL'),
    'XCS_RPC_URL_PRIMARY',
  )
  const secondary = rpcUrl(required(environment, 'XCS_RPC_URL_SECONDARY'), 'XCS_RPC_URL_SECONDARY')
  if (primary === secondary) {
    throw new Error('XCS_RPC_URL_PRIMARY and XCS_RPC_URL_SECONDARY must be distinct')
  }
  return { xrplRpcUrlPrimary: primary, xrplRpcUrlSecondary: secondary }
}

export function resolveRegistryPolicy(
  profile: NetworkProfile,
  environment: NodeJS.ProcessEnv = process.env,
): RegistryPolicy {
  const policy = environment.XCS_REGISTRY_POLICY ?? 'blackholed'
  if (policy !== 'blackholed' && policy !== 'controlled-testnet-pilot') {
    throw new Error('XCS_REGISTRY_POLICY must be either blackholed or controlled-testnet-pilot')
  }
  const controlledPilotProfile = profile.profileId.endsWith('-controlled-pilot')
  if (policy === 'blackholed') {
    if (controlledPilotProfile) {
      throw new Error(
        'A profileId ending in -controlled-pilot requires XCS_REGISTRY_POLICY=controlled-testnet-pilot',
      )
    }
    return policy
  }
  if (environment.XCS_CONTROLLED_PILOT_ACK !== CONTROLLED_PILOT_ACKNOWLEDGEMENT) {
    throw new Error(
      `XCS_CONTROLLED_PILOT_ACK must equal ${CONTROLLED_PILOT_ACKNOWLEDGEMENT} for controlled-testnet-pilot`,
    )
  }
  if (profile.networkId !== 1) {
    throw new Error('controlled-testnet-pilot requires networkId 1')
  }
  if (profile.profileId !== CONTROLLED_PILOT_PROFILE_ID) {
    throw new Error(`controlled-testnet-pilot requires profileId ${CONTROLLED_PILOT_PROFILE_ID}`)
  }
  return policy
}

export function resolveDatabaseScope(
  registryPolicy: RegistryPolicy,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseScope {
  const scope = environment.XCS_DATABASE_SCOPE ?? 'shared'
  if (scope !== 'shared' && scope !== 'exclusive-profile') {
    throw new Error('XCS_DATABASE_SCOPE must be either shared or exclusive-profile')
  }
  if (registryPolicy === 'controlled-testnet-pilot' && scope !== 'exclusive-profile') {
    throw new Error('controlled-testnet-pilot requires XCS_DATABASE_SCOPE=exclusive-profile')
  }
  return scope
}

async function loadProfileConfig(environment: NodeJS.ProcessEnv): Promise<LoadedProfileConfig> {
  const profilePath = required(environment, 'XCS_NETWORK_PROFILE')
  const profileFileBytes = await readFile(profilePath)
  const profileJson: unknown = JSON.parse(profileFileBytes.toString('utf8'))
  const profile = parseNetworkProfile(profileJson)
  const registryPolicy = resolveRegistryPolicy(profile, environment)
  return {
    profile,
    profileSha256: sha256Hex(profileFileBytes),
    registryPolicy,
    databaseScope: resolveDatabaseScope(registryPolicy, environment),
  }
}

export async function loadIndexerPreflightConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IndexerPreflightConfig> {
  const loaded = await loadProfileConfig(environment)
  return { ...loaded, ...loadLedgerRpcConfig(environment) }
}

export async function loadIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IndexerConfig> {
  const runtime = await loadIndexerRuntimeConfig(environment)
  const source = loadLedgerRpcConfig(environment)
  return {
    ...runtime,
    xrplRpcUrl: source.xrplRpcUrlPrimary,
    xrplRpcUrlPrimary: source.xrplRpcUrlPrimary,
    xrplRpcUrlSecondary: source.xrplRpcUrlSecondary,
  }
}

export async function loadIndexerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IndexerRuntimeConfig> {
  const { profile, registryPolicy, databaseScope } = await loadProfileConfig(environment)
  const pollIntervalMs = Number(
    environment.XCS_INDEXER_POLL_INTERVAL_MS ?? environment.INDEXER_POLL_INTERVAL_MS ?? '4000',
  )
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60_000) {
    throw new Error('XCS_INDEXER_POLL_INTERVAL_MS must be between 250 and 60000')
  }
  const leaseDurationMs = Number(environment.XCS_INDEXER_LEASE_DURATION_MS ?? '30000')
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 10_000 || leaseDurationMs > 300_000) {
    throw new Error('XCS_INDEXER_LEASE_DURATION_MS must be between 10000 and 300000')
  }
  if (leaseDurationMs < pollIntervalMs * 3) {
    throw new Error('XCS_INDEXER_LEASE_DURATION_MS must be at least 3 times the poll interval')
  }
  const batchSize = Number(environment.XCS_INDEXER_BATCH_SIZE ?? '20')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('XCS_INDEXER_BATCH_SIZE must be between 1 and 100')
  }

  return {
    databaseUrl:
      environment.XCS_INDEXER_DATABASE_URL ??
      compatibleRequired(environment, 'XCS_DATABASE_URL', 'DATABASE_URL'),
    pollIntervalMs,
    leaseDurationMs,
    batchSize,
    profile,
    registryPolicy,
    databaseScope,
  }
}
