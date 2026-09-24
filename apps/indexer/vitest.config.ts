import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '#db': fileURLToPath(new URL('../../db', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration files provision the same cluster-wide roles, even in separate databases.
    fileParallelism: !process.env.XCS_TEST_DATABASE_URL?.trim(),
  },
})
