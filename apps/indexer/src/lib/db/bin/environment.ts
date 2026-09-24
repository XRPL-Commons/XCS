// Copied from packages/db/src/bin/environment.ts at a9777cc; keep in sync by hand (see CONTRIBUTING.md).
import { readFileSync, statSync } from 'node:fs'

/** Absence disables an optional capability; an explicitly empty value is invalid. */
export function optionalEnvironment(name: string): string | undefined {
  if (process.env[name] === undefined && process.env[`${name}_FILE`] === undefined) return undefined
  return requiredEnvironment(name)
}

/** Supports secret files in native CLI runs as well as the container entrypoint. */
export function requiredEnvironment(name: string): string {
  const direct = process.env[name]
  const path = process.env[`${name}_FILE`]
  if (direct && path) throw new Error('DATABASE_ENVIRONMENT_CONFLICT')
  let value = direct
  if (path) {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) {
      throw new Error('DATABASE_SECRET_FILE_INVALID')
    }
    value = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    if (/[\r\n]/.test(value)) throw new Error('DATABASE_SECRET_FILE_INVALID')
  }
  if (!value?.trim()) throw new Error('DATABASE_ENVIRONMENT_REQUIRED')
  return value
}
