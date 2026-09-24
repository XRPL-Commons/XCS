// Copied from packages/core/src/index.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
export {
  encodeCredentialPayload,
  parseCredentialPayload,
  verifyCredentialPayload,
  type CredentialContext,
  type CredentialPayload,
  type CredentialPayloadStatus,
  type EncodedCredentialPayload,
  type PayloadRetrieval,
} from './credential.js'
export { XcsError, type XcsErrorCode } from './errors.js'
export {
  canonicalJson,
  decodeHexUtf8,
  decodeUtf8,
  encodeCanonicalJson,
  encodeHexUtf8,
  encodeUtf8,
  parseCanonicalJson,
  parseJson,
  sha256Hex,
  utf8ByteLength,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
} from './json.js'
export { parseNetworkProfile, rippleTimeToIso, type NetworkProfile } from './network.js'
export {
  createHttpsPayloadUri,
  createIpfsPayloadUri,
  parsePayloadUri,
  verifyPayloadIntegrity,
  type HttpsPayloadUri,
  type IpfsPayloadUri,
  type PayloadIntegrityResult,
  type PayloadUri,
} from './payload-uri.js'
export {
  projectCredentialLifecycle,
  type CredentialLifecycleInput,
  type CredentialLifecycleState,
} from './lifecycle.js'
export { resolveSchema, type SchemaResolutionContext } from './schema-resolution.js'
export {
  encodeSchema,
  parseSchema,
  parseSchemaBytes,
  type ArrayFieldDescriptor,
  type FieldDescriptor,
  type ObjectFieldDescriptor,
  type RegisteredSchema,
  type ResolvedSchema,
  type ScalarFieldDescriptor,
  type ScalarFieldType,
  type SchemaDefinition,
  type SchemaFields,
} from './schema.js'
export { computeSchemaUid, type SchemaUidInput } from './schema-uid.js'
