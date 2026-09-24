import { readFileSync, statSync } from 'node:fs'

export interface AuthConfig {
  origin: string
  issuerUrl: string
  clientId: string
  clientSecret: string
  databaseUrl: string
  idleSeconds: number
  absoluteSeconds: number
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const direct = env[name]
  const file = env[`${name}_FILE`]
  if (direct && file) throw new Error('AUTH_SECRET_CONFLICT')
  if (!file) return direct ?? ''
  const stat = statSync(file)
  if (!stat.isFile() || stat.size > 16384 || stat.size < 1) throw new Error('AUTH_SECRET_INVALID')
  const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error('AUTH_SECRET_INVALID')
  return value
}

function seconds(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error('AUTH_DURATION_INVALID')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 60 || n > max) throw new Error('AUTH_DURATION_INVALID')
  return n
}

export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  if (env.XCS_AUTH_ENABLED !== undefined && !['0', '1'].includes(env.XCS_AUTH_ENABLED)) {
    throw new Error('XCS_AUTH_ENABLED must be 0 or 1')
  }
  if (env.XCS_AUTH_ENABLED !== '1') return undefined
  const clientId = secret(env, 'XCS_IDENTITY_CLIENT_ID')
  const clientSecret = secret(env, 'XCS_IDENTITY_CLIENT_SECRET')
  const databaseUrl = secret(env, 'NUXT_APP_DATABASE_URL')
  if (!clientId || !clientSecret || !databaseUrl) throw new Error('AUTH_CONFIGURATION_REQUIRED')
  let origin: URL, issuer: URL, database: URL
  try {
    origin = new URL(env.XCS_AUTH_ORIGIN ?? '')
    issuer = new URL(env.XCS_IDENTITY_ISSUER ?? 'https://account.xrpl.in')
    database = new URL(databaseUrl)
  } catch {
    throw new Error('AUTH_CONFIGURATION_INVALID')
  }
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error('AUTH_HTTPS_ORIGIN_REQUIRED')
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password
  ) {
    throw new Error('AUTH_HTTPS_ISSUER_REQUIRED')
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    decodeURIComponent(database.username) !== 'xcs_app' ||
    !database.password
  ) {
    throw new Error('AUTH_APPLICATION_DATABASE_ROLE_REQUIRED')
  }
  const idleSeconds = seconds(env.XCS_AUTH_IDLE_SECONDS, 1800, 86400)
  const absoluteSeconds = seconds(env.XCS_AUTH_MAX_SECONDS, 28800, 604800)
  if (idleSeconds > absoluteSeconds) throw new Error('AUTH_DURATION_INVALID')
  return {
    origin: origin.origin,
    issuerUrl: issuer.href.replace(/\/$/, ''),
    clientId,
    clientSecret,
    databaseUrl,
    idleSeconds,
    absoluteSeconds,
  }
}
