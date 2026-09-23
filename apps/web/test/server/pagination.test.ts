import { describe, expect, it } from 'vitest'

import {
  decodeSchemaCursor,
  decodeSchemaRegistrationCursor,
  encodeSchemaCursor,
  encodeSchemaRegistrationCursor,
} from '../../server/xcs/pagination.js'

const HASH = 'ab'.repeat(32)

describe('API cursor database boundaries', () => {
  it('accepts PostgreSQL int4 transaction indexes at the exact upper bound', () => {
    expect(
      decodeSchemaCursor(
        encodeSchemaCursor({
          ledgerIndex: 4_294_967_295,
          transactionIndex: 2_147_483_647,
          schemaUid: HASH,
        }),
      ),
    ).toMatchObject({ transactionIndex: 2_147_483_647 })
    expect(
      decodeSchemaRegistrationCursor(
        encodeSchemaRegistrationCursor({
          ledgerIndex: 4_294_967_295,
          transactionIndex: 2_147_483_647,
          transactionHash: HASH,
        }),
      ),
    ).toMatchObject({ transactionIndex: 2_147_483_647 })
  })

  it('rejects transaction indexes that PostgreSQL integer comparisons cannot bind', () => {
    const schemaCursor = Buffer.from(
      JSON.stringify({ ledgerIndex: 100, transactionIndex: 2_147_483_648, schemaUid: HASH }),
    ).toString('base64url')
    const registrationCursor = Buffer.from(
      JSON.stringify({
        ledgerIndex: 100,
        transactionIndex: 2_147_483_648,
        transactionHash: HASH,
      }),
    ).toString('base64url')

    expect(() => decodeSchemaCursor(schemaCursor)).toThrow('Invalid cursor')
    expect(() => decodeSchemaRegistrationCursor(registrationCursor)).toThrow('Invalid cursor')
  })
})
