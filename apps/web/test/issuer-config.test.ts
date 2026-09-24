import { describe, expect, it } from 'vitest'
import { loadIssuerConfig } from '../server/xcs/issuer/config'
import {
  applicationInput,
  disclosure,
  email,
  hash,
  object,
  text,
  uuid,
} from '../server/xcs/issuer/types'

const environment = {
  XCS_AUTH_ENABLED: '1',
  XCS_ISSUER_ENABLED: '1',
  NUXT_ISSUER_DATABASE_URL: 'postgres://xcs_issuer:synthetic@localhost/xcs',
  XCS_AUTH_ORIGIN: 'https://xcs.test',
  XCS_ISSUER_DOCUMENT_DIRECTORY: '/var/lib/xcs-review',
}
describe('issuer opt-in configuration and request validation', () => {
  it('remains disabled without the exact flag and requires authentication', () => {
    expect(loadIssuerConfig({})).toBeUndefined()
    expect(loadIssuerConfig({ XCS_ISSUER_ENABLED: '0' })).toBeUndefined()
    expect(() => loadIssuerConfig({ ...environment, XCS_ISSUER_ENABLED: 'true' })).toThrow(
      'ISSUER_FLAG_INVALID',
    )
    expect(() => loadIssuerConfig({ ...environment, XCS_AUTH_ENABLED: '0' })).toThrow(
      'ISSUER_AUTH_REQUIRED',
    )
  })
  it('requires separate least-privilege credentials and a canonical HTTPS origin', () => {
    for (const role of ['xcs_admin', 'xcs_admin_app', 'xcs_app', 'xcs_api'])
      expect(() =>
        loadIssuerConfig({
          ...environment,
          NUXT_ISSUER_DATABASE_URL: `postgres://${role}:synthetic@localhost/xcs`,
        }),
      ).toThrow('ISSUER_DATABASE_ROLE_REQUIRED')
    for (const origin of [
      'http://xcs.test',
      'https://xcs.test/',
      'https://xcs.test/path',
      'https://user:password@xcs.test',
    ])
      expect(() => loadIssuerConfig({ ...environment, XCS_AUTH_ORIGIN: origin })).toThrow()
    expect(() =>
      loadIssuerConfig({ ...environment, XCS_ISSUER_DOCUMENT_DIRECTORY: 'relative' }),
    ).toThrow()
  })
  it('bounds invitation lifetime and defaults to seven days', () => {
    expect(loadIssuerConfig(environment)?.inviteDays).toBe(7)
    for (const days of ['0', '31', 'Infinity', '7.5', '-1'])
      expect(() => loadIssuerConfig({ ...environment, XCS_ISSUER_INVITE_DAYS: days })).toThrow(
        'ISSUER_INVITE_LIFETIME_INVALID',
      )
    expect(loadIssuerConfig({ ...environment, XCS_ISSUER_INVITE_DAYS: '30' })?.inviteDays).toBe(30)
  })
  it('rejects unknown authority fields, malformed IDs, header injection and prototype selectors', () => {
    expect(() => object({ role: 'admin' }, [])).toThrow()
    expect(() => uuid('not-an-id')).toThrow()
    expect(hash('A'.repeat(64))).toBe('a'.repeat(64))
    expect(() => hash('g'.repeat(64))).toThrow()
    expect(() => email('a@example.test\r\nBcc: other@example.test')).toThrow()
    expect(() => text('hidden\u0000value', 100)).toThrow()
    expect(() =>
      disclosure({ visibility: 'private', publicFields: ['/__proto__/secret'] }),
    ).toThrow('ISSUER_PUBLIC_FIELDS_INVALID')
    expect(() => disclosure({ visibility: 'owner', publicFields: [] })).toThrow()
    expect(disclosure({ visibility: 'private', publicFields: ['/public'] })).toEqual({
      visibility: 'private',
      publicFields: ['/public'],
    })
  })
  it('requires complete application evidence and refuses caller-selected storage keys', () => {
    const input = {
      name: 'School',
      website: 'https://school.test',
      contact: 'Responsible',
      jurisdiction: 'France',
      description: 'Training',
      purpose: 'Credentials',
      documents: [{ mimeType: 'application/pdf', base64: 'JVBERi0=' }],
    }
    expect(applicationInput(input).name).toBe('School')
    expect(() => applicationInput({ ...input, documents: [] })).toThrow('ISSUER_DOCUMENT_REQUIRED')
    expect(() =>
      applicationInput({ ...input, documents: Array(4).fill(input.documents[0]) }),
    ).toThrow()
    expect(() =>
      applicationInput({
        ...input,
        documents: [{ ...input.documents[0], storageKey: '../private' }],
      }),
    ).toThrow()
    expect(() => applicationInput({ ...input, website: 'javascript:alert(1)' })).toThrow(
      'ISSUER_WEBSITE_INVALID',
    )
    expect(() => applicationInput({ ...input, status: 'approved' })).toThrow()
  })
})
