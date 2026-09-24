import { defineConfig } from 'drizzle-kit'

// drizzle-kit resolves `schema` and `out` against the working directory, so the
// scripts that run it change into this folder first (see `db/README.md`).
export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/index.ts',
  out: './migrations',
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
