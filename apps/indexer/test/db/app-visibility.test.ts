import { describe, expect, it } from 'vitest'

import { filterCredentialClaims, validatePublicFields } from '../../src/lib/db/app/visibility.js'
import { createAppToken, hashAppToken } from '../../src/lib/db/app/tokens.js'

const claims = {
  course: { title: 'XRPL basics', grade: 18 },
  learner: { name: 'Synthetic learner', email: 'learner@example.invalid' },
  passed: true,
  credits: 0,
  optional: null,
  modules: [{ name: 'Ledger', privateNote: 'Do not publish' }],
  'a/b': { '~result': 'ok' },
}

describe('credential claim disclosure', () => {
  it('projects only named fields, including nested and escaped JSON pointers', () => {
    expect(
      filterCredentialClaims(claims, {
        scope: 'public',
        publicFields: ['/course/title', '/passed', '/credits', '/optional', '/a~1b/~0result'],
      }),
    ).toEqual({
      course: { title: 'XRPL basics' },
      passed: true,
      credits: 0,
      optional: null,
      'a/b': { '~result': 'ok' },
    })
  })

  it('does not expand an empty or missing selection into full claims', () => {
    expect(filterCredentialClaims(claims, { scope: 'public', publicFields: [] })).toEqual({})
    expect(
      filterCredentialClaims(claims, {
        scope: 'public',
        publicFields: ['/missing', '/course/missing', '/passed/child'],
      }),
    ).toEqual({})
  })

  it('copies full access and explicitly selected objects without mutating the payload', () => {
    const full = filterCredentialClaims(claims, { scope: 'full', publicFields: [] })
    expect(full).toEqual(claims)
    expect(full).not.toBe(claims)
    expect(full.course).not.toBe(claims.course)
    expect(filterCredentialClaims(claims, { scope: 'public', publicFields: ['/course'] })).toEqual({
      course: claims.course,
    })
  })

  it('treats arrays atomically and never exposes their siblings through an index selection', () => {
    expect(
      filterCredentialClaims(claims, { scope: 'public', publicFields: ['/modules/0/name'] }),
    ).toEqual({})
    expect(filterCredentialClaims(claims, { scope: 'public', publicFields: ['/modules'] })).toEqual(
      { modules: claims.modules },
    )
  })

  it.each([
    '',
    'course.title',
    '/~2',
    '/__proto__/polluted',
    '/constructor/prototype',
    '/course/prototype',
    '/' + 'x'.repeat(1024),
  ])('fails closed for invalid path %s', (path) => {
    expect(() => filterCredentialClaims(claims, { scope: 'public', publicFields: [path] })).toThrow(
      'INVALID_PUBLIC_FIELD_PATH',
    )
  })

  it('ignores inherited fields and bounds selector size/depth', () => {
    expect(filterCredentialClaims({}, { scope: 'public', publicFields: ['/toString'] })).toEqual({})
    expect(() => validatePublicFields(Array(257).fill('/course'))).toThrow('INVALID_PUBLIC_FIELDS')
    expect(() => validatePublicFields(['/' + Array(33).fill('x').join('/')])).toThrow(
      'INVALID_PUBLIC_FIELD_PATH',
    )
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
})

describe('application bearer tokens', () => {
  it('uses independent 256-bit tokens and persists only their SHA-256 hashes', () => {
    const first = createAppToken()
    const second = createAppToken()
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAppToken(first.token)).toBe(first.tokenHash)
    expect(first.token).not.toBe(second.token)
    expect(first.tokenHash).not.toBe(second.tokenHash)
  })

  it('rejects malformed and unbounded tokens before database access', () => {
    for (const token of ['', 'bad token', 'a'.repeat(44), 'a'.repeat(10000)]) {
      expect(hashAppToken(token)).toBeNull()
    }
  })
})
