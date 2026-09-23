import { computeSchemaUid, parseSchema } from '@xcs-protocol/core'
import { isValidClassicAddress } from 'xrpl'

import {
  assertCredentialGenerationEvidence,
  CREDENTIAL_DELETION_CAUSES,
  type CredentialGenerationEvidenceExpectation,
} from './credential-generation-evidence.js'
import {
  CREDENTIAL_GENERATION_TIMELINE_LIMIT,
  HEX_BYTES,
  LOWERCASE_HASH,
  MAX_NODE_INDEX,
  MAX_UINT32,
  REASON_CODE,
} from './http-schemas.js'
import { IndexerUnavailableError } from './ledger-freshness.js'
import { canonicalJson, encodeUtf8, sha256Hex } from './serialization.js'
import type { ApiRepository } from './types.js'

export function publicNetwork(row: Awaited<ReturnType<ApiRepository['listNetworks']>>[number]) {
  return {
    profileId: row.profileId,
    xcsVersion: row.xcsVersion,
    networkId: row.networkId,
    requiredAmendment: row.requiredAmendment,
    registryAddress: row.registryAddress,
    registrationAmountDrops: String(row.registrationAmountDrops),
    activationLedgerIndex: row.activationLedgerIndex,
    activationLedgerHash: row.activationLedgerHash,
  }
}

export function invalidIndexerEvidence(
  message = 'The indexed evidence is incomplete or inconsistent.',
): never {
  throw new IndexerUnavailableError('INDEXER_EVIDENCE_INVALID', message)
}

export function publicSchemaSummary(
  row: NonNullable<Awaited<ReturnType<ApiRepository['getSchema']>>>,
) {
  return {
    schemaUid: row.schemaUid,
    publisher: row.publisher,
    name: row.name,
    description: row.description,
    parentUid: row.parentUid,
    supersedesUid: row.supersedesUid,
    registrationTransactionHash: row.registrationTransactionHash,
    ledgerIndex: row.ledgerIndex,
    transactionIndex: row.transactionIndex,
  }
}

export function publicCredentialGeneration(
  generation: NonNullable<Awaited<ReturnType<ApiRepository['getCredential']>>>,
  expected: CredentialGenerationEvidenceExpectation,
) {
  assertCredentialGenerationEvidence(generation, expected)
  return {
    generationId: generation.generationId,
    ledgerObjectId: generation.ledgerObjectId,
    issuer: generation.issuer,
    subject: generation.subject,
    schemaUid: generation.schemaUid,
    uriHex: generation.uriHex,
    expiration: generation.expiration,
    accepted: generation.accepted,
    createdLedgerIndex: generation.createdLedgerIndex,
    createdTransactionIndex: generation.createdTransactionIndex,
    lastLedgerIndex: generation.lastLedgerIndex,
    deletedLedgerIndex: generation.deletedLedgerIndex,
    deletionCause: generation.deletionCause,
  }
}

export function publicDiscoveryStats(
  stats: Awaited<ReturnType<ApiRepository['getDiscoveryStats']>>,
): {
  schemas: { total: number; publishers: number }
  credentialGenerations: {
    total: number
    pending: number
    active: number
    expired: number
    deleted: number
  }
  projectionLedgerIndexes: number[]
} {
  const schemaCounts = [stats.schemas.total, stats.schemas.publishers]
  const credentialCounts = [
    stats.credentialGenerations.total,
    stats.credentialGenerations.pending,
    stats.credentialGenerations.active,
    stats.credentialGenerations.expired,
    stats.credentialGenerations.deleted,
    stats.credentialGenerations.invalidEvidence,
  ]
  const validCounts = [...schemaCounts, ...credentialCounts].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
  const schemaLedgerShape =
    stats.schemas.total === 0
      ? stats.schemas.minimumLedgerIndex === null && stats.schemas.maximumLedgerIndex === null
      : Number.isSafeInteger(stats.schemas.minimumLedgerIndex) &&
        Number.isSafeInteger(stats.schemas.maximumLedgerIndex) &&
        stats.schemas.minimumLedgerIndex! <= stats.schemas.maximumLedgerIndex!
  const credentialLedgerShape =
    stats.credentialGenerations.total === 0
      ? stats.credentialGenerations.minimumCreatedLedgerIndex === null &&
        stats.credentialGenerations.maximumLastLedgerIndex === null
      : Number.isSafeInteger(stats.credentialGenerations.minimumCreatedLedgerIndex) &&
        Number.isSafeInteger(stats.credentialGenerations.maximumLastLedgerIndex) &&
        stats.credentialGenerations.minimumCreatedLedgerIndex! <=
          stats.credentialGenerations.maximumLastLedgerIndex!
  if (
    !validCounts ||
    stats.schemas.publishers > stats.schemas.total ||
    stats.credentialGenerations.invalidEvidence !== 0 ||
    stats.credentialGenerations.pending +
      stats.credentialGenerations.active +
      stats.credentialGenerations.expired +
      stats.credentialGenerations.deleted !==
      stats.credentialGenerations.total ||
    !schemaLedgerShape ||
    !credentialLedgerShape
  ) {
    return invalidIndexerEvidence(
      'The indexed discovery aggregates are incomplete or inconsistent.',
    )
  }
  return {
    schemas: {
      total: stats.schemas.total,
      publishers: stats.schemas.publishers,
    },
    credentialGenerations: {
      total: stats.credentialGenerations.total,
      pending: stats.credentialGenerations.pending,
      active: stats.credentialGenerations.active,
      expired: stats.credentialGenerations.expired,
      deleted: stats.credentialGenerations.deleted,
    },
    projectionLedgerIndexes: [
      stats.schemas.minimumLedgerIndex,
      stats.schemas.maximumLedgerIndex,
      stats.credentialGenerations.minimumCreatedLedgerIndex,
      stats.credentialGenerations.maximumLastLedgerIndex,
    ].filter((value): value is number => value !== null),
  }
}

export function publicCredentialEvent(
  row: Awaited<ReturnType<ApiRepository['getCredentialEvents']>>[number],
  expected: {
    readonly transactionHash: string
    readonly issuer: string
    readonly subject: string
    readonly schemaUid: string
    readonly activationLedgerIndex: number
    readonly generationId?: string
    readonly ledgerIndex?: number
    readonly ledgerHash?: string
    readonly transactionIndex?: number
  },
) {
  const validEventShape =
    row.transactionHash === expected.transactionHash &&
    row.issuer === expected.issuer &&
    row.subject === expected.subject &&
    row.schemaUid === expected.schemaUid &&
    (expected.generationId === undefined || row.generationId === expected.generationId) &&
    (expected.ledgerIndex === undefined || row.ledgerIndex === expected.ledgerIndex) &&
    (expected.ledgerHash === undefined || row.ledgerHash === expected.ledgerHash) &&
    (expected.transactionIndex === undefined ||
      row.transactionIndex === expected.transactionIndex) &&
    LOWERCASE_HASH.test(row.transactionHash) &&
    typeof row.generationId === 'string' &&
    LOWERCASE_HASH.test(row.generationId) &&
    LOWERCASE_HASH.test(row.ledgerObjectId) &&
    LOWERCASE_HASH.test(row.ledgerHash) &&
    LOWERCASE_HASH.test(row.schemaUid) &&
    isValidClassicAddress(row.issuer) &&
    isValidClassicAddress(row.subject) &&
    Number.isSafeInteger(row.nodeIndex) &&
    row.nodeIndex >= 0 &&
    row.nodeIndex <= MAX_NODE_INDEX &&
    Number.isSafeInteger(row.ledgerIndex) &&
    row.ledgerIndex >= expected.activationLedgerIndex &&
    row.ledgerIndex <= MAX_UINT32 &&
    Number.isSafeInteger(row.transactionIndex) &&
    row.transactionIndex >= 0 &&
    row.transactionIndex <= MAX_NODE_INDEX &&
    (row.uriHex === null || HEX_BYTES.test(row.uriHex)) &&
    (row.expiration === null ||
      (Number.isSafeInteger(row.expiration) &&
        row.expiration >= 0 &&
        row.expiration <= MAX_UINT32)) &&
    (row.eventType === 'created' || row.eventType === 'accepted' || row.eventType === 'deleted') &&
    (row.eventType === 'deleted'
      ? typeof row.deletionCause === 'string' && CREDENTIAL_DELETION_CAUSES.has(row.deletionCause)
      : row.deletionCause === null) &&
    (row.eventType !== 'created' ||
      (row.generationId === row.transactionHash &&
        row.accepted === (row.issuer === row.subject))) &&
    (row.eventType !== 'accepted' || row.accepted === true)
  if (!validEventShape) {
    throw new IndexerUnavailableError(
      'INDEXER_EVIDENCE_INVALID',
      'The indexed credential event evidence is incomplete or inconsistent.',
    )
  }
  return {
    transactionHash: row.transactionHash,
    nodeIndex: row.nodeIndex,
    generationId: row.generationId,
    ledgerIndex: row.ledgerIndex,
    ledgerHash: row.ledgerHash,
    transactionIndex: row.transactionIndex,
    eventType: row.eventType,
    issuer: row.issuer,
    subject: row.subject,
    schemaUid: row.schemaUid,
    accepted: row.accepted,
    deletionCause: row.deletionCause,
  }
}

export function invalidSchemaRegistrationEvidence(): never {
  throw new IndexerUnavailableError(
    'INDEXER_EVIDENCE_INVALID',
    'The indexed schema registration evidence is incomplete or inconsistent.',
  )
}

export function publicSchemaRegistration(
  row: NonNullable<Awaited<ReturnType<ApiRepository['getSchemaRegistrationByTransaction']>>>,
  network: { readonly networkId: number; readonly activationLedgerIndex: number },
  expectedTransactionHash: string,
) {
  if (
    row.transactionHash !== expectedTransactionHash ||
    !isValidClassicAddress(row.publisher) ||
    !Number.isSafeInteger(row.ledgerIndex) ||
    row.ledgerIndex < network.activationLedgerIndex ||
    row.ledgerIndex > 4_294_967_295 ||
    !LOWERCASE_HASH.test(row.ledgerHash) ||
    !Number.isSafeInteger(row.transactionIndex) ||
    row.transactionIndex < 0
  ) {
    return invalidSchemaRegistrationEvidence()
  }
  const common = {
    status: row.status,
    publisher: row.publisher,
    ledgerIndex: row.ledgerIndex,
    ledgerHash: row.ledgerHash,
    transactionIndex: row.transactionIndex,
  }

  if (row.status === 'accepted') {
    if (
      row.schemaUid === null ||
      !LOWERCASE_HASH.test(row.schemaUid) ||
      row.reasonCode !== null ||
      row.memoJson === null
    ) {
      return invalidSchemaRegistrationEvidence()
    }
    try {
      const canonicalMemoJson = canonicalJson(row.memoJson)
      const schema = parseSchema(row.memoJson)
      const computedSchemaUid = computeSchemaUid({
        schema,
        networkId: network.networkId,
        ledgerHash: row.ledgerHash,
        ledgerIndex: row.ledgerIndex,
        transactionIndex: row.transactionIndex,
        publisher: row.publisher,
      })
      if (computedSchemaUid !== row.schemaUid) return invalidSchemaRegistrationEvidence()
      return {
        ...common,
        status: 'accepted' as const,
        schemaUid: row.schemaUid,
        schemaDigestHex: sha256Hex(encodeUtf8(canonicalMemoJson)),
        reasonCode: null,
      }
    } catch {
      return invalidSchemaRegistrationEvidence()
    }
  }

  if (row.status === 'rejected') {
    if (row.schemaUid !== null || row.reasonCode === null || !REASON_CODE.test(row.reasonCode)) {
      return invalidSchemaRegistrationEvidence()
    }
    return {
      ...common,
      status: 'rejected' as const,
      schemaUid: null,
      schemaDigestHex: null,
      reasonCode: row.reasonCode,
    }
  }

  return invalidSchemaRegistrationEvidence()
}

export function publicTransactionProjection(
  projection: Awaited<ReturnType<ApiRepository['getTransactionProjectionSummary']>>,
  network: { readonly networkId: number; readonly activationLedgerIndex: number },
  expectedTransactionHash: string,
) {
  if (
    !Number.isSafeInteger(projection.credentialEventCount) ||
    projection.credentialEventCount < 0 ||
    (projection.credentialEventCount === 0) !== (projection.firstCredentialEvent === undefined)
  ) {
    return invalidIndexerEvidence('The indexed transaction summary is incomplete or inconsistent.')
  }
  const registration =
    projection.registration === undefined
      ? null
      : publicSchemaRegistration(projection.registration, network, expectedTransactionHash)
  const firstCredentialEvent =
    projection.firstCredentialEvent === undefined
      ? null
      : publicCredentialEvent(projection.firstCredentialEvent, {
          transactionHash: expectedTransactionHash,
          issuer: projection.firstCredentialEvent.issuer,
          subject: projection.firstCredentialEvent.subject,
          schemaUid: projection.firstCredentialEvent.schemaUid,
          activationLedgerIndex: network.activationLedgerIndex,
        })
  if (registration === null && firstCredentialEvent === null) return null

  const coordinate = registration ?? firstCredentialEvent!
  if (
    registration !== null &&
    firstCredentialEvent !== null &&
    (registration.ledgerIndex !== firstCredentialEvent.ledgerIndex ||
      registration.ledgerHash !== firstCredentialEvent.ledgerHash ||
      registration.transactionIndex !== firstCredentialEvent.transactionIndex)
  ) {
    return invalidIndexerEvidence('The indexed transaction coordinates are inconsistent.')
  }
  return {
    transactionHash: expectedTransactionHash,
    ledgerIndex: coordinate.ledgerIndex,
    ledgerHash: coordinate.ledgerHash,
    transactionIndex: coordinate.transactionIndex,
    registration,
    registrationStatus: registration?.status ?? null,
    credentialEventCount: projection.credentialEventCount,
  }
}

export function publicCredentialTimeline(
  rows: readonly Awaited<ReturnType<ApiRepository['getCredentialEventsByGeneration']>>[number][],
  generation: NonNullable<Awaited<ReturnType<ApiRepository['getCredentialGenerationById']>>>,
  activationLedgerIndex: number,
) {
  if (rows.length === 0 || rows.length > CREDENTIAL_GENERATION_TIMELINE_LIMIT) {
    return invalidIndexerEvidence('The indexed credential timeline is incomplete or inconsistent.')
  }
  const items = rows.map((row) =>
    publicCredentialEvent(row, {
      transactionHash: row.transactionHash,
      issuer: generation.issuer,
      subject: generation.subject,
      schemaUid: generation.schemaUid,
      generationId: generation.generationId,
      activationLedgerIndex,
    }),
  )
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    const previous = rows[index - 1]
    if (
      row.ledgerObjectId !== generation.ledgerObjectId ||
      row.uriHex !== generation.uriHex ||
      row.expiration !== generation.expiration ||
      (previous !== undefined &&
        (row.ledgerIndex < previous.ledgerIndex ||
          (row.ledgerIndex === previous.ledgerIndex &&
            row.transactionIndex < previous.transactionIndex) ||
          (row.ledgerIndex === previous.ledgerIndex &&
            row.transactionIndex === previous.transactionIndex &&
            row.nodeIndex <= previous.nodeIndex)))
    ) {
      return invalidIndexerEvidence(
        'The indexed credential timeline is incomplete or inconsistent.',
      )
    }
  }
  const created = rows.filter((row) => row.eventType === 'created')
  const accepted = rows.filter((row) => row.eventType === 'accepted')
  const deleted = rows.filter((row) => row.eventType === 'deleted')
  const first = rows[0]!
  const last = rows.at(-1)!
  if (
    created.length !== 1 ||
    first.eventType !== 'created' ||
    first.transactionHash !== generation.generationId ||
    first.ledgerIndex !== generation.createdLedgerIndex ||
    first.transactionIndex !== generation.createdTransactionIndex ||
    accepted.length > 1 ||
    deleted.length > 1 ||
    deleted.some((row) => row.accepted !== generation.accepted) ||
    last.ledgerIndex !== generation.lastLedgerIndex ||
    generation.accepted !== (first.accepted || accepted.length === 1) ||
    (generation.deletedLedgerIndex === null
      ? deleted.length !== 0
      : deleted.length !== 1 ||
        last.eventType !== 'deleted' ||
        last.ledgerIndex !== generation.deletedLedgerIndex ||
        last.deletionCause !== generation.deletionCause)
  ) {
    return invalidIndexerEvidence('The indexed credential timeline is incomplete or inconsistent.')
  }
  return items
}
