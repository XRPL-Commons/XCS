import { createHmac, timingSafeEqual } from 'node:crypto'
import { AdminError, uuid } from './domain'
import {
  FilesystemPrivateDocumentBackend,
  readStoredPrivateDocument,
  type PrivateDocumentBackend,
} from '../documents/storage'

export interface ReviewDocument {
  id: string
  storage_key: string
  mime_type: string
  byte_length: number
  sha256: string
}
const TTL = 300
export class PrivateDocuments {
  private readonly backend: PrivateDocumentBackend

  constructor(
    backend: PrivateDocumentBackend | string,
    private readonly signingKey: string,
    private readonly now = () => Date.now(),
  ) {
    if (Buffer.byteLength(signingKey) < 32) throw new Error('ADMIN_DOCUMENT_KEY_REQUIRED')
    try {
      this.backend =
        typeof backend === 'string' ? new FilesystemPrivateDocumentBackend(backend) : backend
    } catch {
      throw new Error('ADMIN_DOCUMENT_STORAGE_INVALID')
    }
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
    try {
      const content = await readStoredPrivateDocument(this.backend, {
        storageKey: document.storage_key,
        mimeType: document.mime_type,
        byteLength: document.byte_length,
        sha256: document.sha256,
      })
      if (!content) throw new AdminError(404, 'ADMIN_DOCUMENT_MISSING')
      return content
    } catch (error) {
      if (error instanceof AdminError) throw error
      if ((error as Error).message === 'DOCUMENT_OBJECT_KEY_INVALID')
        throw new AdminError(422, 'ADMIN_DOCUMENT_PATH_INVALID')
      if ((error as Error).message === 'DOCUMENT_METADATA_INVALID')
        throw new AdminError(422, 'ADMIN_DOCUMENT_INVALID')
      if (
        ['DOCUMENT_OBJECT_INTEGRITY_INVALID', 'DOCUMENT_OBJECT_TOO_LARGE'].includes(
          (error as Error).message,
        )
      )
        throw new AdminError(422, 'ADMIN_DOCUMENT_INTEGRITY_INVALID')
      if ((error as Error).message === 'DOCUMENT_OBJECT_PATH_INVALID')
        throw new AdminError(422, 'ADMIN_DOCUMENT_PATH_INVALID')
      throw new AdminError(422, 'ADMIN_DOCUMENT_UNREADABLE')
    }
  }
}
