import { describe, expect, it } from 'vitest'

import {
  authoritativeSchemaCatalogBundle,
  MAX_SCHEMA_CATALOG_ENTRIES,
} from '../src/schema-catalog.js'

describe('authoritativeSchemaCatalogBundle', () => {
  it('preserves a machine-readable cause when the catalog exceeds its bound', () => {
    expect(() =>
      authoritativeSchemaCatalogBundle({
        network: {} as never,
        checkpoint: {} as never,
        target: {} as never,
        evidence: Array.from({ length: MAX_SCHEMA_CATALOG_ENTRIES + 1 }, () => null) as never,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SCHEMA_PROJECTION_INVALID',
        cause: expect.objectContaining({ code: 'SCHEMA_CATALOG_LIMIT_EXCEEDED' }),
      }),
    )
  })
})
