import { describe, expect, it, vi } from 'vitest'
import type { DatabaseClient } from '../server/lib/db/index.js'
import type { Session } from '../server/xcs/auth/types'
import { IssuerRepository } from '../server/xcs/issuer/repository'
import { VerifierRepository } from '../server/xcs/verifier/repository'

const session = { id: 'session', userId: 'user', tokenHash: 'hash' } as Session
const application = {
  name: 'Verifier',
  website: 'https://example.test',
  contact: 'Test',
  jurisdiction: 'FR',
  description: 'Test',
  purpose: 'Test',
  documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
}

function fixture(ambiguousCommit = false) {
  const statements: { text: string; values: unknown[] }[] = []
  let transaction = 0
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?')
    statements.push({ text, values })
    if (text.includes('FROM app_sessions')) return [{ id: session.id }]
    if (text.includes('count(*)')) return [{ count: 0 }]
    if (text.includes('SELECT id FROM app_organizations')) return [{ id: 'committed' }]
    return []
  })
  const sql = Object.assign(query, {
    begin: vi.fn(async (fn: (query: unknown) => Promise<unknown>) => {
      transaction++
      const result = await fn(query)
      if (ambiguousCommit && transaction === 1) throw new Error('ambiguous commit')
      return result
    }),
  })
  const client = { sql } as unknown as DatabaseClient
  const documents = {
    write: vi.fn(async () => ({
      storageKey: 'synthetic.pdf',
      mimeType: 'application/pdf',
      byteLength: 5,
      sha256: 'a'.repeat(64),
    })),
    release: vi.fn(),
    remove: vi.fn(async () => {}),
  }
  const applications = new IssuerRepository(client, {
    documents,
    origin: 'https://example.test',
    inviteDays: 7,
    notify: async () => ({ status: 'sent', errorCode: null }),
  })
  return {
    repository: new VerifierRepository(client, applications),
    applications,
    documents,
    statements,
  }
}

describe('verifier applications reuse issuer document lifecycle', () => {
  it('stores verifier application and documents while preserving the shared per-user application limit lock', async () => {
    const test = fixture()
    await expect(test.repository.apply(session, application)).resolves.toMatchObject({
      status: 'pending',
    })
    const profile = test.statements.find((entry) =>
      entry.text.includes('INSERT INTO app_organization_applications'),
    )!
    const document = test.statements.find((entry) =>
      entry.text.includes('INSERT INTO app_documents'),
    )!
    expect(profile.values[1]).toBe('verifier')
    expect(document.values[2]).toBe('verifier')
    expect(
      test.statements.find((entry) => entry.text.includes('pg_advisory_xact_lock'))!.values,
    ).toEqual(['user:issuer-applications'])
    expect(test.documents.release).toHaveBeenCalledWith('synthetic.pdf')
    expect(test.documents.remove).not.toHaveBeenCalled()
  })
  it('retains original issuer role when no role is supplied', async () => {
    const test = fixture()
    await test.applications.apply(session, application)
    expect(
      test.statements.find((entry) =>
        entry.text.includes('INSERT INTO app_organization_applications'),
      )!.values[1],
    ).toBe('issuer')
  })
  it('keeps verifier documents after an ambiguous commit and serialized persisted-row recovery', async () => {
    const test = fixture(true)
    await expect(test.repository.apply(session, application)).rejects.toThrow('ambiguous commit')
    const locks = test.statements.filter((entry) => entry.text.includes('pg_advisory_xact_lock'))
    expect(locks.map((entry) => entry.values[0])).toEqual([
      'user:issuer-applications',
      'user:issuer-applications',
    ])
    expect(test.documents.remove).not.toHaveBeenCalled()
    expect(test.documents.release).toHaveBeenCalledWith('synthetic.pdf')
  })
})
