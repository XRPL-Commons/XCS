// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  eslintConfigPrettier,
  {
    ignores: ['dist/**', '.output/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    // The protocol code under `app/lib/xcs` and its suite under `test/lib/xcs`
    // are verbatim copies of `packages/core` and `packages/sdk` (see each
    // file's header). Two rules reject patterns that are deliberate there and
    // that this app must not "fix", because any edit diverges from the source:
    // the copied parsers match control characters on purpose, and one
    // submission loop is written as `while (true)`. Every other rule still
    // applies, so a future hand-mirror cannot smuggle in unrelated problems.
    files: ['app/lib/xcs/**/*.ts', 'test/lib/xcs/**/*.ts'],
    rules: {
      'no-control-regex': 'off',
      'no-constant-condition': 'off',
    },
  },
)
