// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(eslintConfigPrettier, {
  ignores: [
    '.output/**',
    'playwright-report/**',
    'test-results/**',
    // The protocol code under `app/lib/xcs` and its suite under `test/lib/xcs`
    // are verbatim copies of `packages/core` and `packages/sdk` (see each file's
    // header). Linting them here would force edits that diverge from the source,
    // so they stay out: `packages/` owns their style, and `nuxt typecheck` still
    // type-checks them as part of this app.
    'app/lib/xcs/**',
    'test/lib/xcs/**',
  ],
})
