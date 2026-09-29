import { randomBytes } from 'node:crypto'
import { lstat, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrivateDocuments } from '../server/xcs/admin/documents'
import { MAX_DOCUMENT_BYTES, PrivateDocumentStorage } from '../server/xcs/issuer/storage'

const roots: string[] = []
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'xcs-issuer-doc-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const pdf = Buffer.from('%PDF-1.4\nsynthetic document\n')
const input = { mimeType: 'application/pdf', base64: pdf.toString('base64') }

describe('issuer private document storage', () => {
  it.each([
    ['application/pdf', pdf],
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
    ['image/jpeg', Buffer.from([255, 216, 255, 224, 0])],
  ])(
    'publishes an opaque private %s readable by administrator integrity checks',
    async (mimeType, bytes) => {
      const root = await directory()
      const store = new PrivateDocumentStorage(root)
      const document = await store.write({ mimeType, base64: bytes.toString('base64') })
      expect(document.storageKey).toMatch(/^[0-9a-f]{64}\.(pdf|png|jpg)$/)
      expect(document.byteLength).toBe(bytes.length)
      expect((await lstat(join(root, document.storageKey))).mode & 0o777).toBe(0o600)
      expect(await readdir(root)).toEqual([document.storageKey])
      expect(await store.read(document)).toEqual(bytes)
      const reader = new PrivateDocuments(root, randomBytes(32).toString('hex'))
      expect(
        await reader.read({
          id: '',
          storage_key: document.storageKey,
          mime_type: mimeType,
          byte_length: document.byteLength,
          sha256: document.sha256,
        }),
      ).toEqual(bytes)
    },
  )

  it.each([
    { ...input, mimeType: 'text/html' },
    { ...input, mimeType: 'image/png' },
    { ...input, base64: `data:application/pdf;base64,${input.base64}` },
    { ...input, base64: `${input.base64}\n` },
    { ...input, base64: 'JVBERi0===' },
    { ...input, base64: '!!!!' },
  ])('rejects unsupported MIME, mismatched magic and malformed base64', async (invalid) => {
    const root = await directory()
    await expect(new PrivateDocumentStorage(root).write(invalid)).rejects.toThrow(
      'ISSUER_DOCUMENT_INVALID',
    )
    expect(await readdir(root)).toEqual([])
  })

  it('rejects uploads larger than 20 MiB before creating a file', async () => {
    const root = await directory()
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    pdf.copy(bytes)
    await expect(
      new PrivateDocumentStorage(root).write({ ...input, base64: bytes.toString('base64') }),
    ).rejects.toThrow('ISSUER_DOCUMENT_INVALID')
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    'relative',
    '/',
    '/app/public/documents',
    '/app/.output/public/documents',
    '/app/static/private',
    '/private/docs/../public',
  ])('rejects unsafe roots %s', (root) => {
    expect(() => new PrivateDocumentStorage(root)).toThrow('ISSUER_DOCUMENT_STORAGE_INVALID')
  })

  it('rejects symlinked document roots', async () => {
    const root = await directory()
    const target = await directory()
    const linked = join(root, 'linked')
    await symlink(target, linked)
    await expect(new PrivateDocumentStorage(linked).write(input)).rejects.toThrow(
      'ISSUER_DOCUMENT_STORAGE_INVALID',
    )
    expect(await readdir(target)).toEqual([])
  })

  it('detects tampering, traversal and symlink replacement on read', async () => {
    const root = await directory()
    const store = new PrivateDocumentStorage(root)
    const document = await store.write(input)
    await expect(store.read({ ...document, storageKey: '../escaped.pdf' })).rejects.toThrow(
      'ADMIN_DOCUMENT_PATH_INVALID',
    )
    await writeFile(join(root, document.storageKey), Buffer.from('%PDF-1.4\ntampered! document\n'))
    await expect(store.read(document)).rejects.toThrow('ADMIN_DOCUMENT_INTEGRITY_INVALID')
    await unlink(join(root, document.storageKey))
    const target = join(root, 'other.pdf')
    await writeFile(target, pdf)
    await symlink(target, join(root, document.storageKey))
    await expect(store.read(document)).rejects.toThrow('ADMIN_DOCUMENT_PATH_INVALID')
    await expect(store.remove(document.storageKey)).rejects.toThrow(
      'ISSUER_DOCUMENT_CLEANUP_INVALID',
    )
  })

  it('removes only newly owned files and releases persisted documents', async () => {
    const root = await directory()
    const store = new PrivateDocumentStorage(root)
    const first = await store.write(input)
    const second = await store.write(input)
    expect(first.storageKey).not.toBe(second.storageKey)
    await expect(new PrivateDocumentStorage(root).remove(first.storageKey)).rejects.toThrow(
      'ISSUER_DOCUMENT_CLEANUP_INVALID',
    )
    await store.remove(first.storageKey)
    store.release(second.storageKey)
    await expect(store.remove(second.storageKey)).rejects.toThrow('ISSUER_DOCUMENT_CLEANUP_INVALID')
    expect(await readdir(root)).toEqual([second.storageKey])
  })
})
