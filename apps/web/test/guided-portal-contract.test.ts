import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import en from '../i18n/locales/en.json'
import fr from '../i18n/locales/fr.json'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../app/${path}`, import.meta.url)), 'utf8')

describe('guided portal contracts', () => {
  it('keeps the French and English catalogs structurally identical', () => {
    expect(leafPaths(fr).sort()).toEqual(leafPaths(en).sort())
  })

  it('keeps compatibility pages as input-free redirects', () => {
    for (const path of [
      'pages/studio.vue',
      'pages/schemas/register.vue',
      'pages/issue.vue',
      'pages/accept.vue',
      'pages/revoke.vue',
      'pages/verify.vue',
      'pages/operations.vue',
    ]) {
      const page = source(path)
      expect(page).toContain('legacyPortalDestination')
      expect(page).not.toMatch(/<(?:form|input|textarea)|<UInput/u)
    }
  })

  it('does not expose protocol identifiers in the verifier result', () => {
    const template = source('components/PresentationResult.vue').split('</script>')[1] ?? ''
    expect(template).not.toMatch(
      /subjectAddress|issuerAddress|generationId|profileId|schemaUid|JsonBlock/u,
    )
  })

  it('keeps application components independent from server implementation types', () => {
    const applicationSources = [
      'types/portal.ts',
      'composables/useAuth.ts',
      'composables/useIssuerWorkspace.ts',
      'composables/useRecipientWorkspace.ts',
      'pages/verifier/index.vue',
    ]
      .map(source)
      .join('\n')
    expect(applicationSources).not.toContain('server/xcs')
  })
})
