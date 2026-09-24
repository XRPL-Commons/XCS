#!/usr/bin/env node
// Enforces the mirroring rule in CONTRIBUTING.md.
//
// apps/web and apps/indexer import no workspace package: the protocol and
// database code they need is copied into them by hand. Nothing else in the
// build would notice if a copy drifted from its source, so this check does.
//
// Every file under a vendored directory must start with one of:
//
//   // Copied from <path> at <sha>; keep in sync by hand (see CONTRIBUTING.md).
//   // Not a vendored copy (<reason>): <description>
//
// For a copy, the body (everything after the header line) must equal its
// source, except that the module specifier of an import/export-from statement
// may be rewritten — that is the one edit vendoring always requires, because
// the copies resolve their siblings by relative path or through the #db/*
// alias.
//
// The source is read at HEAD when it still exists, not at the recorded <sha>.
// That is deliberate: <sha> is immutable, so comparing against it would only
// notice edits to the copy, never the case this check exists for — a change
// landing in packages/core that nobody mirrored. When the source has been
// retired from the tree (the former packages/db), it can no longer drift, so
// the recorded <sha> is used instead.
//
// A copy that must differ from its source for a structural reason declares it
// on a second header line:
//
//   // Diverges by design (<reason>); source sha256:<hex>.
//
// The digest pins the exact source that divergence was reviewed against, so
// the file is exempt from the line comparison but still fails as soon as the
// source changes upstream and the divergence needs reviewing again.
//
// Node built-ins only. Run from the repository root:
//   node ops/ci/check-vendored-copies.mjs

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const VENDORED_DIRECTORIES = [
  'apps/web/app/lib/xcs',
  'apps/web/server/lib/db',
  'apps/indexer/src/lib/xcs',
  'apps/indexer/src/lib/db',
]

const COPIED_HEADER =
  /^\/\/ Copied from (\S+) at ([0-9a-f]{7,40}); keep in sync by hand \(see CONTRIBUTING\.md\)\.$/
const NOT_A_COPY_HEADER = /^\/\/ Not a vendored copy\b/
const DIVERGES_HEADER = /^\/\/ Diverges by design \(.+\); source sha256:([0-9a-f]{64})\.$/

// `} from '…'` and `export … from '…'` both end in the specifier; a bare
// side-effect `import '…'` is the whole statement.
const TRAILING_SPECIFIER = /(^|\s)from\s*(['"])[^'"]*\2\s*;?\s*$/
const BARE_SPECIFIER = /^\s*(?:import|export)\s*(['"])[^'"]*\1\s*;?\s*$/

/** Replaces the module specifier with a placeholder so two lines that differ
 * only in where they import from compare equal. */
function withoutSpecifier(line) {
  if (!TRAILING_SPECIFIER.test(line) && !BARE_SPECIFIER.test(line)) return null
  return line.replace(/(['"])[^'"]*\1(\s*;?\s*)$/, '<SPECIFIER>$2')
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function listFiles(directory) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) found.push(path)
    }
  }
  try {
    if (!statSync(directory).isDirectory()) return []
  } catch {
    return []
  }
  walk(directory)
  return found
}

function gitShow(revision, path) {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = String(error.stderr ?? error.message)
      .trim()
      .split('\n')[0]
    return { error: detail || 'git show failed' }
  }
}

/** The source as it is now, so an unmirrored upstream change is caught. Falls
 * back to the pinned commit for a source that has been retired from the tree. */
function readSource(sourcePath, sha) {
  if (existsSync(sourcePath)) {
    return { text: readFileSync(sourcePath, 'utf8'), origin: 'the working tree' }
  }
  const atHead = gitShow('HEAD', sourcePath)
  if (typeof atHead === 'string') return { text: atHead, origin: 'HEAD' }

  const atSha = gitShow(sha, sourcePath)
  if (typeof atSha === 'string') {
    return { text: atSha, origin: `${sha} (source retired from the tree)` }
  }
  return { error: atSha.error }
}

const findings = []
let identical = 0
let specifierOnly = 0
let byDesign = 0
let notCopies = 0

for (const directory of VENDORED_DIRECTORIES) {
  for (const file of listFiles(directory)) {
    const relativePath = relative(process.cwd(), file).split(sep).join('/')
    const lines = readFileSync(file, 'utf8').split('\n')
    const header = lines[0] ?? ''

    if (NOT_A_COPY_HEADER.test(header)) {
      notCopies += 1
      continue
    }

    const match = COPIED_HEADER.exec(header)
    if (match === null) {
      findings.push({
        file: relativePath,
        message:
          'missing header. A vendored file must start with\n' +
          '      // Copied from <path> at <sha>; keep in sync by hand (see CONTRIBUTING.md).\n' +
          '    or, if it has no upstream,\n' +
          '      // Not a vendored copy (<reason>): <description>',
      })
      continue
    }

    const [, sourcePath, sha] = match
    const source = readSource(sourcePath, sha)
    if (source.error !== undefined) {
      findings.push({
        file: relativePath,
        message: `cannot read its source ${sourcePath} (${source.error}).`,
      })
      continue
    }

    const diverges = DIVERGES_HEADER.exec(lines[1] ?? '')
    if (diverges !== null) {
      const actual = sha256(source.text)
      if (actual === diverges[1]) {
        byDesign += 1
        continue
      }
      findings.push({
        file: relativePath,
        message:
          `declares a by-design divergence reviewed against source sha256:${diverges[1]},\n` +
          `    but ${sourcePath} (read from ${source.origin}) is now sha256:${actual}.\n` +
          '    The source changed: re-review the divergence, mirror what applies, then update the digest.',
      })
      continue
    }

    const body = lines.slice(1).join('\n')
    if (body === source.text) {
      identical += 1
      continue
    }

    const bodyLines = body.split('\n')
    const sourceLines = source.text.split('\n')
    let rewrittenSpecifiers = 0
    let firstDifference = null

    for (let index = 0; index < Math.max(bodyLines.length, sourceLines.length); index += 1) {
      const copied = bodyLines[index]
      const original = sourceLines[index]
      if (copied === original) continue

      if (copied !== undefined && original !== undefined) {
        const a = withoutSpecifier(copied)
        const b = withoutSpecifier(original)
        if (a !== null && a === b) {
          rewrittenSpecifiers += 1
          continue
        }
      }

      firstDifference = {
        // +2: one for the stripped header line, one for 1-based numbering.
        line: index + 2,
        copied: copied ?? '(end of file)',
        original: original ?? '(end of file)',
      }
      break
    }

    if (firstDifference === null) {
      specifierOnly += 1
      continue
    }

    findings.push({
      file: relativePath,
      message:
        `differs from ${sourcePath} (read from ${source.origin}) beyond an import specifier.\n` +
        `    line ${firstDifference.line}\n` +
        `      copy:   ${firstDifference.copied}\n` +
        `      source: ${firstDifference.original}` +
        (rewrittenSpecifiers > 0
          ? `\n    (${rewrittenSpecifiers} earlier line(s) differed only in their import specifier, which is allowed)`
          : ''),
    })
  }
}

if (findings.length > 0) {
  process.stderr.write(`Vendored copies are out of sync (${findings.length} file(s)):\n\n`)
  for (const finding of findings) {
    process.stderr.write(`  ${finding.file}: ${finding.message}\n\n`)
  }
  process.stderr.write(
    'Protocol behaviour changes land in packages/core first and are mirrored by hand into both\n' +
      'applications in the same pull request. See CONTRIBUTING.md, "The mirroring rule".\n',
  )
  process.exit(1)
}

process.stdout.write(
  'Vendored copies are in sync: ' +
    `${identical} identical, ${specifierOnly} with rewritten import specifiers, ` +
    `${byDesign} diverging by design against a pinned source, ` +
    `${notCopies} declared as having no upstream.\n`,
)
