// Not a vendored copy (retired source): application-local database implementation maintained with db/schema.
import { readFileSync, statSync } from 'node:fs'

import { DatabaseBootstrapConfigurationError } from '../provision.js'

/** Supports secret files in native CLI runs as well as the container entrypoint. */
export function requiredEnvironment(name: string): string {
  const direct = process.env[name]
  const path = process.env[`${name}_FILE`]
  if (direct && path) {
    throw new DatabaseBootstrapConfigurationError(
      `DATABASE_ENVIRONMENT_CONFLICT: ${name} and ${name}_FILE cannot both be set`,
    )
  }
  let value = direct
  if (path) {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size < 1 || stat.size > 16_384) {
      throw new DatabaseBootstrapConfigurationError(
        `DATABASE_SECRET_FILE_INVALID: ${name}_FILE must contain one non-empty value of at most 16384 bytes`,
      )
    }
    value = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    if (/[\r\n]/.test(value)) {
      throw new DatabaseBootstrapConfigurationError(
        `DATABASE_SECRET_FILE_INVALID: ${name}_FILE must contain exactly one line`,
      )
    }
  }
  if (!value?.trim()) {
    throw new DatabaseBootstrapConfigurationError(
      `DATABASE_ENVIRONMENT_REQUIRED: ${name} is required. Set it in the same command that runs this step; a bare shell assignment on its own line is not exported to the process.`,
    )
  }
  return value
}
