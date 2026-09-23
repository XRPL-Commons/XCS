import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/postgres.integration.test.ts'],
  },
})
