# Deploying XCS

XCS deploys as **two independent applications** against a PostgreSQL instance provisioned outside
this repository:

| Application    | What it is                                                                                             | Contract                    | Image                     |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------- |
| `apps/indexer` | Validated-ledger ingestion worker. No HTTP surface. Owns database tooling.                             | `apps/indexer/.env.example` | `apps/indexer/Dockerfile` |
| `apps/web`     | Nuxt UI **and** the `/v1` read/verification API, health, metrics, `/documentation`, all on one origin. | `apps/web/.env.example`     | `apps/web/Dockerfile`     |

Each is deployed on its own, from its own directory, with its own lockfile and its own environment
contract. There is no shared runtime component and no service-to-service call between them: they
communicate only through PostgreSQL rows. See [ADR 0004](../adr/0004-two-standalone-apps.md).

Both Dockerfiles use the **repository root** as build context, because each image also needs `db/`
(migrations and schema) and `config/` (network profiles) beside the application. Nothing under
`packages/` is copied into either image.

## What Compose is, and is not

`docker-compose.yml`, `docker-compose.dev.yml` and `.env.compose.example` are a **local-development
stack only**. They exist so a developer can bring up PostgreSQL, apply the migrations, and run both
applications against them on one machine.

They are **not** a deployment template:

- there is no secret-file overlay; every value is plain `.env` configuration;
- the PostgreSQL container is disposable local state, not a managed database;
- every published port binds to `127.0.0.1` and no port is meant to be exposed.

Never run this Compose stack on a public host. A deployment runs the two images directly, against an
external database, with the variables named in the two `.env.example` contracts.

```sh
cp .env.compose.example .env
docker compose config --quiet
docker compose up --build
```

Profiles are additive: the default stack is `postgres`, `db-bootstrap`, `indexer` and `web`;
`monitoring` adds Prometheus, Grafana and both exporters; `demo-pinning` adds Kubo.

```sh
docker compose --profile monitoring config --quiet
docker compose --profile monitoring --profile demo-pinning config --quiet
```

`docker-compose.dev.yml` is an explicit loopback-only port override for inspecting PostgreSQL,
Prometheus, Grafana or the IPFS gateway during development:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile monitoring up --build
```

## Preparing the network profile

The repository contains no live network profile. `config/networks/testnet.example.json` is a
placeholder with an invalid registry and activation boundary, and the indexer refuses it: preflight
and startup stop with `SOURCE_REGISTRY_NOT_BLACKHOLED`. **This is by design.** The indexer cannot
reach a steady state until an operator supplies a profile naming a genuinely blackholed registry
account, whose blackhole ceremony has been completed and independently audited as described in
`config/networks/README.md`.

Save a normal audited result as `config/networks/testnet.json` and point `XCS_NETWORK_PROFILE` at it.
Do not edit a profile after indexing starts: a Testnet reset or a changed profile field requires a
new profile ID and a new database history. Set `XCS_DATABASE_SCOPE=exclusive-profile` so one database
cannot silently mix profiles.

### Commons private controlled pilot

[`ADR 0003`](../adr/0003-disposable-controlled-testnet-registry.md) permits one disposable controlled
registry for private staging before the irreversible public-beta ceremony. This is a deployment
exception, not a change to XCS v0.1 and not a weaker default. The only permitted profile ID is
`commons-testnet-xcs-v0.1-controlled-pilot` on Testnet network ID `1`.

Create `config/networks/commons-testnet-xcs-v0.1-controlled-pilot.json` from the example only after
the dedicated registry address and activation ledger index/hash are known. Keep
`registrationAmountDrops` at `"1"` and use the existing v0.1 Credentials amendment ID. The controlled
account may retain master, regular-key, signer-list or delegate authority, but `DepositAuth` and
`RequireDestTag` must remain disabled so it can receive registration Payments — otherwise preflight
fails with `SOURCE_REGISTRY_NOT_RECEIVABLE`.

The indexer then requires both exact values:

```dotenv
XCS_REGISTRY_POLICY=controlled-testnet-pilot
XCS_CONTROLLED_PILOT_ACK=DISPOSABLE_PROFILE_AND_DATABASE
```

and the web app serves it with `NUXT_PUBLIC_PROFILE_ID=commons-testnet-xcs-v0.1-controlled-pilot`.

This registry, profile and database cannot be promoted. Before public beta, create a different
registry, complete and independently audit the normal blackhole ceremony, publish a new profile ID
and activation boundary, and start another fresh database. Keep the controlled pilot artifacts only
as explicitly labelled staging evidence.

## Preparing the external database

PostgreSQL 18 is provisioned outside this repository — a managed instance or an operator-run cluster.
Nothing here creates the server.

The indexer owns every database command. `--ignore-workspace` is mandatory on any per-app pnpm
command that resolves dependencies (`install`, `audit`, `licenses list`); commands that only run a
script do not need it.

```sh
pnpm --dir apps/indexer install --ignore-workspace --frozen-lockfile
```

### Bootstrap once, on a fresh database

```sh
XCS_BOOTSTRAP_DATABASE_URL=postgres://xcs_admin:…@db.example:5432/xcs \
  XCS_DATABASE_CLUSTER_SCOPE=dedicated \
  XCS_INDEXER_DATABASE_PASSWORD=… \
  XCS_API_DATABASE_PASSWORD=… \
  XCS_MONITOR_DATABASE_PASSWORD=… \
  pnpm --dir apps/indexer db:bootstrap
```

Run it from an operator machine, or as a one-off job using the indexer image
(`node dist/lib/db/bin/bootstrap.js`), which is exactly what Compose's `db-bootstrap` service does
locally.

Bootstrap applies the committed migrations and then provisions the fixed runtime roles in one
administrative transaction. It is idempotent: a second run reapplies the same role attributes,
passwords and grants, which is also how a runtime password is rotated. Give the four identities
distinct, long, URL-safe passwords.

| Identity      | Use                                       | Database rights                                                                                                                                                                                                      |
| ------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcs_admin`   | One-shot bootstrap and migrations         | Schema/DDL and role administration; never given to a long-running service                                                                                                                                            |
| `xcs_indexer` | Indexer service and maintenance replay    | `SELECT`/`INSERT` on `network_profiles`, `ledger_checkpoints`, `schema_events`, `schemas`, `credential_events`, and `indexer_incidents`; `SELECT`/`INSERT`/`UPDATE` on `indexer_status` and `credential_generations` |
| `xcs_api`     | Web app (`/v1`) and optional demo pinning | `SELECT` on projections; CRUD on `pin_challenges` and `demo_pins` only                                                                                                                                               |
| `xcs_monitor` | PostgreSQL exporter                       | `pg_monitor`; no DML rights on XCS application tables                                                                                                                                                                |

`XCS_DATABASE_CLUSTER_SCOPE=dedicated` is mandatory: PostgreSQL login roles are cluster-wide, so
bootstrap must only ever run on a cluster dedicated to XCS. Grants and `PUBLIC` revocations are
scoped to the database named by `XCS_BOOTSTRAP_DATABASE_URL`. All runtime roles are denied schema
creation and `CREATE` on `public` is revoked from `PUBLIC`. The single-replica alpha caps connections
at 12 for `xcs_indexer`, 12 for `xcs_api` and 3 for `xcs_monitor`, leaving capacity for
administration and recovery; raise them deliberately before scaling replicas or pool sizes.

Bootstrap overrides any caller-supplied `password_encryption` with transaction-local
`scram-sha-256`, writes all three runtime passwords, and restores `LOGIN` only after every grant
succeeds. Configure the matching `pg_hba.conf` entries with `scram-sha-256` as well, and restrict
each runtime role to the XCS database: verifier storage does not replace an authentication policy.
Bootstrap reports role names or a stable failure code, never URLs or password values.

Treat the PostgreSQL administrator and reviewed migrations as trusted administrative inputs.
Bootstrap is not an anti-administrator attestation: it does not audit ownership or ACLs outside the
selected database, which is why the dedicated-cluster requirement is part of the security boundary.

Bootstrap also resets operational role defaults: `xcs_indexer` receives a 5-minute statement timeout
and 30-second lock and idle-in-transaction timeouts; `xcs_api` receives 30-second statement/idle and
15-second lock timeouts; `xcs_monitor` receives 30-second statement/idle and 10-second lock timeouts.
These PostgreSQL settings are `USERSET`, so a client holding the runtime secret can override them;
they are not security ceilings. Keep independently enforced connection/query/resource quotas. The
residual denial-of-service boundary, including SQL `LISTEN`/`NOTIFY`, is documented in
[`threat-model.md`](../threat-model.md).

### Migrate on every later schema change

```sh
XCS_BOOTSTRAP_DATABASE_URL=postgres://xcs_admin:…@db.example:5432/xcs \
  pnpm --dir apps/indexer db:migrate
```

This is idempotent and does not touch roles. Before production, an incompatible schema change means
recreating and replaying the projection database rather than upgrading it; after the migration
history freezes at production launch, every change is a reviewed forward migration with an explicit
compatibility, lock, backup and rollback plan. Never edit an applied migration.

### Replacing the legacy `XRPL-Commons/xcs` MVP

The committed migrations are the complete current schema for this indexer's projection. They are
**not** an in-place upgrade from the former root-level Nuxt/Drizzle MVP: both schemas define
`public.schemas` with incompatible keys and columns, and the legacy application also owns a different
`credentials` table. Never bootstrap against a database previously used by that application.

1. Stop writes to the legacy application and take a verified `pg_dump` backup.
2. Keep that database untouched for rollback.
3. Bootstrap this implementation against a new, empty database.
4. Rebuild the on-chain projection from the audited XCS activation boundary with the indexer.
5. Treat any legacy off-chain credential export as a separate, reviewed data-migration project. This
   repository does not provide or claim a compatible backfill.

Rollback means restoring the former application against its untouched legacy database; do not point
an older application at the new projection schema.

## Deploying each application

Deployment is per application. `gh deploy-setup` is run **from that application's own directory**,
where it finds that application's `Dockerfile` and reads that application's `.env.example` as the
environment contract (names only; values live in the deployment's secret store). Each contract marks
every variable with `# config`, `# optional`, `# generate` or `# held`.

```sh
cd apps/indexer && gh deploy-setup     # worker, no HTTP port
cd apps/web && gh deploy-setup         # HTTP service, port 3000
```

Both build with the **repository root** as build context. The web service listens on `3000` and
serves the UI, `/v1`, `/health/*`, `/internal/metrics*` and `/documentation` from that one port. The
indexer exposes nothing.

### Indexer configuration

The long-running worker reads only the first ten variables of `apps/indexer/.env.example`; the last
five are read by `db:bootstrap` alone and must not be given to the service.

- `XCS_INDEXER_DATABASE_URL` authenticates as the least-privilege `xcs_indexer` role. Never give the
  service the admin URL.
- `XCS_RPC_URL_PRIMARY` and `XCS_RPC_URL_SECONDARY` are complete WSS URLs from **independently
  operated, complete-history** `rippled` providers. They are marked `# held`: a provider credential
  can live in a URL path or query, so they belong in the deployment's secret store and must never be
  logged. Distinct URLs alone are not evidence of independent operation; record the two operators in
  the deployment review. Plain `ws://` is accepted only on loopback for local development. Clio is
  not a supported source.
- Keep `XCS_INDEXER_LEASE_DURATION_MS` between 10 seconds and 5 minutes, and at least three times the
  polling interval.
- Run the preflight before enabling the service:

  ```sh
  pnpm --dir apps/indexer preflight
  ```

  It checks network ID, contiguous retained history, the amendment, the activation ledger and the
  selected registry policy on both sources, and prints no endpoint or credential.

### Web app configuration

- `XCS_DATABASE_URL` authenticates as the read-only `xcs_api` role.
- `XCS_ALLOWED_ORIGINS` lists the browser origins allowed on `/v1/**`. `*` is rejected. Because the
  UI and the API share one origin, this is only needed for third-party API consumers.
- `XCS_TRUSTED_PROXY_CIDRS` is the ingress proxy's exact, narrow IP/CIDR. Configure the proxy to
  discard incoming forwarding headers and write its own canonical client address. Leave it empty for
  direct exposure; never use a wildcard or a catch-all `/0`. An undeclared proxy is safe but
  collapses its visitors into one shared rate-limit budget.
- `XCS_READINESS_MAX_LEDGER_AGE_SECONDS` (default 120) governs readiness and every authoritative
  ledger-derived route. Stale, inconsistent or implausibly future evidence returns `503`.
- `NUXT_PUBLIC_PROFILE_ID` is the profile this deployment serves.
- `NUXT_PUBLIC_RPC_URL` is browser-visible and is used for wallet submission only. It must be a
  genuinely public endpoint with no embedded credentials — never a private indexer source. The
  server rejects userinfo and non-TLS public endpoints at startup (`ws://` is loopback-only), but it
  cannot tell whether an opaque path or query parameter is a provider secret.
- `NUXT_PUBLIC_XAMAN_API_KEY` and
  `NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` are optional public application identifiers, visible in
  browser JavaScript. Register the exact redirect URL — this deployment's HTTPS origin with a
  trailing slash — in the Xaman Developer Console; each self-hosted origin needs its own Xaman
  application. Omitting an identifier removes only that adapter and leaves the six self-configuring
  XRPL Connect adapters registered.
- `XCS_METRICS_ENABLED` / `XCS_METRICS_TOKEN` gate the operational snapshot; see
  [`monitoring.md`](./monitoring.md).

For both the private controlled pilot and the Commons-hosted Testnet beta, also enforce the product
boundary from [`ADR 0002`](../adr/0002-public-product-and-discovery.md):

- leave `XCS_TRUSTED_ISSUERS` and `XCS_UNTRUSTED_ISSUERS` empty so Commons publishes no trust badge
  or issuer allowlist decision;
- keep `XCS_PAYLOAD_FETCH_ENABLED=false`; the browser retrieves issuer-hosted HTTPS payloads only
  after consent and sends parsed content for validation without server-side resolution;
- keep `XCS_DEMO_PINNING_ENABLED=false`; the issuer, not Commons, operates the public HTTPS payload
  host;
- do not add a subject feed, account-wide Credential export or claims ingestion to the deployment.

### Deployment order

1. Bootstrap the external database (above).
2. Run `pnpm --dir apps/indexer preflight` against the audited profile and both sources.
3. Deploy the indexer and let it reach `ready`.
4. Deploy the web app. Its `/health/live` succeeds immediately; `/health/ready` stays `503` until the
   indexer owns a live lease and its status exactly matches a transaction-root-bearing checkpoint at
   the effective tip.

Use `/health/live` for the platform's container health check. Do **not** use `/health/ready` for it:
a normal catch-up must not restart the web service. `/health`, `/health/live` and `/health/ready` all
emit `Cache-Control: no-store` and bypass the application rate limiter; restrict them at the ingress
to the load balancer and monitoring network so public traffic cannot turn the database-backed
readiness check into an unbounded read path. Preserve both their status codes and cache policy; never
synthesize a cached `200` for a `503` readiness response.

OpenAPI documentation is served at `/documentation`, and the document itself at
`/documentation/openapi.json`.

## Verifying a web deployment

### Operational metrics

When enabled, scrape the snapshot with its dedicated bearer token:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${XCS_METRICS_TOKEN}" \
  https://xcs.example/internal/metrics
```

The snapshot is JSON schema version 1, carries `Cache-Control: no-store`, and never consumes the
public rate-limit budget. Alert on `/health/ready` separately: the metrics route intentionally stays
`200` during a database outage so process-local counters remain observable. Do not interpret
`logicalSizeBytes` as free disk or `clusterConnections` as pool saturation — obtain physical volume
capacity and process saturation from the deployment's monitoring layer. Scrape every 30–60 seconds
rather than continuously: registration totals are derived from the rebuildable event projection and
become more expensive as history grows. Alert separately on `database.errorCode`:
`DATABASE_UNAVAILABLE` means the snapshot query failed, while `METRICS_EVIDENCE_INVALID` means
PostgreSQL answered but the stored evidence was partial, malformed or out of bounds.

### Browser security-header rollout

Nitro is the source of truth for the web application's browser security headers. The initial
deployment emits the CSP as `Content-Security-Policy-Report-Only`; it must not emit an enforced
`Content-Security-Policy` until every enabled XRPL Connect adapter has passed the real browser matrix
below. Report-only violations are diagnostic and do not block script execution, wallet communication
or payload requests. WalletConnect modal styles and images are part of that qualification and must
not be allowlisted speculatively.

The `Permissions-Policy` must retain `hid=(self)` and `usb=(self)` for the user-initiated Ledger path
while denying those capabilities to cross-origin documents. Removing either directive can break
hardware-wallet access; broadening it beyond `self` expands the device trust boundary.

The TLS response also emits `Strict-Transport-Security` for the current host without
`includeSubDomains` or `preload`. Do not add either directive until every affected organizational
subdomain is inventoried and a separate rollout and recovery decision has been reviewed.

The ingress or CDN must not append a second CSP to Nitro's response. Configure it to overwrite any
inherited security-policy value with the reviewed XCS value, or to pass Nitro's value through
unchanged, so the browser receives exactly one report-only policy during observation and exactly one
enforced policy after promotion. Multiple CSP fields are all applied by browsers and can intersect
into an untested, unexpectedly restrictive policy. Apply the same single-value rule to HSTS.

Nitro marks every rendered HTML response, including error documents, as `Cache-Control: private,
no-store`. Configure the ingress and CDN to bypass their HTML cache and preserve this value: caching
would reuse a response-bound nonce across clients. Fingerprinted `/_nuxt/` assets must retain their
`public, max-age=31536000, immutable` policy.

The policy intentionally permits `https:` in `connect-src`. Credential payload hosts are selected
permissionlessly by issuers and cannot be enumerated in a Commons deployment allowlist without
changing the product model. This directive does not trigger a fetch: the application must still
display the exact host, obtain consent, re-read the exact generation, and validate the
integrity-bound response. Keep the separately configured public XRPL WebSocket origin permitted for
wallet submission.

Do not configure `report-uri`, `report-to`, `Reporting-Endpoints` or a third-party CSP reporting
service during this rollout. Violation reports can disclose exact Credential URLs, issuer hosts and
browsing context. Operators inspect violations locally in browser DevTools; adding collection,
retention or forwarding requires a separate privacy and threat-model review.

For every candidate web image, first confirm the headers on the public HTTPS origin and on a
representative localized route:

```sh
curl --fail --silent --show-error --dump-header - --output /dev/null https://xcs.example/
curl --fail --silent --show-error --dump-header - --output /dev/null https://xcs.example/studio
```

Verify in the output that there is exactly one `Content-Security-Policy-Report-Only`, no
`Content-Security-Policy`, and one `Strict-Transport-Security` value without `includeSubDomains` or
`preload`. Both HTML responses must also contain `Cache-Control: private, no-store`; a sampled
fingerprinted `/_nuxt/` asset must remain `public, max-age=31536000, immutable`. Then use a clean
Chromium profile with DevTools open:

1. Load Explorer, Studio, Developers and an exact Credential permalink; record every CSP violation
   from the Console and the document's response headers from the Network panel.
2. For each configured adapter—Xaman, Crossmark, GemWallet, WalletConnect, Ledger, Xyra, Otsu and
   MetaMask Snap—exercise connect, cancellation, schema registration, `CredentialCreate`,
   `CredentialAccept` and `CredentialDelete` without relaxing the policy. Record unavailable adapters
   as untested rather than successful.
3. For WalletConnect, record the candidate wallet and prove that its session advertises the XRPL
   Testnet namespace and supports the native `Credential*` payloads; a successful QR/deep-link
   pairing alone is not compatibility evidence. Exercise Ledger on the intended physical device and
   browser rather than treating the Permissions Policy header as device evidence.
4. After explicit payload-host consent, load an issuer-hosted HTTPS payload with CORS and confirm
   that its integrity verification succeeds. Confirm that no payload request occurs before consent.

Classify and fix every application-owned violation. Record the browser, adapter, wallet
application/extension or hardware device, web image and policy versions with the evidence.
Wallet-origin messages that cannot be attributed or reproduced are not a reason to add a broad source
expression.

Only after every enabled real-wallet matrix passes may the reviewed deployment replace the single
`Content-Security-Policy-Report-Only` field with the same policy under `Content-Security-Policy`.
Re-run both `curl` checks and the DevTools matrix against the enforced candidate before promotion.
Roll back to the prior image, which restores report-only mode, if a wallet or consented payload flow
regresses; do not work around an incident by appending a second or weaker policy at the edge.

If one adapter regresses before promotion, remove its public identifier where applicable or restrict
the XRPL Connect factory in a reviewed web rollback. This changes no XCS protocol rule or database
schema and requires no database rollback. Never route around an adapter failure by calling
`signAndSubmit`: XCS must retain normalization, persistence and sole submission control.

## Optional Testnet demo pinning

Pinning is disabled by default. It is only intended for public, non-sensitive Testnet examples. To
enable it on the web app, set all of the following:

```dotenv
XCS_DEMO_PINNING_ENABLED=true
XCS_PINNING_NETWORKS=<exact-profile-id>
XCS_PINNING_IP_HASH_SECRET=<at-least-32-random-bytes>
XCS_IPFS_API_URL=<kubo-rpc-endpoint>
```

Locally, the `demo-pinning` Compose profile provides an isolated Kubo node:

```sh
docker compose --profile demo-pinning up --build
```

If server-side verification should read from that node, also set `XCS_PAYLOAD_FETCH_ENABLED=true` and
point `XCS_IPFS_GATEWAY_URL` at it. The wallet challenge, per-wallet/IP quotas, 64 KiB demo limit,
90-day retention and cleanup job reduce abuse; they cannot detect all personal data. Never pin PII,
secrets or production credentials.

## Operations and rollback

- Back up PostgreSQL and the exact network profile together. Kubo blocks are reconstructable only
  while their source payload still exists.
- Monitor checkpoint age, rejected registrations, ledger continuity failures, pin-store failures and
  disk usage. Signal definitions, SLO/RTO/RPO semantics and the recovery drill are in
  [`monitoring.md`](./monitoring.md).
- The two applications roll back independently. A web rollback is always safe: the web app never
  writes protocol projections. Roll either back only to a version compatible with the applied
  migrations.
- Before production, an incompatible schema change means rebuilding and replaying the database; never
  skip a ledger.
- Rerun `db:bootstrap` after a runtime-password rotation, then restart the affected application with
  the matching credentials. Keep `xcs_admin` credentials out of runtime services and logs.
- Retain a `pg_hba.conf` role-to-database allowlist as defense in depth.
- Record the deployed revision of each application separately: they are versioned and deployed
  independently, and a protocol change mirrored into only one of them is a real failure mode (see
  [`CONTRIBUTING.md`](../../CONTRIBUTING.md)).

## Optional authenticated workspaces and hosted payloads

The same web app can enable auth, admin review and issuer workflows through its per-app environment
contract. Apply migrations 0000–0006 first, then provision the optional `xcs_app`, `xcs_admin_app`,
`xcs_notifier`, and `xcs_issuer` roles with their explicit bootstrap passwords. The API uses
`xcs_api`; hosted publication uses a separate `xcs_payload_writer` connection. Never grant any of
these roles to another runtime role. Omitting optional passwords on bootstrap disables those roles.

The optional notification worker runs `node dist/admin/admin-notifier.js` from the web image.
It is a separate process of that application with its own restricted connection, not an additional
application package. It requires no XRPL signing keys. Mount persistent private document storage
writable by UID1000 when enabling uploads. Database backups can contain private claims; they require
the same access protection as live application data.

For local use only, add `docker-compose.application.yml` for auth/admin/issuer/Mailpit, and/or
`docker-compose.hosted-payloads.yml` for public hosted publication. Supply variables through a private
local environment file. Mailpit is a synthetic test destination, not a qualified external provider.
Live Identity registration, wallet consent and managed-database rollout remain operator release checks.

See [authentication](authentication.md), [admin](admin.md) and [issuer](issuer.md) for authorization,
review, invitation, notification and recovery semantics.
