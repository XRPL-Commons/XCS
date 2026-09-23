# Two standalone apps: web (with the API folded in) and indexer

Date: 2026-09-24
Status: approved design, pending implementation plan
Supersedes: the deployment parts of `2026-09-22-web-nuxt-ui-migration-design.md` (root `Dockerfile`, root `.env.example`, SSR-to-API hop)

## Goal

Reduce the repository to two deployable applications, `apps/web` and `apps/indexer`, each fully
self-contained (own `package.json`, lockfile, tsconfig, `Dockerfile`, `.env.example`, tests and
README), deployable on their own with `gh deploy-setup`'s multi-app support, against a PostgreSQL
instance provisioned outside this repository. The Fastify read and verification API in `apps/api`
becomes Nitro server routes inside the Nuxt app with an identical `/v1` contract.

## Decisions already taken

| Decision                      | Choice                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Number of services            | Two: `apps/indexer` (writer) and `apps/web` (UI + read/verification API)                                                            |
| Database                      | External managed PostgreSQL; Compose keeps Postgres for local development only                                                      |
| Code sharing between apps     | None: no workspace package imports, no shared libraries. Needed protocol/DB code is copied by hand                                  |
| Schema sharing                | Allowed: one `db/` folder with Drizzle table definitions and SQL migrations, imported by path                                       |
| `packages/core`, `sdk`, `cli` | Stay in the root pnpm workspace as the library and CLI; apps do not import them                                                     |
| Compose                       | Local-development stack only (postgres, db-bootstrap, indexer, web); production overlay removed                                     |
| Release images                | Two: `xcs-web`, `xcs-indexer`                                                                                                       |
| Deploy tool                   | Each app carries `.env.example` + `Dockerfile`; `gh deploy-setup` is being refactored so `/apps` means several deployments per repo |

## Repository layout after the change

```
apps/
  web/            Nuxt app. app/ (UI), server/ (Nitro routes: /v1, health, metrics, documentation),
                  app/lib/xcs/ (copies of core + sdk used by browser and server),
                  server/lib/ (copies of db client, fencing types, transactions), server/xcs/ (former
                  apps/api modules), test/, e2e/, Dockerfile, .env.example, package.json, pnpm-lock.yaml
  indexer/        Ingestion service. src/ (unchanged modules), src/lib/xcs/ (copy of core),
                  src/lib/db/ (copies of db client, fencing, transactions, provisioning),
                  test/, Dockerfile, .env.example, package.json, pnpm-lock.yaml
db/               Shared schema, not a library: schema/*.ts (Drizzle tables), migrations/*.sql + meta/,
                  drizzle.config.ts (run by the indexer's drizzle-kit)
packages/
  core, sdk, cli  Unchanged; root pnpm workspace = packages/* only
config/           Network profiles (unchanged)
docker-compose.yml, docker-compose.dev.yml, .env.compose.example   Local development only
```

Removed: `apps/api`, `packages/db`, root `Dockerfile`, root `.env.example`, `docker/Dockerfile.node`,
`docker/node-entrypoint.sh`, `docker-compose.secrets.yml`, `ops/ci/test-node-entrypoint.sh`.

Both Dockerfiles use the repository root as build context so they can copy `db/` and `config/` beside
the app. Nothing under `packages/` is copied into an image.

### Path alias for the shared schema

Each app declares `#db/*` → `../../db/*` in its tsconfig (`paths`) and build tool (Nuxt `alias`,
tsup `esbuildOptions.alias`). Imports look like `import { schemas } from '#db/schema'`. The `db/`
folder has no `package.json`; its third-party imports (`drizzle-orm/pg-core`) resolve from whichever
app compiles it, and both apps pin the same `drizzle-orm` version.

### Vendored copies

| Destination                  | Source                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/lib/xcs/core/` | `packages/core/src/**` (all modules; the web app uses most of the surface)                                                                                                                                 |
| `apps/web/app/lib/xcs/sdk/`  | `packages/sdk/src/**` with imports of `@xcs-protocol/core` rewritten to `../core`                                                                                                                          |
| `apps/web/server/lib/db/`    | `packages/db/src/client.ts`, `indexer-fencing.ts` (types and readers only), `transactions.ts`                                                                                                              |
| `apps/indexer/src/lib/xcs/`  | The `packages/core` modules reachable from `parseNetworkProfile`, `parsePayloadUri`, `computeSchemaUid`, `createIpfsPayloadUri` (schema, schema-uid, payload-uri, json, network, errors and their helpers) |
| `apps/indexer/src/lib/db/`   | `packages/db/src/client.ts`, `indexer-fencing.ts`, `transactions.ts`, `provision.ts`, `bootstrap.ts`, `bin/bootstrap.ts`                                                                                   |

Copies are plain files with a header comment naming their origin and the commit they were copied at.
`CONTRIBUTING.md` states the rule: protocol behaviour changes land in `packages/core` first and are
mirrored by hand into both apps' copies in the same pull request.

## Web app

### Routes

Every route of `apps/api/src/app.ts` becomes a Nitro handler with the same method, path, validation
and JSON shape:

| Path                                                                                            | Nitro file                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`, `GET /health`, `GET /health/ready`                                          | `server/routes/health/live.get.ts`, `index.get.ts`, `ready.get.ts`                                                                 |
| `GET /internal/metrics`, `GET /internal/metrics/prometheus`                                     | `server/routes/internal/metrics/index.get.ts`, `prometheus.get.ts`                                                                 |
| `GET /v1/networks`                                                                              | `server/api/v1/networks/index.get.ts`                                                                                              |
| `GET /v1/networks/:network/{status,readiness,stats,search,activity,schemas}`                    | `server/api/v1/networks/[network]/<name>.get.ts`                                                                                   |
| `GET /v1/networks/:network/schemas/:uid`, `…/:uid/catalog`                                      | `server/api/v1/networks/[network]/schemas/[uid]/index.get.ts`, `catalog.get.ts`                                                    |
| `GET /v1/networks/:network/schema-registrations/:transactionHash`                               | `server/api/v1/networks/[network]/schema-registrations/[transactionHash].get.ts`                                                   |
| `GET /v1/networks/:network/credential-generations/:generationId`                                | `server/api/v1/networks/[network]/credential-generations/[generationId].get.ts`                                                    |
| `GET /v1/networks/:network/transactions/:transactionHash`                                       | `server/api/v1/networks/[network]/transactions/[transactionHash].get.ts`                                                           |
| `GET /v1/networks/:network/credentials/:issuer/:subject/:schemaUid[/events[/:transactionHash]]` | `server/api/v1/networks/[network]/credentials/[issuer]/[subject]/[schemaUid]/{index,events/index,events/[transactionHash]}.get.ts` |
| `POST /v1/verify`                                                                               | `server/api/v1/verify.post.ts`                                                                                                     |
| `POST /v1/pinning/challenges`, `POST /v1/pinning/pins`                                          | `server/api/v1/pinning/challenges.post.ts`, `pins.post.ts` (404 unless demo pinning is enabled)                                    |
| `GET /documentation`, `GET /documentation/openapi.json`                                         | `server/routes/documentation/index.get.ts`, `openapi.json.get.ts`                                                                  |

Validation: the JSON schemas from `http-schemas.ts` are applied by a `validateParams` /
`validateQuery` / `validateBody` helper (Ajv, same options as Fastify used) in each handler; failures
raise `createError({ statusCode: 400, data: { code: 'VALIDATION_ERROR' } })`. One Nitro error handler
(`server/error.ts` via `nitro.errorHandler`) maps `PinningError`, `SchemaProjectionInvalidError`,
`IndexerUnavailableError`, `VerificationNetworkNotFoundError` to their status codes and `code`, and
everything else to 500 `INTERNAL_ERROR`, with the same JSON envelope as today.

### Framework-free modules

Moved unchanged (except import paths) from `apps/api/src/` to `apps/web/server/xcs/`: `config.ts`,
`types.ts`, `repository.ts`, `verification.ts`, `presenters.ts`, `http-schemas.ts`,
`indexer-status.ts`, `ledger-freshness.ts`, `credential-generation-evidence.ts`,
`credential-state.ts`, `schema-catalog.ts`, `schema-projection.ts`, `pagination.ts`,
`serialization.ts`, `operational-metrics.ts`, `operational-metrics-repository.ts`, `pinning.ts`,
`pinning-repository.ts`, `kubo.ts`, `payload-resolver.ts`, `pii-field-filter.ts`,
`internal/network-safety.ts`. Their unit tests move to `apps/web/test/server/`. `app.test.ts` is
replaced by handler tests (`apps/web/test/server/routes.test.ts`) that call the Nitro handlers with
the same fixtures and assert the same responses. `postgres.integration.test.ts` moves to
`apps/web/test/postgres.integration.test.ts` behind `test:postgres`.

### Composition

`server/plugins/00-xcs-api.ts` runs once at startup: `loadApiConfig(process.env)` (unchanged
parser; `XCS_INTERNAL_API_TOKEN` is removed from it), `createDatabaseClient(config.databaseUrl)`,
`PostgresApiRepository`, payload resolver (`SafePayloadResolver` or disabled), `StaticTrustPolicy`,
`OperationalMetricsCollector`, optional `DemoPinningService`. It attaches them to every request as
`event.context.xcs` and closes the client on `close`. In browser e2e mode (below) it attaches the
fixture context instead and never opens a database connection.

### Cross-cutting behaviour

- **CORS** for `/v1/**`: `nuxt-security` `corsHandler` enabled with `origin` = `XCS_ALLOWED_ORIGINS`
  (explicit origins only, `*` rejected as today), methods `GET,POST`, credentials false, scoped by
  `routeRules` to `/v1/**`.
- **Rate limiting**: `nuxt-security` `rateLimiter` on `/v1/**` at 100 tokens per minute per client
  address, client address resolved through `XCS_TRUSTED_PROXY_CIDRS` (the existing
  `resolveSsrClientAddress` logic, reused as the limiter's key function); `/v1/pinning/**` at 10 per
  minute; health, metrics and `/_nuxt/**` exempt. 429 responses are counted by the metrics collector
  through a Nitro hook.
- **Removed**: `NUXT_API_BASE_URL`, `NUXT_API_INTERNAL_TOKEN`, `NUXT_PUBLIC_API_BASE_URL`,
  `NUXT_TRUSTED_PROXY_CIDRS` (replaced by `XCS_TRUSTED_PROXY_CIDRS`), the
  `internal-ssr-rate-limit` middleware, `server/utils/internalSsrRateLimit.ts`,
  `validate-internal-api-token.ts`, the `x-xcs-internal-token` / `x-xcs-client-key` headers.
- **`useXcsApi`**: one `$fetch` base of `/v1` on both server and browser (same origin). The
  Developers page derives the API base from `useRequestURL().origin`.

### OpenAPI

`server/xcs/openapi.ts` builds the OpenAPI 3.1 document from the same JSON schemas and route
metadata that Fastify's swagger plugin consumed (title "XCS reference read API", version from
`package.json`), served at `/documentation/openapi.json`. `/documentation` renders it with
`@scalar/nuxt` if its inline scripts can be nonce-stamped by `nuxt-security`, otherwise with a
minimal server-rendered page listing routes and linking the JSON. The plan verifies this with the
security e2e suite before choosing.

### Browser e2e mode

`XCS_BROWSER_E2E=1` (development only, unchanged guards) makes `00-xcs-api.ts` install the existing
fixture context: the handlers in `server/routes/__e2e-api/**` are moved into
`server/xcs/e2e-fixtures.ts` as plain functions, and a request hook on `/v1/**` answers from them
before the real handlers run. Playwright configs point at the same origin, `NUXT_PUBLIC_PROFILE_ID`
stays `xrpl-testnet-xcs-browser-e2e`. `security.production.spec.ts` keeps proving the fixtures are
inert in a production build (`/v1/networks` must answer 503 `database_unavailable`, not fixture data,
when no database is configured).

### Web contract (`apps/web/.env.example`)

```dotenv
XCS_DATABASE_URL=                          # config
XCS_ALLOWED_ORIGINS=                       # config
XCS_TRUSTED_PROXY_CIDRS=                   # optional config
XCS_READINESS_MAX_LEDGER_AGE_SECONDS=      # optional config
XCS_METRICS_ENABLED=                       # optional config
XCS_METRICS_TOKEN=                         # optional generate
XCS_PAYLOAD_FETCH_ENABLED=                 # optional config
XCS_IPFS_GATEWAY_URL=                      # optional config
XCS_DEMO_PINNING_ENABLED=                  # optional config
XCS_IPFS_API_URL=                          # optional config
XCS_PINNING_IP_HASH_SECRET=                # optional generate
XCS_PINNING_NETWORKS=                      # optional config
XCS_TRUSTED_ISSUERS=                       # optional config
XCS_UNTRUSTED_ISSUERS=                     # optional config
NUXT_PUBLIC_PROFILE_ID=                    # config
NUXT_PUBLIC_RPC_URL=                       # config
NUXT_PUBLIC_XAMAN_API_KEY=                 # optional
NUXT_PUBLIC_XAMAN_REDIRECT_URL=            # optional config
NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=     # optional
```

### Web Dockerfile

`apps/web/Dockerfile`, context repository root, no BuildKit-only syntax: `node:24-alpine` build stage
installs pnpm 10.34.4, copies `apps/web`, `db`, `config`, installs from `apps/web/pnpm-lock.yaml`
(`--frozen-lockfile`), runs `NODE_ENV=production pnpm build`; runtime stage copies
`apps/web/.output` and `config/`, `USER node`, `NITRO_PORT=3000`, `CMD node .output/server/index.mjs`.

## Indexer app

- `apps/indexer/package.json`: standalone (no `workspace:*`), dependencies `drizzle-orm`, `postgres`,
  `xrpl`, dev `drizzle-kit`, `tsup`, `tsx`, `typescript`, `vitest`, `@types/node`; scripts unchanged
  plus `db:generate` (`drizzle-kit generate --config ../../db/drizzle.config.ts`), `db:migrate`
  (`tsx src/lib/db/bin/migrate.ts`, idempotent, journal-based), `db:bootstrap` (`tsx
src/lib/db/bin/bootstrap.ts`: migrate then provision the `xcs_indexer`, `xcs_api`, `xcs_monitor`
  roles with the existing advisory-lock logic), `verify` (`format:check && lint && typecheck && test
&& build`).
- The migrations-committed CI check runs `pnpm --dir apps/indexer db:generate` and asserts no diff
  under `db/migrations`.
- `apps/indexer/Dockerfile`, context repository root: build stage copies `apps/indexer`, `db`,
  `config`, installs from `apps/indexer/pnpm-lock.yaml`, `pnpm build`; runtime stage copies `dist`,
  production `node_modules` (installed with `--prod` in the runtime stage from the same lockfile),
  `db/migrations` and `config/`, `USER node`, `CMD node dist/main.js`. The same image runs
  `db:bootstrap` in Compose (`node dist/lib/db/bin/bootstrap.js`).
- Contract (`apps/indexer/.env.example`):

```dotenv
XCS_NETWORK_PROFILE=                       # config
XCS_INDEXER_DATABASE_URL=                  # config
XCS_RPC_URL_PRIMARY=                       # held
XCS_RPC_URL_SECONDARY=                     # held
XCS_REGISTRY_POLICY=                       # optional config
XCS_CONTROLLED_PILOT_ACK=                  # optional config
XCS_DATABASE_SCOPE=                        # optional config
XCS_INDEXER_POLL_INTERVAL_MS=              # optional config
XCS_INDEXER_LEASE_DURATION_MS=             # optional config
XCS_INDEXER_BATCH_SIZE=                    # optional config
XCS_BOOTSTRAP_DATABASE_URL=                # optional held
XCS_INDEXER_DATABASE_PASSWORD=             # optional generate
XCS_API_DATABASE_PASSWORD=                 # optional generate
XCS_MONITOR_DATABASE_PASSWORD=             # optional generate
```

The last four are used only by `db:bootstrap`, run once from an operator machine or a one-off job
against the external database; the long-running service reads only the first ten.

## Compose, CI, release

- `docker-compose.yml`: services `postgres`, `db-bootstrap` (indexer image, `node
dist/lib/db/bin/bootstrap.js`), `indexer`, `web` (built from `apps/<name>/Dockerfile` with context
  `.`); profiles `monitoring` (Prometheus scrapes `web:3000/internal/metrics/prometheus`; Grafana and
  exporters unchanged) and `demo-pinning` (Kubo) kept. Hardening (read-only, cap_drop, limits, log
  limits) kept. The secrets overlay and every `*_FILE` variable are removed; local values live in
  `.env` copied from `.env.compose.example`, which shrinks to the variables the four services and
  the profiles use. `docker-compose.dev.yml` keeps its published-port overrides.
- `.github/workflows/ci.yml`: jobs `packages` (root `pnpm install --frozen-lockfile`, `pnpm verify`
  scoped to `packages/*`), `web` (install in `apps/web`, `pnpm verify`, Playwright suites), `indexer`
  (install in `apps/indexer`, `pnpm verify`, `test:postgres` against the Postgres service,
  migrations-committed check). `operations.yml` builds both images and smoke-tests the Compose stack
  (`db-bootstrap` completes, `indexer` and `web` healthy, `web` answers `/health/live`).
  `security.yml` audits and license-checks each of the three lockfiles.
- `release-artifacts.yml`: images `xcs-web` and `xcs-indexer` from the app Dockerfiles with the
  existing Trivy, SBOM, cosign and provenance steps; the `xcs-db` image and its steps are removed.
- Root `package.json`: `verify` = `prettier --check .` then `turbo run verify` over `packages/*`
  then `pnpm --dir apps/web verify && pnpm --dir apps/indexer verify`; `test:e2e` and
  `test:postgres` delegate to the apps. `pnpm-workspace.yaml` lists `packages/*` only. Root
  `pnpm.overrides` for js-yaml and svgo are mirrored in each app's `package.json`.

## Documentation

- `README.md`: package list (web, indexer, db/, core, sdk, cli), data flow (API served by the web
  app), development section (per-app install/dev commands).
- `docs/architecture.md`: ownership section rewritten for two apps and the shared `db/` folder.
- `docs/database.md`: migrations live in `db/migrations`, tooling in the indexer.
- `docs/TESTING.md`, `docs/runbooks/deployment.md` (App Platform for both apps, external database
  bootstrap, Compose for local development), `docs/runbooks/indexer.md`, `docs/runbooks/monitoring.md`,
  `docs/known-limitations.md`, `CONTRIBUTING.md` (mirroring rule), `apps/web/README.md` (API section),
  new `apps/indexer/README.md`.
- `docs/adr/0004-two-standalone-apps.md`: records the two-service model, no shared code between
  apps, shared schema folder, external database, and the retirement of `apps/api` and `packages/db`.
- Issues #26 and #28 are closed by the pull request; #24's checklist is updated.

## Out of scope

- Any change to the `/v1` contract, verification semantics, indexer behaviour or protocol rules.
- Role-based features (#24 and its children).
- Publishing `packages/*` to npm.
- Changes to `gh deploy-setup` itself.

## Acceptance

- `pnpm verify` at the root passes; `pnpm --dir apps/web verify` and `pnpm --dir apps/indexer verify`
  pass when run in fresh clones of only their folders plus `db/` and `config/`.
- `pnpm --dir apps/web test:e2e` (pilot, developers, wallet menu, security dev and production) passes.
- `pnpm --dir apps/indexer test:postgres` and `pnpm --dir apps/web test:postgres` pass against
  PostgreSQL 18 after `db:bootstrap`.
- Both images build with the repository root as context and start under `node`; the Compose stack
  reaches `web` healthy with `indexer` running against the local Postgres.
- The CLI's `xcs verify --api https://<web origin>` works against the Nuxt-served `/v1/verify`.
- `grep -r "@xcs-protocol/" apps/` finds only package names in the two apps' own manifests and
  quickstart strings, never an import.
