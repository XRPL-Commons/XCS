import { readFile } from 'node:fs/promises'

import { parseNetworkProfile, type NetworkProfile } from '@xcs-protocol/core'

import { loadLedgerRpcConfig, resolveRegistryPolicy } from './config.js'
import {
  captureLedgerFixtureBundle,
  ledgerFixtureBundleDigest,
  LedgerFixtureBundleError,
  validateLedgerFixtureBundle,
} from './fixture-bundle.js'
import { QuorumLedgerSource } from './quorum-ledger-source.js'
import { sourceErrorCode } from './source-errors.js'
import { parseJson, sha256Hex } from './serialization.js'
import { XrplLedgerSource } from './xrpl-source.js'

type FixtureCommand = 'capture' | 'validate'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value.trim()
}

function requiredOperatorLabel(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`)
  return value
}

function targetLedgerIndex(): number {
  const value = Number(required('XCS_FIXTURE_TARGET_LEDGER_INDEX'))
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new Error('XCS_FIXTURE_TARGET_LEDGER_INDEX must be a positive uint32')
  }
  return value
}

function parseCommand(value: string | undefined): FixtureCommand {
  if (value === 'capture' || value === 'validate') return value
  throw new Error('Usage: xcs-indexer-fixtures <capture|validate>')
}

function parseProfileFile(profileFileBytes: Uint8Array): NetworkProfile {
  try {
    return parseNetworkProfile(parseJson(profileFileBytes))
  } catch (error) {
    throw new LedgerFixtureBundleError(
      'FIXTURE_BUNDLE_INVALID',
      'XCS_NETWORK_PROFILE must contain a valid strict UTF-8 network profile',
      { cause: error },
    )
  }
}

async function runCapture(): Promise<void> {
  const profilePath = required('XCS_NETWORK_PROFILE')
  const profileFileBytes = await readFile(profilePath)
  const profile = parseProfileFile(profileFileBytes)
  const config = loadLedgerRpcConfig()
  const registryPolicy = resolveRegistryPolicy(profile)
  const source = new QuorumLedgerSource(
    new XrplLedgerSource(config.xrplRpcUrlPrimary, 'primary', registryPolicy),
    new XrplLedgerSource(config.xrplRpcUrlSecondary, 'secondary', registryPolicy),
  )
  const manifest = await captureLedgerFixtureBundle({
    outputDirectory: required('XCS_FIXTURE_OUTPUT'),
    profile,
    profileFileBytes,
    source,
    toLedgerIndex: targetLedgerIndex(),
    primaryOperator: requiredOperatorLabel('XCS_FIXTURE_PRIMARY_OPERATOR'),
    secondaryOperator: requiredOperatorLabel('XCS_FIXTURE_SECONDARY_OPERATOR'),
  })
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      format: manifest.format,
      profileId: manifest.profile.profileId,
      profileFileSha256: manifest.profileFileSha256,
      bundleDigest: ledgerFixtureBundleDigest(manifest),
      range: manifest.range,
      ledgerCount: manifest.range.to - manifest.range.from + 1,
    })}\n`,
  )
}

async function runValidate(): Promise<void> {
  const profilePath = required('XCS_NETWORK_PROFILE')
  const profileFileBytes = await readFile(profilePath)
  const profile = parseProfileFile(profileFileBytes)
  const manifest = await validateLedgerFixtureBundle(
    required('XCS_FIXTURE_BUNDLE'),
    profile,
    sha256Hex(profileFileBytes),
    required('XCS_FIXTURE_BUNDLE_SHA256'),
  )
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      format: manifest.format,
      profileId: manifest.profile.profileId,
      profileFileSha256: manifest.profileFileSha256,
      bundleDigest: ledgerFixtureBundleDigest(manifest),
      range: manifest.range,
      ledgerCount: manifest.range.to - manifest.range.from + 1,
    })}\n`,
  )
}

try {
  const command = parseCommand(process.argv[2])
  if (command === 'capture') await runCapture()
  if (command === 'validate') await runValidate()
} catch (error) {
  const code = error instanceof LedgerFixtureBundleError ? error.code : sourceErrorCode(error)
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
}
