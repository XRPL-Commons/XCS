// Copied from packages/core/test/schema.test.ts at 54c3486; keep in sync by hand (see CONTRIBUTING.md).
import { describe, expect, it } from 'vitest'

import {
  computeSchemaUid,
  parseSchema,
  parseSchemaBytes,
  resolveSchema,
  type RegisteredSchema,
} from '../../../src/lib/xcs/index.js'

const PUBLISHER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'

describe('schema', () => {
  it('parses and normalizes a schema', () => {
    const schema = parseSchema({
      xcsVersion: '0.1',
      name: 'Course completion',
      description: 'Confirms successful completion.',
      fields: {
        courseId: { type: 'string', optional: false },
        score: { type: 'uint', optional: true },
      },
    })

    expect(schema.fields.courseId).toEqual({ type: 'string' })
    expect(schema.fields.score).toEqual({ type: 'uint', optional: true })
  })

  it('treats JavaScript prototype names as ordinary schema keys', () => {
    const schema = parseSchema({
      xcsVersion: '0.1',
      name: 'Prototype-safe schema',
      description: 'Ensures field maps cannot mutate object prototypes.',
      fields: JSON.parse('{"__proto__":{"type":"string"}}'),
    })

    expect(Object.hasOwn(schema.fields, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(schema.fields)).toBeNull()
  })

  it('only accepts canonical schema bytes', () => {
    const canonical = new TextEncoder().encode(
      '{"description":"Canonical","fields":{"value":{"type":"string"}},"name":"Schema","xcsVersion":"0.1"}',
    )
    expect(parseSchemaBytes(canonical).name).toBe('Schema')
    expect(() => parseSchemaBytes(new TextEncoder().encode('{ "xcsVersion": "0.1" }'))).toThrow(
      expect.objectContaining({ code: 'NON_CANONICAL_JSON' }),
    )
    expect(() =>
      parseSchemaBytes(
        new TextEncoder().encode(
          '{"description":"First","description":"Second","fields":{"value":{"type":"string"}},"name":"Schema","xcsVersion":"0.1"}',
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_JSON' }))
  })

  it('resolves prior parents and rejects field overrides', () => {
    const parentUid = '11'.repeat(32)
    const parent: RegisteredSchema = {
      uid: parentUid,
      publisher: PUBLISHER,
      networkId: 1,
      ledgerIndex: 10,
      transactionIndex: 0,
      definition: parseSchema({
        xcsVersion: '0.1',
        name: 'Base',
        description: 'Base schema',
        fields: { courseId: { type: 'string' } },
      }),
    }
    const context = {
      networkId: 1,
      publisher: PUBLISHER,
      ledgerIndex: 11,
      transactionIndex: 0,
      getSchema: (uid: string) => (uid === parentUid ? parent : undefined),
    }
    const child = parseSchema({
      xcsVersion: '0.1',
      name: 'Result',
      description: 'Course result',
      extends: parentUid,
      fields: { score: { type: 'uint' } },
    })

    expect(Object.keys(resolveSchema(child, context).fields)).toEqual(['courseId', 'score'])
    expect(() =>
      resolveSchema(parseSchema({ ...child, fields: { courseId: { type: 'bool' } } }), context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SCHEMA_REFERENCE' }))
  })

  it('derives the published schema UID with noble SHA-256', () => {
    const schema = parseSchema({
      xcsVersion: '0.1',
      name: 'XRPL Developer Course Completion',
      description: 'Attests successful completion of the XRPL developer course.',
      fields: {
        programId: { type: 'string', optional: false },
        programName: { type: 'string' },
        completedAt: { type: 'string' },
        achievement: { type: 'string', optional: true },
      },
    })
    expect(
      computeSchemaUid({
        networkId: 1,
        ledgerHash: 'AB'.repeat(32),
        ledgerIndex: 100,
        transactionIndex: 2,
        publisher: PUBLISHER,
        schema,
      }),
    ).toBe('e1e9e4a41ff0a4c846c9218e0cb345a05457abb6f9ba90d5bd9ee18e7d2ca9a3')
  })
})
