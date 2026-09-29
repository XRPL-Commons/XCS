import { describe, expect, it } from 'vitest'
import { loadAdminConfig } from '../server/xcs/admin/config'
describe('admin configuration', () => {
  const env = {
    XCS_AUTH_ORIGIN: 'https://xcs.example',
    XCS_IDENTITY_CLIENT_ID: 'test-client',
    XCS_IDENTITY_CLIENT_SECRET: 'test-secret',
    NUXT_APP_DATABASE_URL: 'postgres://xcs_app:fixture@localhost/xcs',
    NUXT_ADMIN_DATABASE_URL: 'postgres://xcs_admin_app:fixture@localhost/xcs',
    XCS_ADMIN_DOCUMENT_KEY: 'test-only-32-character-signing-key',
    XCS_DOCUMENT_STORAGE_DRIVER: 'filesystem',
    XCS_DOCUMENT_FILESYSTEM_DIRECTORY: '/private/documents',
  }
  it('is opt-in and requires shared auth and restricted database role', () => {
    expect(loadAdminConfig({})).toBeUndefined()
    expect(loadAdminConfig(env)?.storage).toEqual({
      driver: 'filesystem',
      directory: '/private/documents',
    })
    expect(() => loadAdminConfig({ ...env, XCS_IDENTITY_CLIENT_SECRET: '' })).toThrow(
      'AUTH_CONFIGURATION_REQUIRED',
    )
    expect(() =>
      loadAdminConfig({
        ...env,
        NUXT_ADMIN_DATABASE_URL: 'postgres://xcs_admin:fixture@localhost/xcs',
      }),
    ).toThrow('ADMIN_DATABASE_ROLE_REQUIRED')
    expect(() => loadAdminConfig({ ...env, XCS_DOCUMENT_FILESYSTEM_DIRECTORY: 'public' })).toThrow()
    expect(() => loadAdminConfig({ ...env, XCS_ADMIN_DOCUMENT_KEY: 'weak' })).toThrow()
  })
})
