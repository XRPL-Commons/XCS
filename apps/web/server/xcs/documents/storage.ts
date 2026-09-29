import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

export const MAX_PRIVATE_DOCUMENT_BYTES = 20 * 1024 * 1024

const privateDocumentKey = /^[0-9a-f]{64}\.(?:pdf|png|jpg)$/
export interface PrivateDocumentBackend {
  put(storageKey: string, mimeType: string, bytes: Buffer): Promise<void>
  get(storageKey: string, maximumBytes: number): Promise<Buffer | undefined>
  delete(storageKey: string): Promise<void>
  release?(storageKey: string): void
  close?(): void
}

export interface StoredPrivateDocument {
  storageKey: string
  mimeType: string
  byteLength: number
  sha256: string
}

export type PrivateDocumentStorageConfig =
  | { driver: 'filesystem'; directory: string }
  | {
      driver: 's3'
      bucket: string
      region: string
      endpoint: string
      prefix: string
      privateBucketConfirmed: true
      accessKeyId: string
      secretAccessKey: string
    }

function storageKey(value: string): string {
  if (!privateDocumentKey.test(value)) throw new Error('DOCUMENT_OBJECT_KEY_INVALID')
  return value
}

function filesystemRoot(directory: string): void {
  if (
    !isAbsolute(directory) ||
    resolve(directory) === sep ||
    directory.split(sep).some((part) => ['public', 'static', '..'].includes(part))
  )
    throw new Error('DOCUMENT_FILESYSTEM_ROOT_INVALID')
}

/** A local-only backend with atomic publication and symlink-safe reads. */
export class FilesystemPrivateDocumentBackend implements PrivateDocumentBackend {
  private readonly owned = new Map<string, { root: string; dev: number; ino: number }>()

  constructor(private readonly directory: string) {
    filesystemRoot(directory)
  }

  private async root(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('DOCUMENT_FILESYSTEM_ROOT_INVALID')
    const root = await realpath(this.directory)
    if (root.split(sep).some((part) => ['public', 'static'].includes(part)))
      throw new Error('DOCUMENT_FILESYSTEM_ROOT_INVALID')
    return root
  }

  async put(key: string, _mimeType: string, bytes: Buffer): Promise<void> {
    storageKey(key)
    const root = await this.root()
    const path = join(root, key)
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
      await link(staging, path)
      published = true
      const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      this.owned.set(key, { root, dev: stat.dev, ino: stat.ino })
    } catch (error) {
      if (published) await unlink(path).catch(() => undefined)
      throw error
    } finally {
      await file.close()
      await unlink(staging).catch(() => undefined)
    }
  }

  async get(key: string, maximumBytes: number): Promise<Buffer | undefined> {
    storageKey(key)
    const root = await this.root()
    const path = join(root, key)
    try {
      const actual = await realpath(path)
      if (!actual.startsWith(root + sep) || actual !== path)
        throw new Error('DOCUMENT_OBJECT_PATH_INVALID')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > maximumBytes) throw new Error('DOCUMENT_OBJECT_TOO_LARGE')
        const bytes = Buffer.alloc(maximumBytes + 1)
        let length = 0
        while (length < bytes.length) {
          const result = await file.read(bytes, length, bytes.length - length, null)
          if (!result.bytesRead) break
          length += result.bytesRead
        }
        if (length > maximumBytes) throw new Error('DOCUMENT_OBJECT_TOO_LARGE')
        return bytes.subarray(0, length)
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    storageKey(key)
    const owned = this.owned.get(key)
    if (!owned) throw new Error('DOCUMENT_OBJECT_CLEANUP_INVALID')
    const path = join(owned.root, key)
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino)
        throw new Error('DOCUMENT_OBJECT_CLEANUP_INVALID')
      await unlink(path)
      this.owned.delete(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.owned.delete(key)
    }
  }

  release(key: string): void {
    this.owned.delete(key)
  }
}

type S3Sender = Pick<S3Client, 'send' | 'destroy'>

function isMissingObject(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return (
    value?.name === 'NoSuchKey' ||
    value?.name === 'NotFound' ||
    value?.$metadata?.httpStatusCode === 404
  )
}

async function readBoundedBody(body: unknown, maximumBytes: number): Promise<Buffer> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')
    throw new Error('DOCUMENT_OBJECT_UNREADABLE')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maximumBytes) {
      const destroy = (body as { destroy?: () => void }).destroy
      destroy?.call(body)
      throw new Error('DOCUMENT_OBJECT_TOO_LARGE')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, length)
}

/** Private S3-compatible object storage, including DigitalOcean Spaces. */
export class S3PrivateDocumentBackend implements PrivateDocumentBackend {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
    private readonly prefix = '',
  ) {}

  private key(key: string): string {
    return this.prefix + storageKey(key)
  }

  async put(key: string, mimeType: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: mimeType,
        ACL: 'private',
      }),
    )
  }

  async get(key: string, maximumBytes: number): Promise<Buffer | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Range: `bytes=0-${maximumBytes}`,
        }),
      )
      if (result.ContentLength !== undefined && result.ContentLength > maximumBytes)
        throw new Error('DOCUMENT_OBJECT_TOO_LARGE')
      return readBoundedBody(result.Body, maximumBytes)
    } catch (error) {
      if (isMissingObject(error)) return undefined
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }))
  }

  close(): void {
    this.client.destroy()
  }
}

export function createPrivateDocumentBackend(
  config: PrivateDocumentStorageConfig,
): PrivateDocumentBackend {
  if (config.driver === 'filesystem') return new FilesystemPrivateDocumentBackend(config.directory)
  if (config.privateBucketConfirmed !== true) throw new Error('DOCUMENT_S3_BUCKET_PRIVATE_REQUIRED')
  const clientConfig: S3ClientConfig = {
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  }
  return new S3PrivateDocumentBackend(new S3Client(clientConfig), config.bucket, config.prefix)
}

export function privateDocumentDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readStoredPrivateDocument(
  backend: PrivateDocumentBackend,
  document: StoredPrivateDocument,
): Promise<Buffer | undefined> {
  storageKey(document.storageKey)
  if (
    !['application/pdf', 'image/png', 'image/jpeg'].includes(document.mimeType) ||
    !Number.isSafeInteger(document.byteLength) ||
    document.byteLength < 1 ||
    document.byteLength > MAX_PRIVATE_DOCUMENT_BYTES ||
    !/^[0-9a-f]{64}$/.test(document.sha256)
  )
    throw new Error('DOCUMENT_METADATA_INVALID')
  const content = await backend.get(document.storageKey, document.byteLength)
  if (!content) return undefined
  const magic =
    document.mimeType === 'application/pdf'
      ? content.subarray(0, 5).equals(Buffer.from('%PDF-'))
      : document.mimeType === 'image/png'
        ? content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  if (
    content.length !== document.byteLength ||
    !magic ||
    privateDocumentDigest(content) !== document.sha256
  )
    throw new Error('DOCUMENT_OBJECT_INTEGRITY_INVALID')
  return content
}
