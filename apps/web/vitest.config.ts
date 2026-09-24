import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#db': fileURLToPath(new URL('../../db', import.meta.url)),
      '#xcs': fileURLToPath(new URL('./app/lib/xcs', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
