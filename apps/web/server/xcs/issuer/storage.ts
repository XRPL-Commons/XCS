import { randomBytes } from 'node:crypto'
import {
  FilesystemPrivateDocumentBackend,
  MAX_PRIVATE_DOCUMENT_BYTES,
  privateDocumentDigest,
  readStoredPrivateDocument,
  type PrivateDocumentBackend,
} from '../documents/storage'

export const MAX_DOCUMENT_BYTES = MAX_PRIVATE_DOCUMENT_BYTES

export interface DocumentMetadata {
  storageKey: string
  mimeType: string
  byteLength: number
  sha256: string
}

export interface IssuerDocumentStore {
  write(input: { mimeType: string; base64: string }): Promise<DocumentMetadata>
  remove(storageKey: string): Promise<void>
  release?(storageKey: string): void
}

const extensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

function documentBytes(input: { mimeType: string; base64: string }): Buffer {
  if (
    !input ||
    !Object.hasOwn(extensions, input.mimeType) ||
    typeof input.base64 !== 'string' ||
    input.base64.length < 4 ||
    input.base64.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 ||
    input.base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  )
    throw new Error('ISSUER_DOCUMENT_INVALID')
  const bytes = Buffer.from(input.base64, 'base64')
  const magic =
    input.mimeType === 'application/pdf'
      ? bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : input.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (bytes.length > MAX_DOCUMENT_BYTES || bytes.toString('base64') !== input.base64 || !magic)
    throw new Error('ISSUER_DOCUMENT_INVALID')
  return bytes
}

/** Private document volume shared with the administrator's integrity-checked reader. */
export class PrivateDocumentStorage implements IssuerDocumentStore {
  private readonly backend: PrivateDocumentBackend
  private readonly owned = new Set<string>()

  constructor(backend: PrivateDocumentBackend | string) {
    try {
      this.backend =
        typeof backend === 'string' ? new FilesystemPrivateDocumentBackend(backend) : backend
    } catch {
      throw new Error('ISSUER_DOCUMENT_STORAGE_INVALID')
    }
  }

  async write(input: { mimeType: string; base64: string }): Promise<DocumentMetadata> {
    const bytes = documentBytes(input)
    const storageKey = `${randomBytes(32).toString('hex')}.${extensions[input.mimeType]}`
    try {
      await this.backend.put(storageKey, input.mimeType, bytes)
      this.owned.add(storageKey)
    } catch (error) {
      if ((error as Error).message === 'DOCUMENT_FILESYSTEM_ROOT_INVALID')
        throw new Error('ISSUER_DOCUMENT_STORAGE_INVALID', { cause: error })
      throw new Error('ISSUER_DOCUMENT_WRITE_FAILED', { cause: error })
    }
    return {
      storageKey,
      mimeType: input.mimeType,
      byteLength: bytes.length,
      sha256: privateDocumentDigest(bytes),
    }
  }

  async read(document: DocumentMetadata): Promise<Buffer> {
    try {
      const bytes = await readStoredPrivateDocument(this.backend, document)
      if (!bytes) throw new Error('ADMIN_DOCUMENT_MISSING')
      return bytes
    } catch (error) {
      if ((error as Error).message === 'DOCUMENT_OBJECT_KEY_INVALID')
        throw new Error('ADMIN_DOCUMENT_PATH_INVALID', { cause: error })
      if (
        ['DOCUMENT_OBJECT_INTEGRITY_INVALID', 'DOCUMENT_OBJECT_TOO_LARGE'].includes(
          (error as Error).message,
        )
      )
        throw new Error('ADMIN_DOCUMENT_INTEGRITY_INVALID', { cause: error })
      if ((error as Error).message === 'DOCUMENT_OBJECT_PATH_INVALID')
        throw new Error('ADMIN_DOCUMENT_PATH_INVALID', { cause: error })
      throw error
    }
  }

  async remove(storageKey: string): Promise<void> {
    // Cleanup only newly owned orphans after a failed database write. Never turn a
    // database/request-controlled key into general deletion from the private volume.
    if (!this.owned.has(storageKey)) throw new Error('ISSUER_DOCUMENT_CLEANUP_INVALID')
    try {
      await this.backend.delete(storageKey)
      this.owned.delete(storageKey)
    } catch {
      throw new Error('ISSUER_DOCUMENT_CLEANUP_INVALID')
    }
  }

  release(storageKey: string): void {
    this.owned.delete(storageKey)
    this.backend.release?.(storageKey)
  }
}
