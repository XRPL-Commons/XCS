import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAuthConfig } from '../server/xcs/auth/config'
const env = {
  XCS_AUTH_ENABLED: '1',
  XCS_AUTH_ORIGIN: 'https://xcs.example',
  XCS_IDENTITY_CLIENT_ID: 'test-client',
  XCS_IDENTITY_CLIENT_SECRET: 'test-secret',
  NUXT_APP_DATABASE_URL: 'postgres://xcs_app:test-password@127.0.0.1/test',
}
let directory: string | undefined
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})
describe('authentication configuration', () => {
  it('is disabled by default without accessing secret files', () => {
    expect(loadAuthConfig({ XCS_IDENTITY_CLIENT_SECRET_FILE: '/missing' })).toBeUndefined()
  })
  it('uses the canonical issuer and private application role with bounded sessions', () => {
    expect(loadAuthConfig(env)).toMatchObject({
      issuerUrl: 'https://account.xrpl.in',
      origin: 'https://xcs.example',
      idleSeconds: 1800,
      absoluteSeconds: 28800,
    })
  })
  it.each(['xcs_admin', 'xcs_api', 'xcs_payload_writer'])('rejects the %s pool', (role) => {
    expect(() =>
      loadAuthConfig({
        ...env,
        NUXT_APP_DATABASE_URL: `postgres://${role}:password@127.0.0.1/test`,
      }),
    ).toThrow('AUTH_APPLICATION_DATABASE_ROLE_REQUIRED')
  })
  it.each([
    'http://xcs.example',
    'https://xcs.example/path',
    'https://user:secret@xcs.example',
    'https://xcs.example?redirect=evil',
  ])('rejects an unsafe origin %s', (origin) => {
    expect(() => loadAuthConfig({ ...env, XCS_AUTH_ORIGIN: origin })).toThrow()
  })
  it('rejects HTTP issuers and unbounded durations', () => {
    expect(() => loadAuthConfig({ ...env, XCS_IDENTITY_ISSUER: 'http://127.0.0.1:1' })).toThrow(
      'AUTH_HTTPS_ISSUER_REQUIRED',
    )
    expect(() => loadAuthConfig({ ...env, XCS_AUTH_IDLE_SECONDS: '90000' })).toThrow(
      'AUTH_DURATION_INVALID',
    )
  })
  it('loads a mounted secret, rejects conflicts and multiline data', () => {
    directory = mkdtempSync(join(tmpdir(), 'xcs-auth-config-'))
    const file = join(directory, 'client-secret')
    writeFileSync(file, 'fictional-secret\n')
    const fileEnv = {
      ...env,
      XCS_IDENTITY_CLIENT_SECRET: '',
      XCS_IDENTITY_CLIENT_SECRET_FILE: file,
    }
    expect(loadAuthConfig(fileEnv)!.clientSecret).toBe('fictional-secret')
    expect(() =>
      loadAuthConfig({ ...fileEnv, XCS_IDENTITY_CLIENT_SECRET: 'another-secret' }),
    ).toThrow('AUTH_SECRET_CONFLICT')
    writeFileSync(file, 'one\ntwo\n')
    expect(() => loadAuthConfig(fileEnv)).toThrow('AUTH_SECRET_INVALID')
  })
})
