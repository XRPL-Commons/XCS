import type {
  FieldDescriptor,
  JsonObject,
  ResolvedSchema,
  ScalarFieldType,
} from '#xcs/core/index.js'

export interface GuidedClaimField {
  name: string
  type: ScalarFieldType
  optional: boolean
  value: string | undefined
}

function scalarField(name: string, descriptor: FieldDescriptor): GuidedClaimField {
  if (descriptor.type === 'array' || descriptor.type === 'object') {
    throw new Error('GUIDED_CLAIMS_ADVANCED_SCHEMA')
  }
  return {
    name,
    type: descriptor.type,
    optional: descriptor.optional === true,
    value: undefined,
  }
}

export function resolvedSchemaToGuidedClaims(schema: ResolvedSchema): GuidedClaimField[] {
  return Object.entries(schema.fields).map(([name, descriptor]) => scalarField(name, descriptor))
}

export function claimsObjectToGuidedClaims(
  fields: readonly GuidedClaimField[],
  input: unknown,
): GuidedClaimField[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('GUIDED_CLAIMS_OBJECT_REQUIRED')
  }

  const claims = input as Record<string, unknown>
  const knownFields = new Set(fields.map((field) => field.name))
  for (const name of Object.keys(claims)) {
    if (!knownFields.has(name)) throw new Error(`CLAIM_UNKNOWN:${name}`)
  }

  return fields.map((field) => {
    if (!Object.hasOwn(claims, field.name)) return { ...field, value: undefined }
    const value = claims[field.name]
    if (field.type === 'bool') {
      if (typeof value !== 'boolean') throw new Error(`CLAIM_BOOLEAN_INVALID:${field.name}`)
      return { ...field, value: String(value) }
    }
    if (typeof value !== 'string') throw new Error(`CLAIM_STRING_INVALID:${field.name}`)
    return { ...field, value }
  })
}

export function guidedClaimsToObject(fields: readonly GuidedClaimField[]): JsonObject {
  for (const field of fields) {
    if (!field.optional && field.value === undefined)
      throw new Error(`CLAIM_REQUIRED:${field.name}`)
  }
  return guidedClaimsToPartialObject(fields)
}

export function guidedClaimsToPartialObject(fields: readonly GuidedClaimField[]): JsonObject {
  const claims = Object.create(null) as JsonObject
  for (const field of fields) {
    if (field.value === undefined) continue
    if (field.type === 'bool') {
      if (field.value !== 'true' && field.value !== 'false') {
        throw new Error(`CLAIM_BOOLEAN_INVALID:${field.name}`)
      }
      claims[field.name] = field.value === 'true'
    } else {
      claims[field.name] = field.value
    }
  }
  return claims
}

export function guidedClaimsToJson(fields: readonly GuidedClaimField[]): string {
  return JSON.stringify(guidedClaimsToObject(fields), null, 2)
}
