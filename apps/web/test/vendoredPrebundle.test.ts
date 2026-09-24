import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { vendoredPrebundleDependencies } from '../vendoredPrebundle'

const vendoredRoot = fileURLToPath(new URL('../app/lib/xcs', import.meta.url))

async function vendoredSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await vendoredSources(path)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files.sort()
}

/**
 * Every `from '…'` specifier that is not relative, i.e. every third-party
 * package the vendored protocol code reaches for. Vite must pre-bundle exactly
 * these; see `vendoredPrebundle.ts`.
 */
function bareSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+'([^']+)'/gu)]
    .map((match) => match[1] as string)
    .filter((specifier) => !specifier.startsWith('.'))
}

describe('vendored pre-bundle list', () => {
  it('matches every third-party import of the vendored protocol code', async () => {
    const files = await vendoredSources(vendoredRoot)
    expect(files.length).toBeGreaterThan(0)

    const found = new Set<string>()
    for (const file of files) {
      for (const specifier of bareSpecifiers(await readFile(file, 'utf8'))) {
        found.add(specifier)
      }
    }

    expect([...found].sort()).toEqual([...vendoredPrebundleDependencies].sort())
  })

  it('lists each specifier once', () => {
    expect(new Set(vendoredPrebundleDependencies).size).toBe(vendoredPrebundleDependencies.length)
  })
})
