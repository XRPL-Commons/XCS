import {
  computeSchemaUid,
  createHttpsPayloadUri,
  parseSchema,
  type JsonValue,
  type NetworkProfile,
  type SchemaDefinition,
} from '#xcs/core/index.js'

import { canonicalJson, encodeHexUtf8 } from '../../app/utils/serialization'
import type { ApiReply } from './http.js'

const PROFILE_ID = 'xrpl-testnet-xcs-browser-e2e'
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const SUBJECT = 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59'
const LEDGER_HASH = 'cd'.repeat(32)
const SCHEMA: SchemaDefinition = {
  xcsVersion: '0.1',
  name: 'Diploma Award',
  description: 'Attests one deterministic browser test diploma award.',
  fields: {
    programId: { type: 'string' },
    programName: { type: 'string' },
    awardedAt: { type: 'string' },
    diplomaId: { type: 'string' },
    prenom: { type: 'string' },
    honors: { type: 'string', optional: true },
  },
}
const SCHEMA_UID = computeSchemaUid({
  schema: parseSchema(SCHEMA),
  networkId: 1,
  ledgerHash: LEDGER_HASH,
  ledgerIndex: 100_001,
  transactionIndex: 1,
  publisher: ISSUER,
})
const GENERATION_ID = '34'.repeat(32)
const NO_URI_GENERATION_ID = '9a'.repeat(32)
const ACCEPTED_TRANSACTION_HASH = '78'.repeat(32)
const HISTORICAL_GENERATION_ID = '56'.repeat(32)
const DELETED_TRANSACTION_HASH = 'bc'.repeat(32)
const PAYLOAD_URL = 'https://issuer.xcs.invalid/diploma.json'
const CLAIMS = {
  programId: 'xcs-protocol-engineering-2026',
  programName: 'Protocol Engineering',
  awardedAt: '2026-08-25T10:00:00Z',
  diplomaId: 'DIP-2026-0042',
  prenom: 'Personne Test',
  honors: 'with distinction',
}
const CANONICAL_PAYLOAD = canonicalJson({
  xcsVersion: '0.1',
  issuer: ISSUER,
  subject: SUBJECT,
  schema: SCHEMA_UID,
  claims: CLAIMS,
})
const CREDENTIAL_URI = createHttpsPayloadUri(PAYLOAD_URL, CANONICAL_PAYLOAD)
const PROFILE: NetworkProfile = {
  profileId: PROFILE_ID,
  xcsVersion: '0.1',
  networkId: 1,
  requiredAmendment: 'ab'.repeat(32).toUpperCase(),
  registryAddress: SUBJECT,
  registrationAmountDrops: '1',
  activationLedgerIndex: 1,
  activationLedgerHash: 'ef'.repeat(32),
}

function ok(body: unknown): ApiReply {
  return { statusCode: 200, headers: {}, body }
}

/**
 * Rebuilds the flat path the fixtures are keyed by from the handler table's
 * route path and the request's router parameters, so the canned data below is
 * the same table the `__e2e-api` catch-all route served.
 */
function resolvePath(routePath: string, params: Record<string, string>): string {
  return routePath
    .replace(/^\/v1\//u, '')
    .split('/')
    .map((segment) => (segment.startsWith(':') ? (params[segment.slice(1)] ?? '') : segment))
    .join('/')
}

/**
 * Answers one `GET /v1/**` route from the deterministic browser end-to-end
 * fixtures, or returns `undefined` when the fixtures do not cover it.
 */
export function fixtureGet(
  routePath: string,
  params: Record<string, string>,
): ApiReply | undefined {
  const path = resolvePath(routePath, params)

  if (path === 'networks') return ok({ items: [PROFILE] })

  if (path === `networks/${PROFILE_ID}/stats`) {
    return ok({
      network: PROFILE_ID,
      schemas: { total: 12, publishers: 4 },
      credentialGenerations: {
        total: 27,
        pending: 3,
        active: 20,
        expired: 2,
        deleted: 2,
      },
      checkpoint: {
        ledgerIndex: 100_001,
        ledgerHash: LEDGER_HASH,
        closeTime: 838_857_600,
        transactionRoot: 'cd'.repeat(32),
      },
    })
  }

  if (path === `networks/${PROFILE_ID}/search`) {
    return ok({
      items: [
        {
          type: 'schema',
          schemaUid: SCHEMA_UID,
          name: SCHEMA.name,
          description: SCHEMA.description,
          publisher: ISSUER,
          parentUid: null,
          supersedesUid: null,
          registrationTransactionHash: '56'.repeat(32),
          ledgerIndex: 100_001,
          transactionIndex: 1,
        },
      ],
      hasMore: false,
    })
  }

  if (path === `networks/${PROFILE_ID}/schemas/${SCHEMA_UID}`) {
    return ok({
      schemaUid: SCHEMA_UID,
      name: SCHEMA.name,
      description: SCHEMA.description,
      publisher: ISSUER,
      parentUid: null,
      supersedesUid: null,
      definition: SCHEMA,
      resolvedDefinition: { definition: SCHEMA, fields: SCHEMA.fields, lineage: [] },
      registrationTransactionHash: '56'.repeat(32),
      ledgerIndex: 100_001,
      transactionIndex: 1,
    })
  }

  if (path === `networks/${PROFILE_ID}/credential-generations/${GENERATION_ID}`) {
    return ok({
      generation: {
        generationId: GENERATION_ID,
        ledgerObjectId: '90'.repeat(32),
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: SCHEMA_UID,
        uriHex: encodeHexUtf8(CREDENTIAL_URI),
        expiration: null,
        accepted: true,
        createdLedgerIndex: 100_001,
        createdTransactionIndex: 2,
        lastLedgerIndex: 100_002,
        deletedLedgerIndex: null,
        deletionCause: null,
      },
      state: 'active',
      timeline: [
        {
          transactionHash: GENERATION_ID,
          nodeIndex: 0,
          generationId: GENERATION_ID,
          ledgerIndex: 100_001,
          ledgerHash: LEDGER_HASH,
          transactionIndex: 2,
          eventType: 'created',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: false,
          deletionCause: null,
        },
        {
          transactionHash: ACCEPTED_TRANSACTION_HASH,
          nodeIndex: 0,
          generationId: GENERATION_ID,
          ledgerIndex: 100_002,
          ledgerHash: 'de'.repeat(32),
          transactionIndex: 1,
          eventType: 'accepted',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: true,
          deletionCause: null,
        },
      ],
    })
  }

  if (path === `networks/${PROFILE_ID}/credential-generations/${NO_URI_GENERATION_ID}`) {
    return ok({
      generation: {
        generationId: NO_URI_GENERATION_ID,
        ledgerObjectId: '92'.repeat(32),
        issuer: ISSUER,
        subject: ISSUER,
        schemaUid: SCHEMA_UID,
        uriHex: null,
        expiration: null,
        accepted: true,
        createdLedgerIndex: 100_003,
        createdTransactionIndex: 2,
        lastLedgerIndex: 100_003,
        deletedLedgerIndex: null,
        deletionCause: null,
      },
      state: 'active',
      timeline: [
        {
          transactionHash: NO_URI_GENERATION_ID,
          nodeIndex: 0,
          generationId: NO_URI_GENERATION_ID,
          ledgerIndex: 100_003,
          ledgerHash: 'fa'.repeat(32),
          transactionIndex: 2,
          eventType: 'created',
          issuer: ISSUER,
          subject: ISSUER,
          schemaUid: SCHEMA_UID,
          accepted: true,
          deletionCause: null,
        },
      ],
    })
  }

  if (path === `networks/${PROFILE_ID}/credential-generations/${HISTORICAL_GENERATION_ID}`) {
    return ok({
      generation: {
        generationId: HISTORICAL_GENERATION_ID,
        ledgerObjectId: '91'.repeat(32),
        issuer: ISSUER,
        subject: SUBJECT,
        schemaUid: SCHEMA_UID,
        uriHex: encodeHexUtf8(CREDENTIAL_URI),
        expiration: null,
        accepted: true,
        createdLedgerIndex: 99_990,
        createdTransactionIndex: 2,
        lastLedgerIndex: 99_992,
        deletedLedgerIndex: 99_992,
        deletionCause: 'issuer_revoked',
      },
      state: 'deleted',
      timeline: [
        {
          transactionHash: HISTORICAL_GENERATION_ID,
          nodeIndex: 0,
          generationId: HISTORICAL_GENERATION_ID,
          ledgerIndex: 99_990,
          ledgerHash: 'aa'.repeat(32),
          transactionIndex: 2,
          eventType: 'created',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: false,
          deletionCause: null,
        },
        {
          transactionHash: DELETED_TRANSACTION_HASH,
          nodeIndex: 0,
          generationId: HISTORICAL_GENERATION_ID,
          ledgerIndex: 99_992,
          ledgerHash: 'bb'.repeat(32),
          transactionIndex: 1,
          eventType: 'deleted',
          issuer: ISSUER,
          subject: SUBJECT,
          schemaUid: SCHEMA_UID,
          accepted: true,
          deletionCause: 'issuer_revoked',
        },
      ],
    })
  }

  if (path === `networks/${PROFILE_ID}/credentials/${ISSUER}/${SUBJECT}/${SCHEMA_UID}`) {
    return ok({
      generationId: GENERATION_ID,
      ledgerObjectId: '90'.repeat(32),
      issuer: ISSUER,
      subject: SUBJECT,
      schemaUid: SCHEMA_UID,
      uriHex: encodeHexUtf8(CREDENTIAL_URI),
      expiration: null,
      accepted: true,
      createdLedgerIndex: 100_001,
      createdTransactionIndex: 2,
      lastLedgerIndex: 100_002,
      deletedLedgerIndex: null,
      deletionCause: null,
      state: 'active',
    })
  }

  if (path === `networks/${PROFILE_ID}/credentials/${ISSUER}/${ISSUER}/${SCHEMA_UID}`) {
    return ok({
      generationId: NO_URI_GENERATION_ID,
      ledgerObjectId: '92'.repeat(32),
      issuer: ISSUER,
      subject: ISSUER,
      schemaUid: SCHEMA_UID,
      uriHex: null,
      expiration: null,
      accepted: true,
      createdLedgerIndex: 100_003,
      createdTransactionIndex: 2,
      lastLedgerIndex: 100_003,
      deletedLedgerIndex: null,
      deletionCause: null,
      state: 'active',
    })
  }

  return undefined
}

function payloadMatches(input: unknown, expected: JsonValue): boolean {
  try {
    return canonicalJson(input) === canonicalJson(expected)
  } catch {
    return false
  }
}

/** Answers `POST /v1/verify` from the fixtures, comparing the canonical payload. */
export function fixtureVerify(input: unknown): ApiReply {
  const body = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const hasPayload = Object.hasOwn(body, 'payload')
  const metadataOnlyWithoutUri = body.subject === ISSUER && !hasPayload
  const expectedPayload = {
    xcsVersion: '0.1',
    issuer: ISSUER,
    subject: SUBJECT,
    schema: body.schemaUid,
    claims: CLAIMS,
  }
  if (
    body.network !== PROFILE_ID ||
    body.issuer !== ISSUER ||
    (body.subject !== SUBJECT && body.subject !== ISSUER) ||
    typeof body.schemaUid !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(body.schemaUid) ||
    (hasPayload
      ? Object.hasOwn(body, 'resolvePayload') ||
        !payloadMatches(body.payload, expectedPayload as JsonValue)
      : body.resolvePayload !== false)
  ) {
    return {
      statusCode: 400,
      headers: {},
      body: { error: 'VALIDATION_ERROR', message: 'Browser E2E verify input invalid' },
    }
  }

  return ok({
    onChain: 'active',
    schema: 'valid',
    payload: hasPayload ? 'valid' : 'not_checked',
    issuerTrust: 'unknown',
    generationId: metadataOnlyWithoutUri ? NO_URI_GENERATION_ID : GENERATION_ID,
  })
}

/** The reply the fixtures send for a `/v1` route they hold no canned data for. */
export function fixtureNotFound(): ApiReply {
  return {
    statusCode: 404,
    headers: {},
    body: { error: 'NOT_FOUND', message: 'Browser E2E API route not found' },
  }
}
