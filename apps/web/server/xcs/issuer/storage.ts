import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { PrivateDocuments } from '../admin/documents'

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024

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
  private readonly owned = new Map<string, { root: string; dev: number; ino: number }>()

  constructor(private readonly directory: string) {
    if (
      !isAbsolute(directory) ||
      resolve(directory) === sep ||
      directory.split(sep).some((part) => ['public', 'static', '..'].includes(part))
    )
      throw new Error('ISSUER_DOCUMENT_STORAGE_INVALID')
  }

  private async root(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('ISSUER_DOCUMENT_STORAGE_INVALID')
    const root = await realpath(this.directory)
    if (root.split(sep).some((part) => ['public', 'static'].includes(part)))
      throw new Error('ISSUER_DOCUMENT_STORAGE_INVALID')
    return root
  }

  async write(input: { mimeType: string; base64: string }): Promise<DocumentMetadata> {
    const bytes = documentBytes(input)
    const root = await this.root()
    const storageKey = `${randomBytes(32).toString('hex')}.${extensions[input.mimeType]}`
    const path = join(root, storageKey)
    const staging = join(root, `.upload-${randomBytes(32).toString('hex')}`)
    const file = await open(
      staging,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    let published = false
    try {
      await file.writeFile(bytes)
      await file.sync()
      const stat = await file.stat()
      // link() publishes the fully written inode atomically and refuses to overwrite
      // any existing filename, unlike rename(). No partial file gets a document key.
      await link(staging, path)
      published = true
      const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      this.owned.set(storageKey, { root, dev: stat.dev, ino: stat.ino })
    } catch {
      if (published) await unlink(path).catch(() => undefined)
      throw new Error('ISSUER_DOCUMENT_WRITE_FAILED')
    } finally {
      await file.close()
      await unlink(staging)
    }
    return {
      storageKey,
      mimeType: input.mimeType,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }

  async read(document: DocumentMetadata): Promise<Buffer> {
    // This key is only required by the reader's separate signed-URL API, which this
    // service never uses; document integrity is checked against persisted metadata.
    const reader = new PrivateDocuments(await this.root(), randomBytes(32).toString('hex'))
    return reader.read({
      id: '',
      storage_key: document.storageKey,
      mime_type: document.mimeType,
      byte_length: document.byteLength,
      sha256: document.sha256,
    })
  }

  async remove(storageKey: string): Promise<void> {
    // Cleanup only newly owned orphans after a failed database write. Never turn a
    // database/request-controlled key into general deletion from the private volume.
    const owned = this.owned.get(storageKey)
    if (!owned) throw new Error('ISSUER_DOCUMENT_CLEANUP_INVALID')
    const path = join(owned.root, storageKey)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino)
        throw new Error('ISSUER_DOCUMENT_CLEANUP_INVALID')
      await unlink(path)
      this.owned.delete(storageKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.owned.delete(storageKey)
    }
  }

  release(storageKey: string): void {
    this.owned.delete(storageKey)
  }
}
