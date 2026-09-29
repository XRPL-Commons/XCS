import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { PrivateDocuments } from '../server/xcs/admin/documents'
import { loadPrivateDocumentStorageConfig } from '../server/xcs/documents/config'
import { S3PrivateDocumentBackend } from '../server/xcs/documents/storage'
import { PrivateDocumentStorage } from '../server/xcs/issuer/storage'

class FakeS3Client {
  readonly commands: unknown[] = []
  readonly objects = new Map<string, Buffer>()
  destroyed = false

  async send(command: unknown): Promise<Record<string, unknown>> {
    this.commands.push(command)
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key)
      if (this.objects.has(key))
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' })
      this.objects.set(key, Buffer.from(command.input.Body as Uint8Array))
      return { ETag: 'synthetic' }
    }
    if (command instanceof GetObjectCommand) {
      const bytes = this.objects.get(String(command.input.Key))
      if (!bytes)
        throw Object.assign(new Error('missing'), {
          name: 'NoSuchKey',
          $metadata: { httpStatusCode: 404 },
        })
      return { ContentLength: bytes.length, Body: Readable.from([bytes]) }
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(String(command.input.Key))
      return {}
    }
    throw new Error('UNEXPECTED_S3_COMMAND')
  }

  destroy(): void {
    this.destroyed = true
  }
}

function backend(client: FakeS3Client) {
  return new S3PrivateDocumentBackend(client as unknown as S3Client, 'xcs-private', 'review/')
}

const bytes = Buffer.from('%PDF-1.4\nprivate review evidence\n')
const input = { mimeType: 'application/pdf', base64: bytes.toString('base64') }

describe('private S3 document storage', () => {
  it('writes an opaque private object and lets the admin verify its stored integrity', async () => {
    const client = new FakeS3Client(),
      objectBackend = backend(client),
      issuer = new PrivateDocumentStorage(objectBackend),
      document = await issuer.write(input)

    expect(document.storageKey).toMatch(/^[0-9a-f]{64}\.pdf$/)
    const write = client.commands.find(
      (command): command is PutObjectCommand => command instanceof PutObjectCommand,
    )
    expect(write?.input).toMatchObject({
      Bucket: 'xcs-private',
      Key: `review/${document.storageKey}`,
      ACL: 'private',
      ContentType: 'application/pdf',
    })
    expect(JSON.stringify(write?.input)).not.toContain('http')

    issuer.release(document.storageKey)
    const admin = new PrivateDocuments(objectBackend, randomBytes(32).toString('hex'))
    await expect(
      admin.read({
        id: '',
        storage_key: document.storageKey,
        mime_type: document.mimeType,
        byte_length: document.byteLength,
        sha256: document.sha256,
      }),
    ).resolves.toEqual(bytes)
  })

  it('removes only an object owned by the failed issuer write', async () => {
    const client = new FakeS3Client(),
      objectBackend = backend(client),
      issuer = new PrivateDocumentStorage(objectBackend),
      first = await issuer.write(input),
      second = await issuer.write(input)

    await issuer.remove(first.storageKey)
    expect(client.objects.has(`review/${first.storageKey}`)).toBe(false)
    issuer.release(second.storageKey)
    await expect(issuer.remove(second.storageKey)).rejects.toThrow(
      'ISSUER_DOCUMENT_CLEANUP_INVALID',
    )
    expect(client.objects.has(`review/${second.storageKey}`)).toBe(true)
  })

  it('maps missing, non-opaque and oversized objects to safe admin errors', async () => {
    const client = new FakeS3Client(),
      objectBackend = backend(client),
      service = new PrivateDocuments(objectBackend, randomBytes(32).toString('hex')),
      key = `${'a'.repeat(64)}.pdf`,
      document = {
        id: '',
        storage_key: key,
        mime_type: 'application/pdf',
        byte_length: bytes.length,
        sha256: 'a'.repeat(64),
      }

    await expect(service.read(document)).rejects.toThrow('ADMIN_DOCUMENT_MISSING')
    await expect(service.read({ ...document, storage_key: '../secret.pdf' })).rejects.toThrow(
      'ADMIN_DOCUMENT_PATH_INVALID',
    )
    client.objects.set(`review/${key}`, Buffer.concat([bytes, Buffer.from('extra')]))
    await expect(service.read(document)).rejects.toThrow('ADMIN_DOCUMENT_INTEGRITY_INVALID')
  })

  it('requires an explicit local driver or complete HTTPS S3 configuration', () => {
    expect(() => loadPrivateDocumentStorageConfig({})).toThrow('DOCUMENT_STORAGE_DRIVER_REQUIRED')
    expect(
      loadPrivateDocumentStorageConfig({
        XCS_DOCUMENT_STORAGE_DRIVER: 'filesystem',
        XCS_DOCUMENT_FILESYSTEM_DIRECTORY: '/var/lib/xcs-review',
      }),
    ).toEqual({ driver: 'filesystem', directory: '/var/lib/xcs-review' })
    expect(() =>
      loadPrivateDocumentStorageConfig({
        NODE_ENV: 'production',
        XCS_DOCUMENT_STORAGE_DRIVER: 'filesystem',
        XCS_DOCUMENT_FILESYSTEM_DIRECTORY: '/var/lib/xcs-review',
      }),
    ).toThrow('DOCUMENT_FILESYSTEM_LOCAL_ONLY')
    expect(
      loadPrivateDocumentStorageConfig({
        NODE_ENV: 'production',
        XCS_DOCUMENT_STORAGE_DRIVER: 'filesystem',
        XCS_DOCUMENT_FILESYSTEM_DIRECTORY: '/var/lib/xcs-review',
        XCS_DOCUMENT_FILESYSTEM_LOCAL: '1',
      }),
    ).toEqual({ driver: 'filesystem', directory: '/var/lib/xcs-review' })
    const s3Environment = {
      XCS_DOCUMENT_STORAGE_DRIVER: 's3',
      XCS_DOCUMENT_S3_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
      XCS_DOCUMENT_S3_REGION: 'fra1',
      XCS_DOCUMENT_S3_BUCKET: 'xcs-private-documents',
      XCS_DOCUMENT_S3_PRIVATE_BUCKET: '1',
      XCS_DOCUMENT_S3_PREFIX: 'review/',
      XCS_DOCUMENT_S3_ACCESS_KEY_ID: 'synthetic-access-key',
      XCS_DOCUMENT_S3_SECRET_ACCESS_KEY: 'synthetic-secret-key-value',
    }
    const s3 = loadPrivateDocumentStorageConfig(s3Environment)
    expect(s3).toMatchObject({
      driver: 's3',
      endpoint: 'https://fra1.digitaloceanspaces.com',
      bucket: 'xcs-private-documents',
      privateBucketConfirmed: true,
      prefix: 'review/',
    })
    expect(() =>
      loadPrivateDocumentStorageConfig({
        ...s3Environment,
        XCS_DOCUMENT_S3_ENDPOINT: 'http://fra1.digitaloceanspaces.com',
      }),
    ).toThrow('DOCUMENT_S3_CONFIGURATION_INVALID')
    expect(() =>
      loadPrivateDocumentStorageConfig({
        ...s3Environment,
        XCS_DOCUMENT_S3_PRIVATE_BUCKET: '0',
      }),
    ).toThrow('DOCUMENT_S3_CONFIGURATION_INVALID')
  })
})
