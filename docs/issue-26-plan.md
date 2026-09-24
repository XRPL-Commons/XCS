# Issue 26 — forward migration commands

Baseline: `6aa23f5`, with concurrent ADR 0004 and issue 29 documentation preserved.

## Goal and boundaries

Provide `db:migrate` and read-only `db:status` for the existing Drizzle journal, retaining bootstrap
for initial runtime-role provisioning. Keep all deployed SQL, snapshots and journal timestamps
unchanged. No application tables, active database, wallet environment or running service is changed.

## Milestones

1. **Complete:** add shared migration/status implementation, immutable-history checks and
   serialized migration execution; bootstrap reuses it and validates configuration first.
2. **Complete:** add commands, database package export/build entries, one-shot Compose migration profile,
   secret-file support and CI generation checks including untracked generated files.
3. **Complete for the 0000–0002 baseline:** test fresh/repeated/upgrade/failure/concurrent/history-drift cases on isolated PostgreSQL
   18, then existing indexer/API integration suites; build and smoke the unprivileged database image.
4. **Complete:** synchronize operator documentation and review the #26 diff and preserved SQL hashes.

## Execution evidence

- `pnpm --filter @xcs-protocol/db typecheck` and package build passed.
- Database unit suite: 43 passed; the 12 PostgreSQL cases were deliberately skipped there without
  a database URL and were run separately below.
- `pnpm test:postgres` against a newly created isolated PostgreSQL 18 cluster exposed only on
  loopback port 55426: 12 migration, 13 indexer and 5 API integration tests passed. No active Testnet
  service was stopped or its database contacted.
- `db:generate` produced no diff or untracked artifact on the existing 0000–0002 catalog before
  concurrent #25 migration generation started. Existing SQL bytes and journal prefix are preserved.
- Base/dev/secrets/hosted-payload Compose configurations rendered with monitoring, demo-pinning
  and maintenance profiles. The migration job uses the bootstrap image and only its admin secret.
- Production database image built; status → migrate → migrate → status passed on a fresh isolated
  database as uid 1000, with a read-only filesystem and mounted URL secret. Native built CLIs passed
  the same sequence through the external loopback URL and returned redacted JSON on failure.
- `sh ops/ci/test-node-entrypoint.sh` passed, including bootstrap-URL secret-file loading.
- `pnpm verify` was attempted and stopped at formatting in concurrently added #25 files:
  `schema/app/identity.ts`, `issuance.ts`, `organizations.ts`, `presentations.ts`. Those files were
  not reformatted or fixed by #26. This is not a full-workspace green result; later stages did not run.

The concurrent #25 task added application schemas, helpers and migration `0003_application_model`
after the baseline checks above. That migration's constraints, runtime grants and complete combined
workspace require the #25 validation; these results must not be represented as its release evidence.
No production migration was performed for #26. Its implementation and the #29 design are committed
separately from the concurrent #24/#25 work.

## Validation and rollout

- Narrow database unit/type checks, migration PostgreSQL suite, existing PostgreSQL suites.
- Drizzle generation yields no changed or untracked migration artifact.
- Render base, dev, secrets, hosted-payload and optional profiles without reading real secrets.
- Run the database production image as its configured unprivileged user against a dedicated test
  cluster, using mounted test-secret files; exercise status and migration twice.
- Managed production PostgreSQL is external. Operators back it up and stop/fence indexer and web
  writers before projection migrations, run migrations with an administrative identity, validate
  status/privileges, then deploy services. Runtime accounts never receive DDL or admin credentials.
- Recovery uses forward fixes. For an incompatible committed migration restore a verified backup
  into a separate database and deploy its matching application version; never rewrite history.

## Risks and assumptions

Drizzle 0.45.2 selects migrations by timestamp without validating recorded hashes or serializing
separate processes. The wrapper rejects a non-prefix/modified history before DDL and acquires
a database-scoped transaction advisory lock. It uses Drizzle's SQL reader and existing journal
format inside one postgres.js transaction: the stock Drizzle migrator cannot consume a reserved
postgres.js connection. Provisioning remains a separate
transaction after migrations because its grants refer to existing tables. This limitation must be
documented rather than presenting bootstrap as one atomic migration-plus-role transaction.

The existing integration suites alter cluster-wide roles; use a new disposable cluster, never the
running Testnet PostgreSQL containers. Live managed-provider permission differences remain an
operator qualification requirement, even after isolated external-URL tests pass.
