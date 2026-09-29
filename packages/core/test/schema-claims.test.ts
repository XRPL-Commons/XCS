import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  resolveSchema,
  validateClaims,
  validateSchema,
  XcsError,
  type RegisteredSchema,
  type SchemaDefinition,
} from '../src/index.js'

interface ClaimsVectors {
  schema: SchemaDefinition
  cases: Array<{
    name: string
    valid: boolean
    errorCode?: string
    claims: unknown
  }>
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../conformance/v0.1/claims.json', import.meta.url), 'utf8'),
) as ClaimsVectors

describe('schema validation and resolution', () => {
  const rootUid = '11'.repeat(32)
  const root: RegisteredSchema = {
    uid: rootUid,
    publisher: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    networkId: 1,
    ledgerIndex: 10,
    transactionIndex: 1,
    definition: validateSchema({
      xcsVersion: '0.1',
      name: 'Base',
      description: 'Base schema',
      fields: { programId: { type: 'string', optional: false } },
    }),
  }

  it('normalizes optional=false and resolves one prior parent', () => {
    expect(root.definition.fields.programId).toEqual({ type: 'string' })
    const child = validateSchema({
      xcsVersion: '0.1',
      name: 'Child',
      description: 'Child schema',
      extends: rootUid,
      fields: { completedAt: { type: 'string' } },
    })
    const resolved = resolveSchema(child, {
      networkId: 1,
      publisher: root.publisher,
      ledgerIndex: 11,
      transactionIndex: 0,
      getSchema: (uid) => (uid === rootUid ? root : undefined),
    })
    expect(resolved.lineage).toEqual([rootUid])
    expect(Object.keys(resolved.fields)).toEqual(['programId', 'completedAt'])
  })

  it('preserves __proto__ as an own required field through inheritance', () => {
    const child = validateSchema({
      xcsVersion: '0.1',
      name: 'Prototype-safe child',
      description: 'Reserved JavaScript names remain ordinary XCS fields',
      extends: rootUid,
      fields: JSON.parse('{"__proto__":{"type":"string"}}'),
    })
    const resolved = resolveSchema(child, {
      networkId: 1,
      publisher: root.publisher,
      ledgerIndex: 11,
      transactionIndex: 0,
      getSchema: (uid) => (uid === rootUid ? root : undefined),
    })

    expect(Object.getPrototypeOf(resolved.fields)).toBeNull()
    expect(Object.hasOwn(resolved.fields, '__proto__')).toBe(true)
    expect(Object.keys(resolved.fields)).toEqual(['programId', '__proto__'])
    expect(() => validateClaims({ programId: 'course-1' }, resolved)).toThrowError(
      expect.objectContaining({ code: 'CLAIMS_INVALID', path: '$.claims.__proto__' }),
    )

    const claims = validateClaims(
      JSON.parse('{"programId":"course-1","__proto__":"ordinary-value"}'),
      resolved,
    )
    expect(Object.getPrototypeOf(claims)).toBeNull()
    expect(Object.hasOwn(claims, '__proto__')).toBe(true)
    expect(claims.__proto__).toBe('ordinary-value')
  })

  it('rejects control characters in human-readable metadata', () => {
    expect(() =>
      validateSchema({
        xcsVersion: '0.1',
        name: 'Unsafe\u0000name',
        description: 'Description',
        fields: { value: { type: 'string' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_INVALID' }))
    expect(() =>
      validateSchema({
        xcsVersion: '0.1',
        name: 'Name',
        description: 'Unsafe\u0085description',
        fields: { value: { type: 'string' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_INVALID' }))
  })

  it('forbids inherited field overrides', () => {
    const child = validateSchema({
      xcsVersion: '0.1',
      name: 'Child',
      description: 'Child schema',
      extends: rootUid,
      fields: { programId: { type: 'bool' } },
    })
    expect(() =>
      resolveSchema(child, {
        networkId: 1,
        publisher: root.publisher,
        ledgerIndex: 11,
        transactionIndex: 0,
        getSchema: () => root,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_OVERRIDE_FORBIDDEN' }))
  })

  it('requires supersedes to target an earlier schema by the same publisher', () => {
    const replacement = validateSchema({
      xcsVersion: '0.1',
      name: 'Replacement',
      description: 'Replacement schema',
      supersedes: rootUid,
      fields: { replacement: { type: 'bool' } },
    })
    expect(() =>
      resolveSchema(replacement, {
        networkId: 1,
        publisher: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn',
        ledgerIndex: 11,
        transactionIndex: 0,
        getSchema: () => root,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_SUPERSEDES_PUBLISHER_MISMATCH' }))
  })

  it('enforces the 256-field and 16-level limits', () => {
    const tooManyFields = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field_${index}`, { type: 'string' }]),
    )
    expect(() =>
      validateSchema({
        xcsVersion: '0.1',
        name: 'Too many fields',
        description: 'Limit test',
        fields: tooManyFields,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_FIELD_LIMIT_EXCEEDED' }))

    const catalog = new Map<string, RegisteredSchema>()
    for (let index = 0; index < 16; index += 1) {
      const uid = index.toString(16).padStart(64, '0')
      catalog.set(uid, {
        uid,
        publisher: root.publisher,
        networkId: 1,
        ledgerIndex: index + 1,
        transactionIndex: 0,
        definition: validateSchema({
          xcsVersion: '0.1',
          name: `Level ${index}`,
          description: 'Inheritance limit test',
          ...(index > 0 ? { extends: (index - 1).toString(16).padStart(64, '0') } : {}),
          fields: { [`level_${index}`]: { type: 'string' } },
        }),
      })
    }
    const depthSixteen = validateSchema({
      xcsVersion: '0.1',
      name: 'Allowed level',
      description: 'Inheritance limit test',
      extends: (14).toString(16).padStart(64, '0'),
      fields: { allowed_level: { type: 'string' } },
    })
    expect(
      resolveSchema(depthSixteen, {
        networkId: 1,
        publisher: root.publisher,
        ledgerIndex: 16,
        transactionIndex: 0,
        getSchema: (uid) => catalog.get(uid),
      }).lineage,
    ).toHaveLength(15)

    const depthSeventeen = validateSchema({
      xcsVersion: '0.1',
      name: 'Level 16',
      description: 'Inheritance limit test',
      extends: (15).toString(16).padStart(64, '0'),
      fields: { level_16: { type: 'string' } },
    })
    expect(() =>
      resolveSchema(depthSeventeen, {
        networkId: 1,
        publisher: root.publisher,
        ledgerIndex: 17,
        transactionIndex: 0,
        getSchema: (uid) => catalog.get(uid),
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_DEPTH_EXCEEDED' }))
  })

  it('counts array item descriptors in local and inherited field limits', () => {
    const arrayFields = (prefix: string, count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `${prefix}_${index}`,
          { type: 'array', items: { type: 'string' } },
        ]),
      )

    expect(() =>
      validateSchema({
        xcsVersion: '0.1',
        name: 'At the descriptor limit',
        description: 'Every array and its item are separate descriptors',
        fields: arrayFields('field', 128),
      }),
    ).not.toThrow()
    expect(() =>
      validateSchema({
        xcsVersion: '0.1',
        name: 'Over the descriptor limit',
        description: 'Array item descriptors must count toward the limit',
        fields: arrayFields('field', 129),
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_FIELD_LIMIT_EXCEEDED' }))

    const nestedFields = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 127 }, (_, index) => [`${prefix}_${index}`, { type: 'string' }]),
      )
    const parentUid = '22'.repeat(32)
    const parent: RegisteredSchema = {
      uid: parentUid,
      publisher: root.publisher,
      networkId: 1,
      ledgerIndex: 20,
      transactionIndex: 0,
      definition: validateSchema({
        xcsVersion: '0.1',
        name: 'Array parent',
        description: 'Parent with an object descriptor nested in an array',
        fields: {
          parentItems: {
            type: 'array',
            items: { type: 'object', fields: nestedFields('parent') },
          },
        },
      }),
    }
    const child = validateSchema({
      xcsVersion: '0.1',
      name: 'Array child',
      description: 'Child that pushes the resolved descriptor count over the limit',
      extends: parentUid,
      fields: {
        childItems: {
          type: 'array',
          items: { type: 'object', fields: nestedFields('child') },
        },
      },
    })

    expect(() =>
      resolveSchema(child, {
        networkId: 1,
        publisher: root.publisher,
        ledgerIndex: 21,
        transactionIndex: 0,
        getSchema: (uid) => (uid === parentUid ? parent : undefined),
      }),
    ).toThrowError(expect.objectContaining({ code: 'SCHEMA_FIELD_LIMIT_EXCEEDED' }))
  })
})

describe('claim validation conformance', () => {
  const schema = validateSchema(vectors.schema)
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      if (vector.valid) {
        expect(validateClaims(vector.claims, schema.fields)).toEqual(vector.claims)
      } else {
        expect(() => validateClaims(vector.claims, schema.fields)).toThrowError(
          expect.objectContaining({ code: vector.errorCode }),
        )
      }
    })
  }

  it('rejects null and signed/unsigned overflow', () => {
    expect(() => validateClaims({ text: null }, { text: { type: 'string' } })).toThrowError(
      expect.objectContaining({ code: 'CLAIMS_INVALID' }),
    )
    expect(() =>
      validateClaims({ n: (1n << 256n).toString() }, { n: { type: 'uint' } }),
    ).toThrowError(expect.objectContaining({ code: 'CLAIMS_INVALID' }))
  })

  it('accepts a raw schema whose claim is literally named "fields"', () => {
    expect(validateClaims({ fields: 'value' }, { fields: { type: 'string' } })).toEqual({
      fields: 'value',
    })
  })
})
