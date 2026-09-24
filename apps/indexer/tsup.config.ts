import { fileURLToPath } from 'node:url'

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/main.ts',
    'src/maintenance.ts',
    'src/fixture-cli.ts',
    'src/lib/db/bin/bootstrap.ts',
    'src/lib/db/bin/migrate.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  esbuildOptions(options) {
    options.alias = { '#db': fileURLToPath(new URL('../../db', import.meta.url)) }
  },
})
