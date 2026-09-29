import { describe, expect, it, vi } from 'vitest'
import type { DatabaseClient } from '../server/lib/db/index.js'
import type { Session } from '../server/xcs/auth/types'
import { IssuerRepository } from '../server/xcs/issuer/repository'

const session = { id: 'session', userId: 'user', tokenHash: 'token-hash' } as Session
const application = {
  name: 'Synthetic',
  website: 'https://synthetic.test',
  contact: 'Synthetic',
  jurisdiction: 'France',
  description: 'Synthetic',
  purpose: 'Synthetic',
  documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
}

function fixture(outcome: 'commit' | 'rollback' | 'timeout') {
  const documents = {
    write: vi.fn(async () => ({
      storageKey: 'synthetic.pdf',
      mimeType: 'application/pdf',
      byteLength: 5,
      sha256: 'a'.repeat(64),
    })),
    remove: vi.fn(async () => {}),
    release: vi.fn(),
  }
  let transaction = 0,
    committed = false,
    lockHeld = false
  const recoverySteps: string[] = []
  const locks: unknown[] = []
  const originalFailure = new Error('connection failed while awaiting commit')
  const sql = Object.assign(
    // An unlocked snapshot sees absence while the original commit is in flight.
    vi.fn(async () => []),
    {
      begin: vi.fn(async (callback: (query: unknown) => Promise<unknown>) => {
        transaction++
        if (transaction === 1) {
          await callback(async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const statement = parts.join('?')
            if (statement.includes('pg_advisory_xact_lock')) {
              lockHeld = true
              locks.push(values[0])
            }
            if (statement.includes('FROM app_sessions')) return [{ id: session.id }]
            if (statement.includes('count(*)')) return [{ count: 0 }]
            return []
          })
          // Caller receives an ambiguous failure before PostgreSQL resolves COMMIT.
          throw originalFailure
        }
        return callback(async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const statement = parts.join('?')
          if (statement.includes('pg_advisory_xact_lock')) {
            recoverySteps.push('lock')
            locks.push(values[0])
            expect(lockHeld).toBe(true)
            if (outcome === 'timeout') throw new Error('lock timeout')
            committed = outcome === 'commit'
            lockHeld = false
            return []
          }
          if (statement.includes('SELECT id FROM app_organizations')) {
            recoverySteps.push('read')
            expect(lockHeld).toBe(false)
            return committed ? [{ id: 'persisted-organization' }] : []
          }
          throw new Error('Unexpected recovery query')
        })
      }),
    },
  )
  const repository = new IssuerRepository({ sql } as unknown as DatabaseClient, {
    origin: 'https://xcs.test',
    inviteDays: 7,
    documents,
    notify: async () => ({ status: 'sent', errorCode: null }),
  })
  return { repository, documents, recoverySteps, locks, originalFailure, sql }
}

describe('issuer document cleanup after an ambiguous commit', () => {
  it('waits for the original application transaction before deciding whether documents are orphaned', async () => {
    const test = fixture('commit')
    await expect(test.repository.apply(session, application)).rejects.toBe(test.originalFailure)
    expect(test.recoverySteps).toEqual(['lock', 'read'])
    expect(test.locks).toEqual(['user:issuer-applications', 'user:issuer-applications'])
    expect(test.sql).not.toHaveBeenCalled()
    expect(test.documents.remove).not.toHaveBeenCalled()
    expect(test.documents.release).toHaveBeenCalledWith('synthetic.pdf')
  })
  it('cleans files only after rollback and a serialized absence check', async () => {
    const test = fixture('rollback')
    await expect(test.repository.apply(session, application)).rejects.toBe(test.originalFailure)
    expect(test.recoverySteps).toEqual(['lock', 'read'])
    expect(test.documents.remove).toHaveBeenCalledWith('synthetic.pdf')
    expect(test.documents.release).not.toHaveBeenCalled()
  })
  it('preserves files when the recovery lock times out instead of guessing the commit outcome', async () => {
    const test = fixture('timeout')
    await expect(test.repository.apply(session, application)).rejects.toBe(test.originalFailure)
    expect(test.recoverySteps).toEqual(['lock'])
    expect(test.documents.remove).not.toHaveBeenCalled()
    expect(test.documents.release).toHaveBeenCalledWith('synthetic.pdf')
  })
})
