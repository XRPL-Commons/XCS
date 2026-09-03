# Database package refactor

## Plan

- [x] Define the fresh-database bootstrap contract and preserve runtime invariants.
- [x] Split the Drizzle schema into focused modules and tighten fresh-schema nullability/checks.
- [x] Replace the five-step migration history with one generated baseline and a minimal initializer.
- [x] Replace cluster-wide provisioning machinery with a scoped fresh-cluster role/grant provisioner.
- [x] Narrow package exports and make operational entrypoints part of the normal package build.
- [x] Update API/indexer integration setup, Compose, Docker, CI, configuration, and documentation.
- [x] Format and run unit, type, build, PostgreSQL integration, Compose render, and image/startup checks.

## Invariants to preserve

- Fenced single-writer leases use database time and reject stale writer epochs.
- Projection writes and lease validation remain in the same transaction.
- Indexer halt status and durable incidents remain atomic.
- API authoritative reads remain repeatable-read and read-only.
- Serializable transactions retain bounded retry for serialization failures and deadlocks.
- Database constraints continue to protect schema evidence, credential lifecycle ordering, and one live credential per tuple.
- Runtime database roles retain least-privilege access.

## Review

- Replaced the five historical migrations with one generated baseline for fresh databases and exposed a single idempotent bootstrap entrypoint.
- Split schema ownership by domain, kept runtime exports separate from administration, and reduced provisioning to dedicated-cluster role normalization plus explicit least-privilege grants.
- Updated API/indexer PostgreSQL setup, Compose, production images, CI, configuration, and documentation to use the bootstrap contract.
- Verified `pnpm verify`, all 16 PostgreSQL integration scenarios, clean Drizzle generation, every Compose profile/overlay render, and production image builds.
- Started the secret-file stack from an empty volume, reran bootstrap successfully, confirmed the API was healthy as UID 1000, and asserted the fresh schema and non-superuser runtime roles.
