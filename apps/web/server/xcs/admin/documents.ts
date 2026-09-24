import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { AdminError, uuid } from './domain'

export interface ReviewDocument {
  id: string
  storage_key: string
  mime_type: string
  byte_length: number
  sha256: string
}
const MAX_BYTES = 20 * 1024 * 1024
const TTL = 300
export class PrivateDocuments {
  constructor(
    private readonly directory: string,
    private readonly signingKey: string,
    private readonly now = () => Date.now(),
  ) {
    if (Buffer.byteLength(signingKey) < 32) throw new Error('ADMIN_DOCUMENT_KEY_REQUIRED')
  }
  private signature(id: string, sessionId: string, expires: number): string {
    return createHmac('sha256', this.signingKey)
      .update(JSON.stringify([id, sessionId, expires]))
      .digest('base64url')
  }
  link(id: string, sessionId: string) {
    uuid(id)
    const expires = Math.floor(this.now() / 1000) + TTL
    return {
      url: `/api/admin/documents/${id}?expires=${expires}&signature=${this.signature(id, sessionId, expires)}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    }
  }
  verify(id: string, sessionId: string, expires: unknown, signature: unknown) {
    if (
      typeof expires !== 'string' ||
      !/^\d{10,11}$/.test(expires) ||
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      throw new AdminError(403, 'ADMIN_DOCUMENT_LINK_INVALID')
    const expiry = Number(expires),
      now = Math.floor(this.now() / 1000)
    if (expiry <= now || expiry > now + TTL)
      throw new AdminError(403, 'ADMIN_DOCUMENT_LINK_EXPIRED')
    if (
      !timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(id, sessionId, expiry)))
    )
      throw new AdminError(403, 'ADMIN_DOCUMENT_LINK_INVALID')
  }
  async read(document: ReviewDocument): Promise<Buffer> {
    // Storage keys are opaque filenames, never caller-controlled paths. The private
    // volume is read-only for web; reject symlinks as well as traversal components.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\.(?:pdf|png|jpe?g))?$/.test(document.storage_key))
      throw new AdminError(422, 'ADMIN_DOCUMENT_PATH_INVALID')
    if (
      !['application/pdf', 'image/png', 'image/jpeg'].includes(document.mime_type) ||
      !Number.isSafeInteger(document.byte_length) ||
      document.byte_length < 1 ||
      document.byte_length > MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(document.sha256)
    )
      throw new AdminError(422, 'ADMIN_DOCUMENT_INVALID')
    try {
      const root = await realpath(this.directory)
      const path = join(root, document.storage_key)
      const actual = await realpath(path)
      if (!actual.startsWith(root + sep) || actual !== path)
        throw new AdminError(422, 'ADMIN_DOCUMENT_PATH_INVALID')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== document.byte_length)
          throw new AdminError(422, 'ADMIN_DOCUMENT_INTEGRITY_INVALID')
        // Bound the read even if an operator concurrently replaces/appends a file.
        const bytes = Buffer.alloc(document.byte_length + 1)
        let length = 0
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        const content = bytes.subarray(0, length)
        const magic =
          document.mime_type === 'application/pdf'
            ? content.subarray(0, 5).equals(Buffer.from('%PDF-'))
            : document.mime_type === 'image/png'
              ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        if (
          length !== document.byte_length ||
          !magic ||
          createHash('sha256').update(content).digest('hex') !== document.sha256
        )
          throw new AdminError(422, 'ADMIN_DOCUMENT_INTEGRITY_INVALID')
        return content
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof AdminError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AdminError(404, 'ADMIN_DOCUMENT_MISSING')
      throw new AdminError(422, 'ADMIN_DOCUMENT_UNREADABLE')
    }
  }
}
