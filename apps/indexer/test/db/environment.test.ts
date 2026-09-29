import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { requiredEnvironment } from '../../src/lib/db/bin/environment.js'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'xcs-db-env-'))
  directories.push(directory)
  const path = join(directory, 'secret')
  writeFileSync(path, value)
  return path
}

describe('database command environment', () => {
  it('uses a direct URL or a one-line secret file without changing encoded credentials', () => {
    const value = 'postgres://test:fixture%25encoded@127.0.0.1/example?sslmode=verify-full'
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL_FILE', undefined)
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL', value)
    expect(requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')).toBe(value)
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL', undefined)
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL_FILE', fixture(`${value}\r\n`))
    expect(requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')).toBe(value)
  })

  it('rejects missing, conflicting, empty, multiline and oversized values', () => {
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL', undefined)
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL_FILE', undefined)
    expect(() => requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')).toThrow(
      'DATABASE_ENVIRONMENT_REQUIRED',
    )
    for (const value of ['', '\n', 'first\nsecond', 'x'.repeat(16_385)]) {
      vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL_FILE', fixture(value))
      expect(() => requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')).toThrow()
    }
    vi.stubEnv('XCS_BOOTSTRAP_DATABASE_URL', 'fixture-direct-value')
    expect(() => requiredEnvironment('XCS_BOOTSTRAP_DATABASE_URL')).toThrow(
      'DATABASE_ENVIRONMENT_CONFLICT',
    )
  })
})
