import type { JsonValue } from '@xcs-protocol/core'

import { parseJson } from './serialization'

const GENERATION_ID_PATTERN = /^[0-9a-f]{64}$/u
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u
const LOOPBACK_API_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export interface DeveloperCredentialCoordinates {
  readonly issuer: string
  readonly subject: string
  readonly schemaUid: string
  readonly uri: string
  readonly standaloneSchema: boolean
}

export interface DeveloperSnippetContext {
  readonly apiBaseUrl: string
  readonly profileId: string
  readonly generationId: string
  readonly credential?: DeveloperCredentialCoordinates | undefined
}

export interface DeveloperQuickstartSnippets {
  readonly curl: string
  readonly cli: string | null
  readonly typescript: string
  readonly signer: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function typescriptLiteral(value: string): string {
  return JSON.stringify(value)
}

export function normalizeDeveloperApiBaseUrl(value: string): string {
  if (value !== value.trim() || URL_CONTROL_CHARACTERS.test(value) || value.includes('\\')) {
    throw new Error('DEVELOPER_API_BASE_URL_INVALID')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('DEVELOPER_API_BASE_URL_INVALID')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    (parsed.protocol === 'http:' && !LOOPBACK_API_HOSTS.has(parsed.hostname)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('DEVELOPER_API_BASE_URL_INVALID')
  }
  return parsed.toString().replace(/\/+$/u, '')
}

export function normalizeDeveloperGenerationId(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!GENERATION_ID_PATTERN.test(normalized)) {
    throw new Error('DEVELOPER_GENERATION_ID_INVALID')
  }
  return normalized
}

export function assertDeveloperProfileId(value: string): string {
  if (!PROFILE_ID_PATTERN.test(value)) throw new Error('DEVELOPER_PROFILE_ID_INVALID')
  return value
}

export function parseDeveloperLocalPayload(value: string): JsonValue {
  const parsed = parseJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('DEVELOPER_PAYLOAD_OBJECT_REQUIRED')
  }
  return parsed as JsonValue
}

export function assertDeveloperExactGeneration(
  expectedGenerationId: string,
  actualGenerationId: string | undefined,
): void {
  const expected = normalizeDeveloperGenerationId(expectedGenerationId)
  if (
    actualGenerationId === undefined ||
    !GENERATION_ID_PATTERN.test(actualGenerationId.toLowerCase()) ||
    actualGenerationId.toLowerCase() !== expected
  ) {
    throw new Error('DEVELOPER_GENERATION_REPLACED')
  }
}

export function assertDeveloperSnapshotCurrent(
  expected: {
    readonly profileId: string
    readonly generationId: string
    readonly issuer: string
    readonly subject: string
    readonly schemaUid: string
    readonly uri: string | null
  },
  actual: {
    readonly profileId: string
    readonly generationId: string
    readonly issuer: string
    readonly subject: string
    readonly schemaUid: string
    readonly uri: string | null
  },
): void {
  assertDeveloperExactGeneration(expected.generationId, actual.generationId)
  if (
    expected.profileId !== actual.profileId ||
    expected.issuer !== actual.issuer ||
    expected.subject !== actual.subject ||
    expected.schemaUid.toLowerCase() !== actual.schemaUid.toLowerCase() ||
    expected.uri !== actual.uri
  ) {
    throw new Error('DEVELOPER_GENERATION_CHANGED')
  }
}

export function buildDeveloperQuickstartSnippets(
  input: DeveloperSnippetContext,
): DeveloperQuickstartSnippets {
  const apiBaseUrl = normalizeDeveloperApiBaseUrl(input.apiBaseUrl)
  const profileId = assertDeveloperProfileId(input.profileId)
  const generationId = normalizeDeveloperGenerationId(input.generationId)
  const credential = input.credential
  const generationPath = `/v1/networks/${encodeURIComponent(profileId)}/credential-generations/${generationId}`
  const schemaPath = `/v1/networks/${encodeURIComponent(profileId)}/schemas`

  const curlMetadata = `set -euo pipefail
API_BASE=${shellQuote(apiBaseUrl)}
PROFILE_ID=${shellQuote(profileId)}
GENERATION_ID=${shellQuote(generationId)}

generation="$(curl --fail --silent --show-error "$API_BASE${generationPath}")"
issuer="$(printf '%s' "$generation" | jq -r '.generation.issuer')"
subject="$(printf '%s' "$generation" | jq -r '.generation.subject')"
schema_uid="$(printf '%s' "$generation" | jq -r '.generation.schemaUid')"

curl --fail --silent --show-error \\
  "$API_BASE${schemaPath}/$schema_uid" > schema-response.json

metadata_report="$(jq -n \\
  --arg network "$PROFILE_ID" --arg issuer "$issuer" \\
  --arg subject "$subject" --arg schemaUid "$schema_uid" \\
  '{network:$network,issuer:$issuer,subject:$subject,schemaUid:$schemaUid,resolvePayload:false}' \\
  | curl --fail --silent --show-error -H 'content-type: application/json' \\
      --data-binary @- "$API_BASE/v1/verify")"

test "$(printf '%s' "$metadata_report" | jq -r '.generationId')" = "$GENERATION_ID"`

  const curl =
    credential === undefined
      ? `${curlMetadata}
printf '%s' "$metadata_report" | jq '{onChain,schema,payload,issuerTrust}'`
      : `${curlMetadata}
PAYLOAD_FILE=./credential.json

# REST-only caveat: jq parses the file and the API canonicalizes the object.
# This report does not prove that credential.json was already byte-for-byte canonical.
report="$(jq -n --slurpfile payload "$PAYLOAD_FILE" \\
  --arg network "$PROFILE_ID" --arg issuer "$issuer" \\
  --arg subject "$subject" --arg schemaUid "$schema_uid" \\
  '{network:$network,issuer:$issuer,subject:$subject,schemaUid:$schemaUid,payload:$payload[0]}' \\
  | curl --fail --silent --show-error -H 'content-type: application/json' \\
      --data-binary @- "$API_BASE/v1/verify")"

test "$(printf '%s' "$report" | jq -r '.generationId')" = "$GENERATION_ID"
printf '%s' "$report" | jq '{onChain,schema,payload,issuerTrust}'`

  const typescriptMetadata = `const API_BASE = ${typescriptLiteral(apiBaseUrl)}
const PROFILE_ID = ${typescriptLiteral(profileId)}
const GENERATION_ID = ${typescriptLiteral(generationId)}

async function json(path: string, init?: RequestInit) {
  const response = await fetch(\`\${API_BASE}\${path}\`, init)
  if (!response.ok) throw new Error(\`XCS API HTTP \${response.status}\`)
  return response.json()
}

const exact = await json(
  \`/v1/networks/\${encodeURIComponent(PROFILE_ID)}/credential-generations/\${GENERATION_ID}\`,
)
const { issuer, subject, schemaUid } = exact.generation
const schema = await json(
  \`/v1/networks/\${encodeURIComponent(PROFILE_ID)}/schemas/\${schemaUid}\`,
)

const verify = (body: object) =>
  json('/v1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network: PROFILE_ID, issuer, subject, schemaUid, ...body }),
  })

const metadata = await verify({ resolvePayload: false })
if (metadata.generationId !== GENERATION_ID) throw new Error('GENERATION_REPLACED')`

  const typescript =
    credential === undefined
      ? `${typescriptMetadata}
console.log({
  schemaName: schema.name,
  onChain: metadata.onChain,
  schema: metadata.schema,
  payload: metadata.payload,
  issuerTrust: metadata.issuerTrust,
})`
      : `import { readFile } from 'node:fs/promises'
import {
  credentialHexToUri,
  parseCredentialPayload,
  verifyPayloadIntegrity,
} from '@xcs-protocol/sdk'

const API_BASE = ${typescriptLiteral(apiBaseUrl)}
const PROFILE_ID = ${typescriptLiteral(profileId)}
const GENERATION_ID = ${typescriptLiteral(generationId)}

async function json(path: string, init?: RequestInit) {
  const response = await fetch(\`\${API_BASE}\${path}\`, init)
  if (!response.ok) throw new Error(\`XCS API HTTP \${response.status}\`)
  return response.json()
}

const exact = await json(
  \`/v1/networks/\${encodeURIComponent(PROFILE_ID)}/credential-generations/\${GENERATION_ID}\`,
)
const { issuer, subject, schemaUid, uriHex } = exact.generation
const schema = await json(
  \`/v1/networks/\${encodeURIComponent(PROFILE_ID)}/schemas/\${schemaUid}\`,
)

const verify = (body: object) =>
  json('/v1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network: PROFILE_ID, issuer, subject, schemaUid, ...body }),
  })

const metadata = await verify({ resolvePayload: false })
if (metadata.generationId !== GENERATION_ID) throw new Error('GENERATION_REPLACED')

const payloadText = await readFile('./credential.json', 'utf8')
const payloadUri = credentialHexToUri(uriHex)
const payload = parseCredentialPayload(payloadText, {
  issuer,
  subject,
  schemaUid,
  fields: schema.resolvedDefinition.fields,
})
if (!verifyPayloadIntegrity(payloadText, payloadUri).valid) {
  throw new Error('PAYLOAD_INTEGRITY_INVALID')
}

// Re-read metadata immediately before transmitting the public claims.
const before = await verify({ resolvePayload: false })
if (before.generationId !== GENERATION_ID) throw new Error('GENERATION_REPLACED')

// Deliberately omit resolvePayload: the supplied payload is validated, never resolved.
const report = await verify({ payload })
if (report.generationId !== GENERATION_ID) throw new Error('GENERATION_REPLACED')
console.log({
  onChain: report.onChain,
  schema: report.schema,
  payload: report.payload,
  issuerTrust: report.issuerTrust,
})`

  const localCliCheck =
    credential?.standaloneSchema === true
      ? `# Local-only schema + integrity check; no claims are sent to the API.
jq '.definition' schema-response.json > schema.json
pnpm --filter @xcs-protocol/cli exec node dist/bin.js payload check ./credential.json \\
  --schema-file ./schema.json \\
  --issuer ${shellQuote(credential.issuer)} \\
  --subject ${shellQuote(credential.subject)} \\
  --schema ${shellQuote(credential.schemaUid)} \\
  --uri ${shellQuote(credential.uri)}`
      : `# Local payload check skipped: this schema inherits fields.
# The alpha CLI accepts standalone schemas only; use the TypeScript resolvedDefinition path.`
  const cli = credential
    ? `set -euo pipefail

# From this monorepo (the package is not advertised as published yet)
pnpm --filter @xcs-protocol/cli... build

API_BASE=${shellQuote(apiBaseUrl)}
PROFILE_ID=${shellQuote(profileId)}
GENERATION_ID=${shellQuote(generationId)}
SCHEMA_UID=${shellQuote(credential.schemaUid)}

curl --fail --silent --show-error \\
  "$API_BASE${schemaPath}/$SCHEMA_UID" > schema-response.json

${localCliCheck}

# Four API dimensions; this transmits the public claims but never asks the API to resolve the URI.
cli_report="$(pnpm --filter @xcs-protocol/cli exec node dist/bin.js credential verify \\
  --api ${shellQuote(apiBaseUrl)} \\
  --network ${shellQuote(profileId)} \\
  --issuer ${shellQuote(credential.issuer)} \\
  --subject ${shellQuote(credential.subject)} \\
  --schema ${shellQuote(credential.schemaUid)} \\
  --payload ./credential.json)"
test "$(printf '%s' "$cli_report" | jq -r '.generationId')" = ${shellQuote(generationId)}
printf '%s' "$cli_report" | jq '{onChain,schema,payload,issuerTrust}'`
    : null

  const signer = `import {
  autofillXcsTransaction,
  buildCredentialCreate,
  connectAndValidateNetwork,
  signPreparedAndSubmit,
  type Signer,
} from '@xcs-protocol/sdk'

await connectAndValidateNetwork(xrplClient, profile)
const unsigned = buildCredentialCreate({ issuer, subject, schemaUid, uri })
const prepared = await autofillXcsTransaction(xrplClient, unsigned)

// Your wallet adapter owns signing. XCS never receives a seed or private key.
const signer: Signer = walletSigner
await reviewInYourUi(prepared.transaction)
const result = await signPreparedAndSubmit(xrplClient, prepared.transaction, signer, { journal })
if (result.status !== 'validated' || result.transactionResult !== 'tesSUCCESS') {
  throw new Error('CREDENTIAL_NOT_VALIDATED')
}`

  return { curl, cli, typescript, signer }
}
