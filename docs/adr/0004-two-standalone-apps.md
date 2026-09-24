# ADR 0004: Two standalone applications, with the read API folded into the web app

Status: Accepted

Date: 2026-09-24

Supersedes the deployment topology recorded in the Nuxt UI migration design: the root `Dockerfile`,
the root `.env.example` and the server-side rendering hop from the web app to a separate API service.

## Context

The repository was a single pnpm workspace producing four deployable or publishable units — the
`apps/indexer` worker, the `apps/api` Fastify read/verification service, the `apps/web` Nuxt site,
and a `packages/db` package the two services shared — on top of `packages/core`, `packages/sdk` and
`packages/cli`.

That shape caused three concrete problems.

- **Deployment was all-or-nothing.** A single root `Dockerfile` and a single Compose topology with a
  secret-file overlay were the only supported way to run XCS. Deploying one service required
  reasoning about the workspace as a whole, and the deploy tooling had no way to treat one folder as
  one deployment.
- **The web app could not be deployed without the API.** Every server-rendered page made an internal
  HTTP hop to `apps/api`, which needed a private base URL, a shared internal token
  (`NUXT_API_INTERNAL_TOKEN`) so the API would accept the SSR-derived rate-limit identity, and a
  second public base URL for the browser. Three variables, one shared secret and one network hop
  existed purely because two processes served one product surface.
- **A workspace lockfile does not describe a deployable.** Every image installed the whole workspace,
  and an audit or licence report covered the workspace rather than what actually ships.

PostgreSQL, meanwhile, had come to be treated as something the repository provisions, because Compose
ran it. In practice it is an externally managed instance.

## Decision

**Two deployable applications, each fully self-contained.**

- `apps/indexer` — the validated-ledger ingestion worker. No HTTP surface. It owns the database
  tooling: `db:generate`, `db:migrate` and `db:bootstrap`.
- `apps/web` — one Nitro server that renders the UI **and** serves the read/verification API on the
  same origin: `/v1/**`, `/health/*`, `/internal/metrics*` and `/documentation`.

Each carries its own `package.json`, `pnpm-lock.yaml`, `.npmrc`, `.prettierrc.json`, tsconfig,
`Dockerfile` and `.env.example`, and is deployed on its own with `gh deploy-setup` run from its own
directory. Both Dockerfiles use the repository root as build context so the image can also copy `db/`
and `config/`; nothing under `packages/` enters either image.

**No shared code between the applications.** Neither imports `@xcs-protocol/*` or any other workspace
package. The protocol and database code each one needs is copied into it as plain source:
`apps/web/app/lib/xcs/{core,sdk}/`, `apps/web/server/lib/db/`, `apps/indexer/src/lib/{xcs,db}/`. Every
copied file starts with a header naming the file it came from and the commit it was copied at.

**One shared folder: `db/`.** The Drizzle table definitions (`db/schema/`) and the generated SQL
migrations (`db/migrations/`) are shared source, not a package — no `package.json`, no build, no
version. Both applications compile them through the `#db/*` path alias, and both pin the same
`drizzle-orm` version. A schema change is edited once and never mirrored.

**The database is external.** PostgreSQL is provisioned outside this repository. Compose — including
the `monitoring` and `demo-pinning` profiles — is a **local-development stack only**.

**`apps/api` and `packages/db` are retired.** The API's framework-free modules moved unchanged into
`apps/web/server/xcs/`, its Fastify routes became Nitro handlers with the same methods, paths,
validation and JSON envelopes, and its OpenAPI document is built from the same schemas. The `/v1`
contract, status codes and `error` codes are byte-compatible with what `apps/api` returned.
`packages/db`'s schema became `db/`; its client, fencing, transaction and provisioning code was
copied into whichever application uses it.

**`packages/core`, `packages/sdk` and `packages/cli` stay** as the root pnpm workspace
(`packages/*`), the reference implementation and the CLI. They are simply not consumed by the
applications.

## Consequences

### What this buys

- Each application deploys, scales, rolls back and is audited on its own. A web rollback touches
  nothing the indexer writes.
- The SSR hop is gone, and with it `NUXT_API_BASE_URL`, `NUXT_API_INTERNAL_TOKEN`,
  `NUXT_PUBLIC_API_BASE_URL`, the internal-token plugin, the SSR rate-limit middleware and the
  `x-xcs-internal-token` / `x-xcs-client-key` headers. One fewer process, one fewer shared secret,
  one fewer network boundary inside the trust perimeter.
- Each lockfile describes exactly one deployable, so `pnpm audit` and `pnpm licenses list` report on
  what actually ships.
- An image contains only its own application, `db/` and `config/`.
- Removing the production Compose overlay removes its prescribed secret-file bind mounts.
  Hosted secret provisioning now belongs to the deployment operator; local Compose is not a
  production secret-management contract.

### What it costs

- **The copies are maintained by hand.** CI's `ops/ci/check-vendored-copies.mjs` checks parity with
  the reference source, allowing import rewrites and explicitly reviewed divergences pinned to a
  source digest. It detects an unmirrored source change or an unreviewed application-only edit,
  but does not generate the copies or validate deployed behavior. Follow `CONTRIBUTING.md`: land
  protocol changes in the reference source, mirror both applications and run the owning app gates.
- A change made only in an application copy does not update the published library. The parity gate
  and review must accompany independent application builds and tests.
- The same third-party dependency appears in two lockfiles. `drizzle-orm` must stay identical because
  `db/schema/` is compiled by each application against its own copy;
  `ops/ci/check-drizzle-parity.mjs` enforces this in CI.
- **`--ignore-workspace` is mandatory** on every per-app pnpm command that resolves dependencies
  (`install`, `audit`, `licenses list`). Without it pnpm silently operates on the root workspace and
  still exits 0, so a report can look green while covering the wrong lockfile.
- Three separate CI units (packages, web, indexer) with three installs; more wall-clock time.
- The repository no longer ships a production deployment topology. Database provisioning, secret
  storage and a hosted monitoring stack are now the operator's design. `ops/monitoring/` still
  provides the alert rules, dashboard and scrape configuration.
- The two applications are versioned and deployed independently, so a deployment can run mismatched
  revisions. They share only database rows and there is no version negotiation between them; a schema
  change must be rolled out in a compatible order.

### Unchanged

The `/v1` contract, verification semantics, indexer behaviour, database model and every protocol rule
in XCS v0.1. This ADR records a packaging and deployment decision only.
