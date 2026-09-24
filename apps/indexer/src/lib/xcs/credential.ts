// Copied from packages/core/src/credential.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { isValidClassicAddress } from 'xrpl'

import { parseClaims } from './claims.js'
import { fail, XcsError } from './errors.js'
import { canonicalJson, encodeCanonicalJson, parseCanonicalJson, type JsonObject } from './json.js'
import { parsePayloadUri, payloadBytes, verifyPayloadIntegrity } from './payload-uri.js'
import type { SchemaFields } from './schema.js'

export interface CredentialContext {
  issuer: string
  subject: string
  schemaUid: string
  fields: SchemaFields
}

export interface CredentialPayload extends JsonObject {
  xcsVersion: '0.1'
  issuer: string
  subject: string
  schema: string
  claims: JsonObject
}

export interface EncodedCredentialPayload {
  payload: CredentialPayload
  json: string
  bytes: Uint8Array
}

export type PayloadRetrieval =
  { status: 'retrieved'; content: string | Uint8Array } | { status: 'unavailable' }

export type CredentialPayloadStatus = 'valid' | 'unavailable' | 'tampered' | 'invalid'

const PAYLOAD_PROPERTIES = new Set(['xcsVersion', 'issuer', 'subject', 'schema', 'claims'])
const SCHEMA_UID = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertContext(context: CredentialContext): void {
  if (!isValidClassicAddress(context.issuer)) {
    fail('INVALID_CREDENTIAL_PAYLOAD', 'Invalid issuer address', '$context.issuer')
  }
  if (!isValidClassicAddress(context.subject)) {
    fail('INVALID_CREDENTIAL_PAYLOAD', 'Invalid subject address', '$context.subject')
  }
  if (!SCHEMA_UID.test(context.schemaUid)) {
    fail('INVALID_CREDENTIAL_PAYLOAD', 'Invalid schema UID', '$context.schemaUid')
  }
  if (!isRecord(context.fields)) {
    fail('INVALID_CREDENTIAL_PAYLOAD', 'Invalid schema fields', '$context.fields')
  }
}

function parsePayload(input: unknown, context: CredentialContext): CredentialPayload {
  assertContext(context)
  if (!isRecord(input)) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Credential payload must be an object', '$')
  }
  for (const property of Object.keys(input)) {
    if (!PAYLOAD_PROPERTIES.has(property)) {
      return fail('INVALID_CREDENTIAL_PAYLOAD', `Unknown property ${property}`, `$.${property}`)
    }
  }
  if (input.xcsVersion !== '0.1') {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Unsupported XCS version', '$.xcsVersion')
  }
  if (input.issuer !== context.issuer) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Issuer does not match the credential', '$.issuer')
  }
  if (input.subject !== context.subject) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Subject does not match the credential', '$.subject')
  }
  if (input.schema !== context.schemaUid) {
    return fail('INVALID_CREDENTIAL_PAYLOAD', 'Schema does not match CredentialType', '$.schema')
  }
  return {
    xcsVersion: '0.1',
    issuer: context.issuer,
    subject: context.subject,
    schema: context.schemaUid,
    claims: parseClaims(input.claims, context.fields),
  }
}

export function encodeCredentialPayload(
  claims: unknown,
  context: CredentialContext,
): EncodedCredentialPayload {
  const payload = parsePayload(
    {
      xcsVersion: '0.1',
      issuer: context.issuer,
      subject: context.subject,
      schema: context.schemaUid,
      claims,
    },
    context,
  )
  const json = canonicalJson(payload)
  const bytes = encodeCanonicalJson(payload)
  payloadBytes(bytes)
  return { payload, json, bytes }
}

export function parseCredentialPayload(
  content: string | Uint8Array,
  context: CredentialContext,
): CredentialPayload {
  const bytes = payloadBytes(content)
  return parsePayload(parseCanonicalJson(bytes), context)
}

export function verifyCredentialPayload(
  retrieval: PayloadRetrieval,
  uri: string,
  context: CredentialContext,
): CredentialPayloadStatus {
  try {
    parsePayloadUri(uri)
    if (retrieval.status === 'unavailable') return 'unavailable'
    if (!verifyPayloadIntegrity(retrieval.content, uri).valid) return 'tampered'
    parseCredentialPayload(retrieval.content, context)
    return 'valid'
  } catch (error) {
    if (error instanceof XcsError) return 'invalid'
    throw error
  }
}
