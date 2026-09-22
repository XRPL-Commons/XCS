// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(eslintConfigPrettier, {
  ignores: ['.output/**', 'playwright-report/**', 'test-results/**'],
})
