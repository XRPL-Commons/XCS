import { sql } from 'drizzle-orm'

// sql.raw is safe here because these patterns are compile-time constants. A
// bound parameter inside a CHECK expression would produce invalid DDL.
export const HASH_PATTERN = sql.raw("'^[0-9a-f]{64}$'")
export const ADDRESS_PATTERN = sql.raw("'^r[1-9A-HJ-NP-Za-km-z]{24,34}$'")
export const ERROR_CODE_PATTERN = sql.raw("'^[A-Z][A-Z0-9_]{0,63}$'")
export const WRITER_ID_PATTERN = sql.raw("'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'")
