import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
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
