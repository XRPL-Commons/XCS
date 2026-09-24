#!/usr/bin/env node
// Asserts apps/web and apps/indexer resolve the same drizzle-orm version.
//
// Both apps compile the same hand-vendored db/schema copy, but they install
// from independent lockfiles, so a routine update to one of them could move
// only that app's Drizzle and nothing in either build would notice. The
// declared range is deliberately a range (the apps take patch updates on their
// own schedule); what must not drift is the version the two lockfiles settle
// on. Comparing the lockfiles catches that, including a move that comes in
// through a transitive peer rather than the direct dependency.
//
// Node built-ins only. Run from the repository root:
//   node ops/ci/check-drizzle-parity.mjs

import { existsSync, readFileSync } from 'node:fs'

const LOCKFILES = ['apps/web/pnpm-lock.yaml', 'apps/indexer/pnpm-lock.yaml']
const SNAPSHOT = /^ {2}drizzle-orm@(\d+\.\d+\.\d+[^:(\s]*)/

/** The versions of `drizzle-orm` a lockfile's package snapshots resolve. */
function resolvedVersions(lockfile) {
  const versions = new Set()
  for (const line of readFileSync(lockfile, 'utf8').split('\n')) {
    const match = SNAPSHOT.exec(line)
    if (match !== null) versions.add(match[1])
  }
  return [...versions].sort()
}

const failures = []
const resolved = new Map()
for (const lockfile of LOCKFILES) {
  if (!existsSync(lockfile)) {
    failures.push(`${lockfile}: not found; run this check from the repository root`)
    continue
  }
  const versions = resolvedVersions(lockfile)
  if (versions.length === 0) failures.push(`${lockfile}: resolves no drizzle-orm version`)
  resolved.set(lockfile, versions)
}

if (failures.length === 0) {
  const [web, indexer] = LOCKFILES.map((lockfile) => resolved.get(lockfile).join(', '))
  if (web !== indexer) {
    failures.push(
      'apps/web and apps/indexer resolve different drizzle-orm versions, but they compile the ' +
        `same vendored db/schema copy: apps/web has ${web}, apps/indexer has ${indexer}. ` +
        'Update both lockfiles together.',
    )
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  process.exit(1)
}

console.log(`drizzle-orm parity: both apps resolve ${resolved.get(LOCKFILES[0]).join(', ')}`)
