import { loadPrivateDocumentStorageConfig } from '../documents/config'
import { serverSecret } from '../secrets'
import { loadAuthConfig } from '../auth/config'

export const adminSecret = serverSecret
export function loadAdminConfig(env: NodeJS.ProcessEnv) {
  const supplied = [
    'NUXT_ADMIN_DATABASE_URL',
    'NUXT_ADMIN_DATABASE_URL_FILE',
    'XCS_ADMIN_DOCUMENT_KEY',
    'XCS_ADMIN_DOCUMENT_KEY_FILE',
  ].some((name) => (env[name] ?? '').trim().length > 0)
  if (!supplied) return undefined
  if (loadAuthConfig(env) === undefined) throw new Error('ADMIN_AUTH_REQUIRED')
  const databaseUrl = adminSecret(env, 'NUXT_ADMIN_DATABASE_URL'),
    signingKey = adminSecret(env, 'XCS_ADMIN_DOCUMENT_KEY')
  let database: URL
  try {
    database = new URL(databaseUrl)
  } catch {
    throw new Error('ADMIN_DATABASE_INVALID')
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    decodeURIComponent(database.username) !== 'xcs_admin_app' ||
    !database.password
  )
    throw new Error('ADMIN_DATABASE_ROLE_REQUIRED')
  if (Buffer.byteLength(signingKey) < 32) throw new Error('ADMIN_DOCUMENT_CONFIGURATION_REQUIRED')
  const storage = loadPrivateDocumentStorageConfig(env)
  return { databaseUrl, signingKey, storage }
}
