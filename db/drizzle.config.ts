import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { defineConfig } from 'drizzle-kit'

// Resolve paths from this file so generation can use the owning indexer app’s
// dependencies without installing a second dependency tree in the shared folder.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    fileURLToPath(new URL('./schema/index.ts', import.meta.url)),
    fileURLToPath(new URL('./schema/app/index.ts', import.meta.url)),
  ],
  out: relative(process.cwd(), fileURLToPath(new URL('./migrations', import.meta.url))),
  dbCredentials: {
    url:
      process.env.XCS_BOOTSTRAP_DATABASE_URL ??
      process.env.XCS_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://xcs_admin:xcs_admin@localhost:5432/xcs',
  },
  strict: true,
  verbose: true,
})
