import { describe, expect, it } from 'vitest'
import { loadAdminConfig } from '../server/xcs/admin/config'
describe('admin configuration', () => {
  const env = {
    XCS_ADMIN_ENABLED: '1',
    XCS_AUTH_ENABLED: '1',
    NUXT_ADMIN_DATABASE_URL: 'postgres://xcs_admin_app:fixture@localhost/xcs',
    XCS_ADMIN_DOCUMENT_KEY: 'test-only-32-character-signing-key',
    XCS_ADMIN_DOCUMENT_DIRECTORY: '/private/documents',
  }
  it('is opt-in and requires shared auth and restricted database role', () => {
    expect(loadAdminConfig({})).toBeUndefined()
    expect(loadAdminConfig(env)?.directory).toBe('/private/documents')
    expect(() => loadAdminConfig({ ...env, XCS_AUTH_ENABLED: '0' })).toThrow('ADMIN_AUTH_REQUIRED')
    expect(() =>
      loadAdminConfig({
        ...env,
        NUXT_ADMIN_DATABASE_URL: 'postgres://xcs_admin:fixture@localhost/xcs',
      }),
    ).toThrow('ADMIN_DATABASE_ROLE_REQUIRED')
    expect(() => loadAdminConfig({ ...env, XCS_ADMIN_DOCUMENT_DIRECTORY: 'public' })).toThrow()
    expect(() => loadAdminConfig({ ...env, XCS_ADMIN_DOCUMENT_KEY: 'weak' })).toThrow()
  })
})
