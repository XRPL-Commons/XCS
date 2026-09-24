# Testing

There are three independently checked units: the root workspace (`packages/*`) and the two
standalone applications, each with its own lockfile and `node_modules`.

Install once:

```bash
pnpm install        # packages/core, packages/sdk, packages/cli
pnpm install:apps   # apps/web and apps/indexer, each with --ignore-workspace
```

`--ignore-workspace` is mandatory on any per-app command that resolves dependencies — `install`,
`audit`, `licenses list`. Without it pnpm silently operates on the root workspace and still exits 0.
Commands that only run a script (`pnpm --dir apps/web test`) do not need it.

Run focused checks while editing:

```bash
pnpm --filter @xcs-protocol/core test
pnpm --filter @xcs-protocol/sdk test
pnpm --filter @xcs-protocol/cli test
pnpm --dir apps/web test
pnpm --dir apps/indexer test
```

`--filter` reaches the three workspace packages only; the applications are not workspace members and
are addressed with `--dir`.

Each unit also provides `lint`, `typecheck`, `build` and a combined `verify`. Before merging a change
that crosses more than one of them, run the root aggregate:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

or, equivalently, `pnpm verify`. To verify one application on its own:

```bash
pnpm --dir apps/web verify
pnpm --dir apps/indexer verify
```

## Integration tiers

1. Unit tests need no network or database.
2. PostgreSQL integration tests require an isolated PostgreSQL 18 admin URL in `XCS_TEST_DATABASE_URL`.
3. Browser tests use Playwright and deterministic fake ledger/wallet boundaries.
4. Real Testnet acceptance requires externally controlled funded wallets, a published network profile, two complete-history sources, and a running PostgreSQL projection.

Run the PostgreSQL suites with:

```bash
pnpm test:postgres                    # both applications
pnpm --dir apps/indexer test:postgres
pnpm --dir apps/web test:postgres
```

Install Chromium once and run browser flows with:

```bash
pnpm --dir apps/web exec playwright install chromium
pnpm test:e2e
```

`pnpm test:e2e` builds the web app and then runs both Playwright configurations. To run them
separately from the application directory:

```bash
pnpm --dir apps/web test:e2e
pnpm --dir apps/web test:e2e:security
```

Unit and browser mocks prove application transitions; they do not prove a specific wallet version supports XRPL Credentials. Record real wallet compatibility separately against Testnet.

## Migrations

`db/schema/` and `db/migrations/` are shared source compiled by both applications. After editing the
schema, regenerate the migration with the indexer's tooling and commit the result; CI regenerates it
and fails on any diff:

```bash
pnpm --dir apps/indexer db:generate
```

## What tests must assert

- Core tests cover accepted values and rejection boundaries, not private helper implementations.
- SDK tests inspect the exact unsigned XRPL transaction and signed-blob submission checks.
- Indexer tests prove source agreement, ordering, idempotency, and fail-closed projection behavior.
- Web server tests prove snapshot consistency, bounded external fetches, and separate
  unavailable/tampered/invalid results for the `/v1` handlers.
- Web application tests prove user-visible workflow transitions and that signing remains in the wallet.

Because neither application imports `packages/core` or `packages/sdk`, a green package suite proves
nothing about the applications' copies of that code. A protocol change must be mirrored and the
affected application's suite rerun in the same pull request; see [`CONTRIBUTING.md`](../CONTRIBUTING.md).

If a required environment is unavailable, report the exact skipped command and do not describe it as passing.
