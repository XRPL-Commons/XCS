import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { canonicalize, parseJsonStrict, XcsError } from '../src/index.js'

interface CanonicalizationVectors {
  cases: Array<{ name: string; inputJson: string; canonical: string }>
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../conformance/v0.1/canonicalization.json', import.meta.url), 'utf8'),
) as CanonicalizationVectors

describe('strict JSON and RFC 8785 canonicalization', () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(canonicalize(parseJsonStrict(vector.inputJson))).toBe(vector.canonical)
    })
  }

  it('rejects duplicate decoded keys', () => {
    expect(() => parseJsonStrict('{"a":1,"\\u0061":2}')).toThrowError(
      expect.objectContaining({ code: 'JSON_DUPLICATE_KEY' }),
    )
  })

  it('rejects unpaired surrogates in escaped and in-memory input', () => {
    expect(() => parseJsonStrict('"\\ud800"')).toThrowError(
      expect.objectContaining({ code: 'JSON_INVALID_UNICODE' }),
    )
    expect(() => canonicalize('\udc00')).toThrowError(
      expect.objectContaining({ code: 'JSON_INVALID_UNICODE' }),
    )
  })

  it('rejects non-finite JSON numbers', () => {
    expect(() => parseJsonStrict('1e400')).toThrowError(
      expect.objectContaining({ code: 'JSON_NON_IJSON_NUMBER' }),
    )
    expect(() => canonicalize(Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'JSON_NON_IJSON_NUMBER' }),
    )
  })

  it('rejects sparse arrays constructed outside JSON', () => {
    expect(() => canonicalize(new Array(1) as never[])).toThrowError(
      expect.objectContaining({ code: 'CANONICALIZATION_UNSUPPORTED_VALUE' }),
    )
  })
})
