# XCS indexer

The indexer is the XCS projection writer. It reads validated XRP Ledger history from two
independently operated `rippled` sources, projects schema registrations and Credential lifecycle
events into PostgreSQL, and advances only on evidence both sources agree on. It has no HTTP surface:
the read and verification API is served by [`apps/web`](../web/README.md) from the same database.

It is a standalone application. It has its own `package.json`, `pnpm-lock.yaml`, `.npmrc`, tsconfig,
Prettier config, `Dockerfile` and `.env.example`, and it imports no workspace package. The protocol
and database code it needs is copied by hand into `src/lib/xcs/` and `src/lib/db/`, each file headed
with the file it came from; see [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and
[ADR 0004](../../docs/adr/0004-two-standalone-apps.md).

The only shared source is [`db/`](../../db/README.md) — the Drizzle table definitions and the
generated SQL migrations — compiled through the `#db/*` path alias.

## Getting started

`--ignore-workspace` is mandatory on any pnpm command that resolves dependencies (`install`, `audit`,
`licenses list`). Without it pnpm silently operates on the root workspace and still exits 0. Commands
that only run a script do not need it.

```sh
pnpm --dir apps/indexer install --ignore-workspace --frozen-lockfile
pnpm --dir apps/indexer dev      # tsx watch src/main.ts
pnpm --dir apps/indexer verify   # format:check, lint, test, build
```

Configuration is the contract in [`.env.example`](./.env.example). The long-running service reads the
first ten variables; the last five are read only by `db:bootstrap`.

The committed `config/networks/testnet.example.json` is a placeholder with an invalid registry and
activation boundary. The indexer refuses it and stops with `SOURCE_REGISTRY_NOT_BLACKHOLED`. **This is
by design:** reaching a steady state requires an operator-supplied profile naming a genuinely
blackholed registry account whose ceremony has been completed and independently audited.

## Database tooling

The indexer owns every database command. `drizzle-kit` and the migration runner are its
devDependencies; the web app has none of them.

```sh
pnpm --dir apps/indexer db:generate    # regenerate db/migrations after editing db/schema — commit the result
pnpm --dir apps/indexer db:migrate     # apply migrations to an existing database (idempotent)
pnpm --dir apps/indexer db:bootstrap   # migrate + provision xcs_indexer / xcs_api / xcs_monitor
```

`db:bootstrap` runs once against a fresh database and needs `XCS_BOOTSTRAP_DATABASE_URL`,
`XCS_DATABASE_CLUSTER_SCOPE=dedicated` and the three runtime passwords. It is idempotent, which is
also how a runtime password is rotated. PostgreSQL is provisioned outside this repository; see
[`docs/database.md`](../../docs/database.md) and the
[deployment runbook](../../docs/runbooks/deployment.md).

## Operations

```sh
pnpm --dir apps/indexer preflight           # verify both sources against the profile before starting
pnpm --dir apps/indexer start               # node dist/main.js (after build)
pnpm --dir apps/indexer replay              # create-only rebuild to one immutable target boundary
pnpm --dir apps/indexer projection:digest   # deterministic digest for comparing two replays
pnpm --dir apps/indexer fixture:capture     # capture agreed ledgers as a replay bundle
pnpm --dir apps/indexer fixture:validate    # offline validation of a captured bundle
```

Preflight checks network ID, contiguous retained history, the amendment, the activation ledger and
the selected registry policy on both sources, and prints no endpoint or credential. The full
procedures — healthy state, recovery, deterministic rebuild and evidence capture — are in the
[indexer runbook](../../docs/runbooks/indexer.md).

## Tests

```sh
pnpm --dir apps/indexer test
pnpm --dir apps/indexer test:coverage
pnpm --dir apps/indexer test:postgres   # needs XCS_TEST_DATABASE_URL against PostgreSQL 18
```

## Image

`Dockerfile` builds with the **repository root** as build context, because the image also needs
`db/` and `config/` beside the application. Nothing under `packages/` is copied in. It runs as the
unprivileged `node` user and starts `node dist/main.js`; the same image runs bootstrap as
`node dist/lib/db/bin/bootstrap.js`.
