import { createApp, createError, toNodeListener } from 'h3'
import inject from 'light-my-request'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../server/xcs/auth/types'
import type { ResolvedPresentation } from '../server/xcs/recipient/types'
import { createVerifierHandler } from '../server/xcs/verifier/http'
import { historyCsv } from '../server/xcs/verifier/csv'
import { VerifierError, type VerifierHistoryEntry } from '../server/xcs/verifier/types'

const session = { id: 'session', userId: 'user', tokenHash: 'not-exported' } as Session
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const history: VerifierHistoryEntry = {
  id,
  organizationId: id,
  presentationId: id,
  profileId: 'testnet',
  generationId: 'a'.repeat(64),
  scope: 'full',
  checkedAt: '2026-09-24T12:00:00.000Z',
  verification: { onChain: 'active', schema: 'valid', payload: 'valid', issuerTrust: 'unknown' },
}
function fixture() {
  const repository = {
    workspace: vi.fn(async () => ({
      organizations: [],
      selectedOrganizationId: null,
      history: [],
    })),
    apply: vi.fn(async () => ({ organizationId: id, status: 'pending' })),
    history: vi.fn(async () => [history]),
    reopen: vi.fn(async () => ({ requiresAuthorization: true }) as ResolvedPresentation),
  }
  const authorize = vi.fn(async () => session)
  const resolvePresentation = vi.fn()
  const listener = toNodeListener(
    createApp().use(createVerifierHandler({ repository, authorize, resolvePresentation })),
  )
  return { repository, authorize, resolvePresentation, listener }
}

describe('verifier authenticated HTTP boundary', () => {
  it('passes authenticated user and selected organization, disables caching', async () => {
    const test = fixture()
    const response = await inject(test.listener, {
      method: 'GET',
      url: `/api/verifier/workspace?organizationId=${id}`,
    })
    expect(response.statusCode).toBe(200)
    expect(test.repository.workspace).toHaveBeenCalledWith(session, id)
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), false)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
  })
  it.each(['?role=issuer', '?organizationId=bad', `?organizationId=${id}&organizationId=${id}`])(
    'rejects ambiguous or unsupported queries %s',
    async (query) => {
      const test = fixture()
      expect(
        (await inject(test.listener, { method: 'GET', url: '/api/verifier/workspace' + query }))
          .statusCode,
      ).toBe(400)
      expect(test.repository.workspace).not.toHaveBeenCalled()
    },
  )
  it('requires authentication before listing metadata', async () => {
    const test = fixture()
    test.authorize.mockRejectedValueOnce(createError({ statusCode: 401 }))
    const response = await inject(test.listener, { method: 'GET', url: '/api/verifier/workspace' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'AUTH_REQUIRED' })
    expect(test.repository.workspace).not.toHaveBeenCalled()
  })
  it('requires the mutation CSRF authorizer before accepting applications', async () => {
    const test = fixture()
    test.authorize.mockRejectedValueOnce(createError({ statusCode: 403 }))
    const response = await inject(test.listener, {
      method: 'POST',
      url: '/api/verifier/applications',
      payload: {},
    })
    expect(response.statusCode).toBe(403)
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), true)
    expect(test.repository.apply).not.toHaveBeenCalled()
  })
  it('validates documents and refuses caller-selected roles', async () => {
    const test = fixture()
    const application = {
      name: 'Verifier',
      website: 'https://example.test',
      contact: 'Test',
      jurisdiction: 'FR',
      description: 'Test',
      purpose: 'Test',
      documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
    }
    const accepted = await inject(test.listener, {
      method: 'POST',
      url: '/api/verifier/applications',
      payload: application,
    })
    expect(accepted.statusCode).toBe(200)
    expect(test.repository.apply).toHaveBeenCalledWith(session, application)
    const rejected = await inject(test.listener, {
      method: 'POST',
      url: '/api/verifier/applications',
      payload: { ...application, role: 'issuer' },
    })
    expect(rejected.statusCode).toBe(400)
    expect(test.repository.apply).toHaveBeenCalledTimes(1)
  })
  it('exports only bounded metadata through the approval-checked repository', async () => {
    const test = fixture()
    const response = await inject(test.listener, {
      method: 'GET',
      url: `/api/verifier/history.csv?organizationId=${id}`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(response.headers['content-disposition']).toContain('attachment')
    expect(response.body).toContain('"issuerTrust"')
    expect(response.body).not.toContain(session.tokenHash)
    expect(test.repository.history).toHaveBeenCalledWith(session, id)
    test.repository.history.mockRejectedValueOnce(
      new VerifierError(403, 'VERIFIER_APPROVAL_REQUIRED'),
    )
    expect(
      (await inject(test.listener, { method: 'GET', url: '/api/verifier/history.csv' })).statusCode,
    ).toBe(403)
  })
  it('reopens only by history ID, using the current presentation resolver', async () => {
    const test = fixture()
    const response = await inject(test.listener, {
      method: 'POST',
      url: `/api/verifier/history/${id}/presentation`,
      payload: {},
    })
    expect(response.statusCode).toBe(200)
    expect(test.repository.reopen).toHaveBeenCalledWith(session, id, test.resolvePresentation)
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), true)
    expect(
      (
        await inject(test.listener, {
          method: 'POST',
          url: `/api/verifier/history/${id}/presentation?token=secret`,
          payload: {},
        })
      ).statusCode,
    ).toBe(400)
  })
  it('refuses history reopen GET requests and missing mutation CSRF authorization', async () => {
    const test = fixture()
    const get = await inject(test.listener, {
      method: 'GET',
      url: `/api/verifier/history/${id}/presentation`,
    })
    expect(get.statusCode).toBe(404)
    expect(test.repository.reopen).not.toHaveBeenCalled()
    test.authorize.mockRejectedValueOnce(createError({ statusCode: 403 }))
    const post = await inject(test.listener, {
      method: 'POST',
      url: `/api/verifier/history/${id}/presentation`,
      payload: {},
    })
    expect(post.statusCode).toBe(403)
    expect(test.authorize).toHaveBeenLastCalledWith(expect.anything(), true)
    expect(test.repository.reopen).not.toHaveBeenCalled()
  })
  it('redacts unexpected database failures', async () => {
    const test = fixture()
    test.repository.workspace.mockRejectedValueOnce(new Error('sensitive database details'))
    const response = await inject(test.listener, { method: 'GET', url: '/api/verifier/workspace' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: 'VERIFIER_UNAVAILABLE' })
  })
})

describe('verifier CSV neutralization', () => {
  it.each([
    '=HYPERLINK("bad")',
    '+1+1',
    '-1+1',
    '@SUM(A1)',
    '  =1+1',
    '\t=1+1',
    '\r=1+1',
    '\n=1+1',
  ])('neutralizes spreadsheet formulas %j', (value) => {
    const csv = historyCsv([{ ...history, profileId: value }])
    expect(csv).toContain(`"'${value.replaceAll('"', '""')}"`)
  })
  it('quotes multiline and quoted metadata without including arbitrary extra fields', () => {
    const csv = historyCsv([
      {
        ...history,
        profileId: 'x,"y"\nz',
        claims: { secret: 'PRIVATE' },
        token: 'TOKEN',
        email: 'secret@example.test',
      } as VerifierHistoryEntry,
    ])
    expect(csv).toContain('"x,""y""\nz"')
    expect(csv).not.toContain('PRIVATE')
    expect(csv).not.toContain('TOKEN')
    expect(csv).not.toContain('secret@example.test')
  })
})
