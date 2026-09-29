import { readFileSync, statSync } from 'node:fs'

export function serverSecret(env: NodeJS.ProcessEnv, name: string): string {
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
