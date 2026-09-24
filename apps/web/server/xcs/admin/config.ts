import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
export function adminSecret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[`${name}_FILE`],
    direct = env[name]
  if (file && direct) throw new Error('ADMIN_SECRET_CONFLICT')
  if (!file) return direct ?? ''
  const stat = statSync(file)
  if (!stat.isFile() || stat.size < 1 || stat.size > 16384) throw new Error('ADMIN_SECRET_INVALID')
  const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  if (!value || /[\r\n]/.test(value)) throw new Error('ADMIN_SECRET_INVALID')
  return value
}
export function loadAdminConfig(env: NodeJS.ProcessEnv) {
  if (env.XCS_ADMIN_ENABLED !== undefined && !['0', '1'].includes(env.XCS_ADMIN_ENABLED))
    throw new Error('ADMIN_FLAG_INVALID')
  if (env.XCS_ADMIN_ENABLED !== '1') return undefined
  if (env.XCS_AUTH_ENABLED !== '1') throw new Error('ADMIN_AUTH_REQUIRED')
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
  const directory = env.XCS_ADMIN_DOCUMENT_DIRECTORY ?? ''
  if (!isAbsolute(directory) || Buffer.byteLength(signingKey) < 32)
    throw new Error('ADMIN_DOCUMENT_CONFIGURATION_REQUIRED')
  return { databaseUrl, signingKey, directory }
}
