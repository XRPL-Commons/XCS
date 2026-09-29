// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
import { createHash, randomBytes } from 'node:crypto'

/** Bearer secrets stay outside the database; persist only the returned hash. */
export function createAppToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenHash: hashAppToken(token)! }
}

export function hashAppToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
