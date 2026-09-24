import type { ResolvedSchema } from '#xcs/core/index.js'
import { describe, expect, it } from 'vitest'

import {
  claimsObjectToGuidedClaims,
  guidedClaimsToObject,
  guidedClaimsToPartialObject,
  resolvedSchemaToGuidedClaims,
} from '../app/utils/claimAuthoring'

const schema: ResolvedSchema = {
  definition: {
    xcsVersion: '0.1',
    name: 'Course Completion',
    description: 'Completion schema.',
    fields: {
      courseId: { type: 'string' },
      passed: { type: 'bool' },
      score: { type: 'uint', optional: true },
    },
  },
  fields: {
    courseId: { type: 'string' },
    passed: { type: 'bool' },
    score: { type: 'uint', optional: true },
  },
  lineage: [],
}

describe('guided claim authoring', () => {
  it('builds scalar inputs from the complete resolved schema', () => {
    expect(resolvedSchemaToGuidedClaims(schema)).toEqual([
      { name: 'courseId', type: 'string', optional: false, value: undefined },
      { name: 'passed', type: 'bool', optional: false, value: undefined },
      { name: 'score', type: 'uint', optional: true, value: undefined },
    ])
  })

  it('converts booleans and omits empty optional values', () => {
    const fields = resolvedSchemaToGuidedClaims(schema)
    fields[0]!.value = 'course-1'
    fields[1]!.value = 'true'
    expect(guidedClaimsToObject(fields)).toEqual({ courseId: 'course-1', passed: true })
  })

  it('retains canonical decimal values as strings', () => {
    const fields = resolvedSchemaToGuidedClaims(schema)
    fields[0]!.value = 'course-1'
    fields[1]!.value = 'false'
    fields[2]!.value = '42'
    expect(guidedClaimsToObject(fields)).toEqual({
      courseId: 'course-1',
      passed: false,
      score: '42',
    })
  })

  it('rejects missing required values', () => {
    expect(() => guidedClaimsToObject(resolvedSchemaToGuidedClaims(schema))).toThrow(
      'CLAIM_REQUIRED:courseId',
    )
    expect(guidedClaimsToPartialObject(resolvedSchemaToGuidedClaims(schema))).toEqual({})
  })

  it('keeps nested schemas in advanced JSON mode', () => {
    expect(() =>
      resolvedSchemaToGuidedClaims({
        ...schema,
        fields: { result: { type: 'object', fields: { passed: { type: 'bool' } } } },
      }),
    ).toThrow('GUIDED_CLAIMS_ADVANCED_SCHEMA')
  })

  it('preserves legal prototype-like claim names without changing object prototypes', () => {
    const fields = [{ name: '__proto__', type: 'string', optional: false, value: 'value' }] as const
    const claims = guidedClaimsToObject(fields)
    expect(Object.hasOwn(claims, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(claims)).toBeNull()
  })

  it('round-trips JSON claims into guided fields without changing their meaning', () => {
    const fields = resolvedSchemaToGuidedClaims(schema)
    expect(
      claimsObjectToGuidedClaims(fields, {
        courseId: 'course-42',
        passed: false,
        score: '95',
      }),
    ).toEqual([
      { ...fields[0], value: 'course-42' },
      { ...fields[1], value: 'false' },
      { ...fields[2], value: '95' },
    ])
  })

  it('distinguishes an absent claim from a present empty string allowed by v0.1', () => {
    const fields = resolvedSchemaToGuidedClaims(schema)
    const converted = claimsObjectToGuidedClaims(fields, { courseId: '', passed: true })
    expect(converted[0]?.value).toBe('')
    expect(converted[2]?.value).toBeUndefined()
    expect(guidedClaimsToObject(converted)).toEqual({ courseId: '', passed: true })
  })

  it('rejects JSON that the guided editor cannot represent exactly', () => {
    const fields = resolvedSchemaToGuidedClaims(schema)
    expect(() => claimsObjectToGuidedClaims(fields, { other: 'value' })).toThrow(
      'CLAIM_UNKNOWN:other',
    )
    expect(() =>
      claimsObjectToGuidedClaims(fields, { courseId: 'course-42', passed: 'true' }),
    ).toThrow('CLAIM_BOOLEAN_INVALID:passed')
  })
})
