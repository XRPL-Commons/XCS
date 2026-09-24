import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrivateDocuments } from '../server/xcs/admin/documents'
import { decisionInput, transition, verifiedEmail } from '../server/xcs/admin/domain'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
describe('admin documents and transitions', () => {
  it('binds five-minute links to one document and one session', () => {
    let now = Date.now()
    const service = new PrivateDocuments('/unused', randomBytes(32).toString('hex'), () => now)
    const id = randomUUID(),
      session = randomUUID(),
      url = new URL(service.link(id, session).url, 'https://xcs.test')
    const expires = url.searchParams.get('expires'),
      signature = url.searchParams.get('signature')
    expect(() => service.verify(id, session, expires, signature)).not.toThrow()
    expect(() => service.verify(id, randomUUID(), expires, signature)).toThrow(
      'ADMIN_DOCUMENT_LINK_INVALID',
    )
    expect(() => service.verify(randomUUID(), session, expires, signature)).toThrow(
      'ADMIN_DOCUMENT_LINK_INVALID',
    )
    now += 300000
    expect(() => service.verify(id, session, expires, signature)).toThrow(
      'ADMIN_DOCUMENT_LINK_EXPIRED',
    )
  })
  it('rejects missing, altered, unsupported, traversal and symlink documents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xcs-admin-doc-'))
    directories.push(directory)
    const service = new PrivateDocuments(directory, randomBytes(32).toString('hex'))
    const bytes = Buffer.from('%PDF-1.4\nsynthetic test only\n')
    const document = {
      id: randomUUID(),
      storage_key: 'proof.pdf',
      mime_type: 'application/pdf',
      byte_length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await expect(service.read(document)).rejects.toThrow('ADMIN_DOCUMENT_MISSING')
    await writeFile(join(directory, 'proof.pdf'), bytes)
    expect(await service.read(document)).toEqual(bytes)
    await expect(service.read({ ...document, storage_key: '../proof.pdf' })).rejects.toThrow(
      'ADMIN_DOCUMENT_PATH_INVALID',
    )
    await expect(service.read({ ...document, mime_type: 'text/html' })).rejects.toThrow(
      'ADMIN_DOCUMENT_INVALID',
    )
    await symlink(join(directory, 'proof.pdf'), join(directory, 'linked.pdf'))
    await expect(service.read({ ...document, storage_key: 'linked.pdf' })).rejects.toThrow(
      'ADMIN_DOCUMENT_PATH_INVALID',
    )
    await writeFile(
      join(directory, 'proof.pdf'),
      Buffer.from(bytes.toString().replace('synthetic', 'tampered!')),
    )
    await expect(service.read(document)).rejects.toThrow('ADMIN_DOCUMENT_INTEGRITY_INVALID')
  })
  it('enforces the transition matrix and required reason', () => {
    for (const role of ['issuer', 'verifier'] as const) {
      expect(transition('pending', role, 'approve')).toBe('approved')
      expect(transition('pending', role, 'reject')).toBe('rejected')
      expect(() => transition('rejected', role, 'approve')).toThrow('ADMIN_TRANSITION_INVALID')
    }
    expect(transition('approved', 'verifier', 'suspend')).toBe('suspended')
    expect(transition('suspended', 'verifier', 'restore')).toBe('approved')
    expect(() => transition('approved', 'issuer', 'suspend')).toThrow()
    expect(() =>
      decisionInput({ action: 'reject', reason: ' ', revision: 0, idempotencyKey: randomUUID() }),
    ).toThrow('ADMIN_REASON_REQUIRED')
    expect(() =>
      decisionInput({ action: 'approve', reason: '', revision: -1, idempotencyKey: randomUUID() }),
    ).toThrow()
    expect(verifiedEmail('user@example.test', new Date())).toBe('user@example.test')
    expect(verifiedEmail('user@example.test', null)).toBeNull()
    expect(verifiedEmail('User <user@example.test>', new Date())).toBeNull()
  })
})
