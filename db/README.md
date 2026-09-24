# `db/` — the shared database schema

This folder is **not a package**. It has no `package.json`, no build and no version. It holds the
only code the two applications share: the Drizzle table definitions (`schema/`) and the generated
SQL migrations (`migrations/`).

Both `apps/web` and `apps/indexer` compile these files as their own sources through the `#db/*` path
alias (`#db/schema` → `db/schema/index.ts`). Third-party imports inside `schema/` (`drizzle-orm`)
resolve from whichever application compiles the file, so both applications pin the same `drizzle-orm`
version.

Everything else that used to live in `packages/db` — the client, fencing, transaction helpers, role
provisioning and bootstrap — is vendored into each application under `apps/indexer/src/lib/db/` and
`apps/web/server/lib/db/`. Those copies carry a header naming their origin and must be kept in sync
by hand (see `CONTRIBUTING.md`).

## The indexer owns the tooling

`drizzle-kit` and the migration runner are devDependencies of `apps/indexer` only. Every command
below is run from `apps/indexer` (or with `pnpm --filter @xcs-protocol/indexer`).

### Generate a migration after editing `schema/`

```sh
pnpm --filter @xcs-protocol/indexer db:generate
```

This runs `drizzle-kit generate --config ../../db/drizzle.config.ts` and writes a new SQL file plus
an updated snapshot under `db/migrations/`. Commit them: CI regenerates and fails on any diff.

### Apply migrations

```sh
XCS_BOOTSTRAP_DATABASE_URL=postgres://xcs_admin:…@host:5432/xcs \
  pnpm --filter @xcs-protocol/indexer db:migrate
```

Idempotent: `drizzle-orm`'s migrator records applied migrations in `drizzle.__drizzle_migrations`
and a second run applies nothing. The migration folder defaults to `../../db/migrations` relative to
the indexer application and can be overridden with `XCS_MIGRATIONS_DIR` (the container image sets it
to the copy of `db/migrations` beside the built application).

### Bootstrap a fresh database

```sh
pnpm --filter @xcs-protocol/indexer db:bootstrap
```

Applies the migrations and then provisions the cluster-wide runtime roles (`xcs_indexer`, `xcs_api`,
`xcs_monitor`) from `XCS_INDEXER_DATABASE_PASSWORD`, `XCS_API_DATABASE_PASSWORD` and
`XCS_MONITOR_DATABASE_PASSWORD`. It requires `XCS_DATABASE_CLUSTER_SCOPE=dedicated` because those
roles are cluster-wide.

### Never edit an applied migration

Add a new one instead. `migrations/meta/_journal.json` is the applied-migration ledger and must stay
append-only.
