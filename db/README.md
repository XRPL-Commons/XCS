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

`drizzle-kit` and the migration runner are devDependencies of `apps/indexer` only. `apps/indexer` is
not a workspace member, so every command below uses `--dir` rather than `--filter`.

### Generate a migration after editing `schema/`

```sh
pnpm --dir apps/indexer db:generate
```

This runs Drizzle Kit from the indexer application with its own `node_modules` on `NODE_PATH`.
The config resolves schema paths from this folder and computes the output path relative to the
command's working directory; no root or shared-folder dependency installation is required. It writes
a new SQL file and snapshot under `db/migrations/`. Commit them: CI regenerates and fails on any diff.

Install the indexer's dependencies independently with
`pnpm --dir apps/indexer install --ignore-workspace --frozen-lockfile` before using these commands.

### Apply migrations

```sh
XCS_BOOTSTRAP_DATABASE_URL=postgres://xcs_admin:…@host:5432/xcs \
  pnpm --dir apps/indexer db:migrate
```

The runner validates the ordered journal and applied SQL hashes, rejects migration ownership
conflicts, and records applied migrations in `drizzle.__drizzle_migrations`. A second run applies
nothing. Migration DDL does not provision or rotate runtime roles. The folder is resolved from the
source or compiled application and can be overridden with `XCS_MIGRATIONS_DIR` for container layouts.
The bootstrap URL supports the `_FILE` secret convention as well as a direct environment value.

Inspect applied and pending migrations without DDL using `pnpm --dir apps/indexer db:status`.

### Bootstrap a fresh database

```sh
pnpm --dir apps/indexer db:bootstrap
```

Before running it, create all eight users through the managed database service: `xcs_indexer`,
`xcs_api`, `xcs_payload_writer`, `xcs_monitor`, `xcs_app`, `xcs_admin_app`, `xcs_notifier` and
`xcs_issuer`. The bootstrap requires only the administrator URL and
`XCS_DATABASE_CLUSTER_SCOPE=dedicated`. It checks every user before DDL, applies migrations and
least-privilege grants atomically, and never creates a role or reads, changes or rotates a password.
The operator-only `pnpm --dir apps/indexer admin:bootstrap` command grants the first administrator
to an existing exact OIDC issuer/subject and writes an audit record; it never matches by email.

## Application migrations and validation

Migrations 0000–0006, their snapshots and journal entries retain the exact bytes from the previous
application implementation. Additive migration `0007_recipient_verifier` supplies recipient and
verifier history, and `0008_presentation_wallet_proof` binds presentation grants to a verified wallet
signature. The complete deployment journal is therefore `0000`–`0008`. Schemas are shared here;
clients, grants and application helpers remain local to each application.

`pnpm --dir apps/indexer test:postgres` runs the migrated DB suites and indexer suite sequentially.
Use only an isolated disposable cluster configured through `XCS_TEST_DATABASE_URL`: the tests create
and remove cluster-wide stand-ins for the managed users. The regular `test` command skips database
integration when that URL is absent.

### Never edit an applied migration

Add a new one instead. `migrations/meta/_journal.json` is the applied-migration ledger and must stay
append-only.
