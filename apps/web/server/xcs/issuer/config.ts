import { adminSecret } from '../admin/config'
import { loadAuthConfig } from '../auth/config'
import { loadPrivateDocumentStorageConfig } from '../documents/config'
import { apiSettings } from '../settings'
export function loadIssuerConfig(env: NodeJS.ProcessEnv) {
  const supplied = ['NUXT_ISSUER_DATABASE_URL', 'NUXT_ISSUER_DATABASE_URL_FILE'].some(
    (name) => (env[name] ?? '').trim().length > 0,
  )
  if (!supplied) return undefined
  if (loadAuthConfig(env) === undefined) throw new Error('ISSUER_AUTH_REQUIRED')
  const databaseUrl = adminSecret(env, 'NUXT_ISSUER_DATABASE_URL')
  let database: URL, origin: URL
  try {
    database = new URL(databaseUrl)
    origin = new URL(env.XCS_AUTH_ORIGIN ?? '')
  } catch {
    throw new Error('ISSUER_CONFIGURATION_INVALID')
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    decodeURIComponent(database.username) !== 'xcs_issuer' ||
    !database.password
  )
    throw new Error('ISSUER_DATABASE_ROLE_REQUIRED')
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== env.XCS_AUTH_ORIGIN ||
    origin.username ||
    origin.password
  )
    throw new Error('ISSUER_ORIGIN_INVALID')
  const storage = loadPrivateDocumentStorageConfig(env)
  const lifetime = env.XCS_ISSUER_INVITE_DAYS ?? apiSettings.XCS_ISSUER_INVITE_DAYS
  if (!/^\d+$/.test(lifetime) || Number(lifetime) < 1 || Number(lifetime) > 30)
    throw new Error('ISSUER_INVITE_LIFETIME_INVALID')
  return { databaseUrl, origin: origin.origin, storage, inviteDays: Number(lifetime) }
}
