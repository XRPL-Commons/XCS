# Self-hosted Testnet deployment

The Compose stack is an alpha deployment template. It binds every published port to loopback by
default and refuses to index with the placeholder network profile.

A hosted deployment requires Docker Compose `2.24.4` or newer because the production overlay uses
`!reset` to remove direct secret values before mounting files. All unqualified `docker compose`
commands in this runbook assume this production context:

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.secrets.yml
export COMPOSE_PROJECT_NAME=xcs-controlled-pilot
docker compose version
```

Do not omit `docker-compose.secrets.yml` on a hosted deployment. The base file alone is convenient
for local development but places its configured values directly in container environment metadata.

## Required preparation

### Commons private controlled pilot

[`ADR 0003`](../adr/0003-disposable-controlled-testnet-registry.md) permits one disposable
controlled registry for private staging before the irreversible public-beta ceremony. This is a
deployment exception, not a change to XCS v0.1 and not a weaker default. The only permitted profile
ID is `commons-testnet-xcs-v0.1-controlled-pilot` on Testnet network ID `1`.

Create `config/networks/commons-testnet-xcs-v0.1-controlled-pilot.json` from the example only after
the dedicated registry address and activation ledger index/hash are known. Keep
`registrationAmountDrops` at `"1"` and use the existing v0.1 Credentials amendment ID. The
controlled account may retain master, regular-key, signer-list or delegate authority, but
`DepositAuth` and `RequireDestTag` must remain disabled so it can receive registration Payments.

Set the following exact non-secret values in the pilot `.env`:

```dotenv
XCS_NETWORK_PROFILE=/workspace/config/networks/commons-testnet-xcs-v0.1-controlled-pilot.json
XCS_PUBLIC_PROFILE_ID=commons-testnet-xcs-v0.1-controlled-pilot
XCS_REGISTRY_POLICY=controlled-testnet-pilot
XCS_CONTROLLED_PILOT_ACK=DISPOSABLE_PROFILE_AND_DATABASE
XCS_DATABASE_SCOPE=exclusive-profile
XCS_DATABASE_CLUSTER_SCOPE=dedicated
XCS_PUBLIC_RPC_URL=wss://testnet.xrpl-labs.com/
```

To enable the two adapters that require public application registration, optionally add:

```dotenv
XCS_PUBLIC_XAMAN_API_KEY=public-xaman-application-id
XCS_PUBLIC_WALLET_CONNECT_PROJECT_ID=public-reown-project-id
```

Compose exposes these as `NUXT_PUBLIC_XAMAN_API_KEY` and
`NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`. They are intentionally visible in browser JavaScript and
must contain public identifiers only, never signing keys, relay secrets or private RPC credentials.
Omitting them leaves the other six XRPL Connect adapters registered.

Put the Commons primary WSS URL in the ignored file selected by `XCS_RPC_URL_PRIMARY_FILE`, supplying
it out of band without logging or embedding its credentials. Put
`wss://s.altnet.rippletest.net:51233` in `XCS_RPC_URL_SECONDARY_FILE`. Direct
`XCS_RPC_URL_PRIMARY`/`XCS_RPC_URL_SECONDARY` values are local-development alternatives and are
removed by the hosted secret overlay.

Ripple's secondary endpoint and XRPL Labs' browser endpoint are public Testnet conveniences listed
by the [XRPL public-server documentation](https://xrpl.org/docs/tutorials/public-servers). Neither
has an availability, history-retention or support SLA for XCS. The secondary must still prove
contiguous history from activation and agree exactly with the Commons primary. The XRPL Labs
endpoint is used only for browser submission and never for authoritative verification.

Run the first pilot deployment under a dedicated Compose project only after confirming its named
PostgreSQL volume is new. Never delete an unfamiliar or legacy volume to make this check pass:

```sh
docker volume inspect xcs-controlled-pilot_xcs-postgres
docker compose config --quiet
docker compose --profile site up --build
```

The initial `docker volume inspect` is expected to report that the volume does not exist. If it
already exists, identify and preserve its owner and data instead of reusing it. Private ingress
must restrict the pilot to named participants using disposable Testnet accounts and non-sensitive
payloads.

This registry, profile and database cannot be promoted. Before public beta, create a different
registry, complete and independently audit the normal blackhole ceremony, publish a new profile ID
and activation boundary, and start another fresh PostgreSQL database. Keep the controlled pilot
artifacts only as explicitly labelled staging evidence.

### Replacing the legacy `XRPL-Commons/xcs` MVP

The generated `packages/db/drizzle/0000_baseline.sql` is the complete current schema for the new XCS
indexer projection. It is **not** an in-place upgrade from the former root-level Nuxt/Drizzle MVP:
both schemas define `public.schemas` with incompatible keys and columns, and the legacy application
also owns a different `credentials` table. Never run the bootstrap against a PostgreSQL database
or Compose volume previously used by that application.

For a replacement deployment:

1. Stop writes to the legacy application and take a verified `pg_dump` backup of its database.
2. Keep that database and its volume untouched for rollback.
3. Deploy this implementation against a new, empty PostgreSQL database or volume.
4. Rebuild the on-chain projection from the audited XCS activation boundary with the indexer.
5. Treat any legacy off-chain credential export as a separate, reviewed data-migration project. This
   repository does not provide or claim a compatible backfill.

Rollback means restoring the former application against its untouched legacy database; do not point
an older application at the new projection schema.

### PostgreSQL 18 volume layout and recovery

The PostgreSQL 18 image keeps `PGDATA` in a versioned directory below `/var/lib/postgresql`. The
named Compose volume must therefore be mounted at `/var/lib/postgresql`, not at the pre-18 path
`/var/lib/postgresql/data`. With the old child mount, the live cluster may be stored in a separate
anonymous parent volume while the named volume is unused. Changing the mount without first locating
and backing up that cluster can make intact data appear to have disappeared.

Before recreating a PostgreSQL 18 container that ever used the old mount:

1. Stop application writes and record both the active data directory and mount destinations. The
   formatted inspection command prints mount names and paths only; it does not print container
   environment variables.

   ```sh
   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW data_directory"'
   docker inspect --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}' "$(docker compose ps -q postgres)"
   ```

2. While the old container still runs, make and inspect a logical, data-only backup on the host.

   ```sh
   docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --data-only --no-owner --no-privileges' > xcs-before-pg18-volume.dump
   docker compose exec -T postgres pg_restore --list < xcs-before-pg18-volume.dump
   ```

3. Stop the stack. Do not run `docker compose down -v`, `docker volume rm`, or
   `docker volume prune`; keep every named and anonymous volume until restoration has been verified.

   ```sh
   docker compose stop web api indexer postgres
   ```

4. With the corrected parent mount, initialize PostgreSQL, apply the same XCS baseline, restore the
   data with the admin identity, then rerun bootstrap to restore runtime grants.

   ```sh
   docker compose up -d --wait postgres
   docker compose run --rm db-bootstrap
   docker compose exec -T postgres sh -c 'pg_restore --exit-on-error --single-transaction --data-only --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < xcs-before-pg18-volume.dump
   docker compose run --rm db-bootstrap
   ```

This logical restore procedure is only for the same XCS schema. It is not a migration from the
legacy MVP described above, and a raw PostgreSQL data directory must never be copied across major
versions. For projection-only data, a bounded ledger replay is an alternative; preserve optional
pinning rows separately because they are not reconstructable from XRPL.

### PostgreSQL identities and bootstrap

The reference deployment separates schema ownership from runtime access:

| Identity      | Use                                   | Database rights                                                                                                                                                                                                      |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcs_admin`   | One-shot database bootstrap           | Schema/DDL and role administration; never used by a runtime service                                                                                                                                                  |
| `xcs_indexer` | Indexer and maintenance replay        | `SELECT`/`INSERT` on `network_profiles`, `ledger_checkpoints`, `schema_events`, `schemas`, `credential_events`, and `indexer_incidents`; `SELECT`/`INSERT`/`UPDATE` on `indexer_status` and `credential_generations` |
| `xcs_api`     | Read API and optional Testnet pinning | `SELECT` on projections; CRUD on `pin_challenges` and `demo_pins` only                                                                                                                                               |
| `xcs_monitor` | PostgreSQL exporter                   | `pg_monitor`; no DML rights on XCS application tables                                                                                                                                                                |

Runtime-role creation is cluster-wide because PostgreSQL login roles are cluster-wide. Run bootstrap
only on a PostgreSQL cluster dedicated to XCS, with `XCS_DATABASE_CLUSTER_SCOPE=dedicated`. Grants
and `PUBLIC` revocations are scoped to the database selected by `XCS_BOOTSTRAP_DATABASE_URL`.

All runtime roles are denied schema creation, and `CREATE` on `public` is revoked from `PUBLIC`.
The single-replica alpha caps connections at 12 for `xcs_indexer`, 12 for `xcs_api`, and 3 for
`xcs_monitor`, leaving capacity for administration and recovery. Before scaling replicas or pool
sizes, increase and reapply these limits deliberately while retaining reserved administrator
slots.

Bootstrap uses `XCS_BOOTSTRAP_DATABASE_URL`; the indexer uses `XCS_INDEXER_DATABASE_URL`; the API
uses `XCS_DATABASE_URL`. Give the four identities distinct, long URL-safe passwords. Do not expose
the admin URL to API or indexer containers. Bootstrap must authenticate as a PostgreSQL role allowed
to create roles and schema objects; keep that identity confined to bootstrap and recovery jobs.

For each runtime-password rotation, bootstrap overrides any caller-supplied
`password_encryption` setting with transaction-local `scram-sha-256`, writes all three passwords,
and restores `LOGIN` only after all grants succeed. Configure the corresponding `pg_hba.conf`
role-to-database entries with `scram-sha-256` as well; verifier storage does not replace an explicit
authentication policy.

Treat the PostgreSQL administrator and reviewed baseline as trusted administrative inputs.
Bootstrap is not an anti-administrator attestation of every database object. Protect the
administrator credential and build supply chain separately. Runtime identities own no objects and
receive no DDL privilege.

On a new or recreated database, run the idempotent bootstrap before starting runtime services:

```sh
pnpm --filter @xcs-protocol/db db:bootstrap
```

The command applies the single generated baseline with Drizzle and then configures runtime roles in
one administrative transaction. A second run is a no-op for schema creation and reapplies the same
role attributes, passwords and grants. It does not upgrade an older or partially modified schema;
before production, recreate the projection database and regenerate the baseline instead.

Bootstrap serializes concurrent administrative runs with a transaction advisory lock. It creates
missing fixed roles as `NOLOGIN`, removes unexpected direct memberships, normalizes their
attributes, resets current-database schema/table/sequence/routine privileges, and restores `LOGIN`
only after passwords and least-privilege grants succeed. It does not audit or repair ownership and
ACLs outside the selected database; the dedicated-cluster requirement and trusted administrator are
therefore part of the security boundary.

Bootstrap also resets operational role defaults: `xcs_indexer` receives a 5-minute statement
timeout and 30-second lock and idle-in-transaction timeouts; `xcs_api` receives 30-second
statement/idle and 15-second lock timeouts; `xcs_monitor` receives 30-second statement/idle and
10-second lock timeouts. These PostgreSQL settings are `USERSET`, so a client holding the runtime
secret can override them; they are not security ceilings. Keep independently enforced
connection/query/resource quotas, and change the defaults only through a reviewed bootstrap
change rather than per-database role drift. The residual denial-of-service boundary, including SQL
`LISTEN`/`NOTIFY`, is documented in [`threat-model.md`](../threat-model.md).

Bootstrap reports only role names or a stable failure code, never URLs or password values. The
Compose dependency chain completes `db-bootstrap` before it starts runtime services. During password
rotation, stop the affected clients, rerun bootstrap with all three distinct passwords, then restart
them. As an independent guard, configure `pg_hba.conf` so `xcs_indexer`, `xcs_api` and `xcs_monitor`
can authenticate only to the XCS database, with `scram-sha-256` on each allow entry.

### Pre-production schema changes

`0000_baseline.sql` creates the complete current schema, including the discovery indexes:

- `schema_events_activity_idx` supports the reverse-chronological schema-registration activity page;
- `schemas_order_idx` supports stable schema pagination;
- `schemas_search_idx` is a PostgreSQL GIN expression index for schema name and description search;
- `credential_generations_stats_idx` supports aggregate lifecycle counts.

The baseline also creates the projection-integrity checks directly on empty tables. Until production
launch, change `src/schema/`, remove and regenerate the baseline artifacts, recreate the database,
run `db:bootstrap`, and replay the ledger-derived projection. Do not edit an applied baseline or
manually reshape ledger evidence in place.

Before production launch, freeze and archive the reviewed baseline. From that point onward, do not
regenerate it: introduce reviewed forward migrations with explicit compatibility, lock, backup and
rollback plans.

### Deployment configuration

1. Copy `.env.example` to `.env`. Direct password/token values support local Compose and host-side
   `pnpm` commands only. A hosted deployment must set the following eight `_FILE` variables and put
   one non-empty, single-line value in each ignored file:

   - `XCS_POSTGRES_ADMIN_PASSWORD_FILE`;
   - `XCS_INDEXER_DATABASE_PASSWORD_FILE`;
   - `XCS_API_DATABASE_PASSWORD_FILE`;
   - `XCS_MONITOR_DATABASE_PASSWORD_FILE`;
   - `XCS_INTERNAL_API_TOKEN_FILE`;
   - `XCS_METRICS_TOKEN_FILE`;
   - `XCS_RPC_URL_PRIMARY_FILE`;
   - `XCS_RPC_URL_SECONDARY_FILE`.

   Generate four distinct PostgreSQL passwords and distinct URL-safe internal/metrics tokens of at
   least 32 characters. The metrics token file is required by the production overlay even while
   metrics remain disabled; set `XCS_METRICS_ENABLED=true` only when Prometheus will scrape it. The
   bootstrap derives the administrator password from `XCS_BOOTSTRAP_DATABASE_URL` and
   compares it with all three runtime passwords before executing SQL.

   The two RPC files contain the complete WSS URLs and therefore also protect provider credentials
   embedded in a path or query. `docker-compose.secrets.yml` removes all corresponding direct values
   from the container model and mounts only these files. If the `monitoring` profile is enabled,
   also create the ninth, separate `XCS_GRAFANA_ADMIN_PASSWORD_FILE`. Compose implements file-backed
   secrets as bind mounts, so keep their parent directory mode `0700` and each file mode `0644` so
   the distinct unprivileged container UIDs can read only the secrets mounted into their service.
   Never place these files in a host directory accessible by another user, and never commit, log or
   expose their contents through a `NUXT_PUBLIC_*` variable.

   The internal token authenticates only the private Nuxt SSR-to-API rate-limit identity. It does
   not authenticate the public API, whose direct browser calls remain IP-limited. Never reuse a
   database, metrics or RPC secret for it.

2. Complete and independently audit the registry blackhole ceremony described in
   `config/networks/README.md`. The only exception is the private, disposable profile governed by
   ADR 0003 and the two exact environment acknowledgements above.
3. Save a normal immutable result as `config/networks/testnet.json`. The controlled pilot instead
   uses `config/networks/commons-testnet-xcs-v0.1-controlled-pilot.json`. In Compose,
   `XCS_NETWORK_PROFILE` is the mounted container path below `/workspace/config/networks`; a local
   `pnpm` indexer process uses the equivalent host path below `./config/networks`. Do not edit either
   file after indexing starts; a Testnet reset or changed profile field requires a new profile ID
   and database history. Set `XCS_DATABASE_SCOPE=exclusive-profile` for the controlled pilot and
   public beta so the database cannot silently mix profiles.
4. Set `XCS_PUBLIC_API_BASE_URL` and `XCS_ALLOWED_ORIGINS` to the browser-visible HTTPS origins when
   deploying behind a reverse proxy. The Compose web service uses `http://api:3001` separately for
   server-side rendering, so the public URL is never reused for container-to-container traffic.
   Configure the proxy to discard incoming forwarding headers and write its own canonical client
   address, then set `XCS_TRUSTED_PROXY_CIDRS` to that proxy's exact, narrow IP/CIDR. Compose applies
   this list to the API and Nuxt SSR resolver. Leave it empty for direct exposure; never use a
   wildcard, a catch-all `/0`, or trust arbitrary `X-Forwarded-For` values. An undeclared proxy is
   safe but collapses its visitors into the proxy's shared rate-limit budget.
5. Keep `XCS_BIND_ADDRESS=127.0.0.1` unless a firewall and authenticated administration boundary
   explicitly protect the exposed services.
6. Configure the primary and secondary RPC values—directly for local development or in their two
   `_FILE` paths for hosted deployment—as distinct WSS endpoints from independently operated,
   complete-history `rippled` providers. Distinct URLs alone are not evidence of independent
   operation; record the operators in the deployment review. Plain `ws://` is accepted only on a
   loopback address for local development.
7. Set `XCS_PUBLIC_RPC_URL` to a browser-reachable public WSS endpoint without embedded credentials.
   This endpoint is visible in client JavaScript and is used for wallet submission only. Never put a
   private or credential-bearing indexer endpoint in this variable: the server-only quorum
   configuration is the indexer's source of authoritative ledger evidence. Reusing the same URL is
   acceptable only when that endpoint is genuinely public and contains no secret; it remains a
   separate, non-authoritative browser setting. The web server rejects userinfo and non-TLS public
   endpoints at startup (`ws://` is loopback-only), but it cannot determine whether an opaque path or
   query parameter is a provider secret.
8. Optionally set `XCS_PUBLIC_XAMAN_API_KEY` and
   `XCS_PUBLIC_WALLET_CONNECT_PROJECT_ID` to the public application identifiers provisioned by
   Xaman and Reown/WalletConnect. Compose maps them to the corresponding `NUXT_PUBLIC_*` runtime
   values. They are public client configuration, not secret files. Leave either value empty to
   remove that adapter while retaining the six self-configuring XRPL Connect adapters.
9. Keep `XCS_INDEXER_LEASE_DURATION_MS` between 10 seconds and 5 minutes and at least three times the
   polling interval. Run `pnpm --filter @xcs-protocol/indexer preflight` before enabling the service.

For both the private controlled pilot and the Commons-hosted Testnet beta, also enforce the product
boundary from [`ADR 0002`](../adr/0002-public-product-and-discovery.md):

- leave `XCS_TRUSTED_ISSUERS` and `XCS_UNTRUSTED_ISSUERS` empty so Commons publishes no trust badge
  or issuer allowlist decision;
- keep `XCS_PAYLOAD_FETCH_ENABLED=false`; the browser retrieves issuer-hosted HTTPS payloads only
  after consent and sends parsed content for validation without API-side resolution;
- keep `XCS_DEMO_PINNING_ENABLED=false`; the issuer, not Commons, operates the public HTTPS payload
  host;
- do not add a subject feed, account-wide Credential export or claims ingestion to the deployment.

Validate the rendered configuration, then build and start the required profile. The default core
contains only PostgreSQL, database bootstrap, API and indexer. `site` adds Nuxt,
`monitoring` adds Prometheus, Grafana and both exporters, and `demo-pinning` adds Kubo:

```sh
docker compose config --quiet
docker compose up --build
docker compose --profile site up --build
docker compose --profile site --profile monitoring up --build
```

Those commands build the reviewed source locally for the alpha. When every enabled service image
variable references an already published, reviewed digest, pull and start without invoking a local
build instead:

```sh
docker compose --profile site --profile monitoring pull
docker compose --profile site --profile monitoring up --no-build --detach
```

Do not combine `--build` with digest-valued service image variables.

Profiles are additive; use only the command matching the reviewed deployment. Prometheus, Grafana,
PostgreSQL and Kubo publish no host port in the production model. For an explicit loopback-only
development inspection, layer the committed override and set insecure Grafana cookies only for that
local HTTP session:

```sh
XCS_GRAFANA_COOKIE_SECURE=false \
  docker compose -f docker-compose.yml -f docker-compose.secrets.yml -f docker-compose.dev.yml \
  --profile monitoring up --build
```

Never use `docker-compose.dev.yml` on a public host. The production `database` and `monitoring`
networks are internal; only the edge plane has egress. Runtime containers are read-only, drop all
capabilities, set process/resource/log limits and run the built Node services as the unprivileged
`node` user. Production operators may override every image variable in `.env` with a reviewed
immutable digest and should record `XCS_REVISION` and `XCS_VERSION` with the deployment evidence.
The artifact-release workflow fails closed unless the non-secret repository Actions variable
`XCS_RELEASE_NODE_IMAGE` is a reviewed `node:24-alpine@sha256:<digest>` reference; release builds
pass that exact immutable base into all three Node images. This release variable is separate from
the local/Compose `XCS_NODE_IMAGE` setting.
Signal definitions, SLO/RTO/RPO semantics and the recovery drill are documented in
[`monitoring.md`](./monitoring.md).

Use `config --quiet`: it avoids printing direct values if an overlay is accidentally omitted or
mis-merged. CI separately asserts that the production model contains only secret-file paths. The
one-shot `db-bootstrap` service applies the current baseline and runtime grants with `xcs_admin`
before the API and indexer start. The API is
live at `/health/live`; Compose uses that endpoint for container health and starts the web service
only after it succeeds. Do not replace this liveness check with `/health/ready`: readiness stays
unavailable until the dual-source indexer owns a live lease and its status exactly matches a
transaction-root-bearing checkpoint at the effective tip, and a normal catch-up must not restart the
API. `XCS_READINESS_MAX_LEDGER_AGE_SECONDS` controls readiness and all authoritative ledger-derived
routes; stale, inconsistent, or implausibly future evidence returns `503`. OpenAPI documentation is
served at `/documentation`.

The compatibility alias `/health`, `/health/live`, and `/health/ready` all emit `Cache-Control:
no-store` and bypass the application rate limiter. Restrict them at the ingress to the load balancer
and monitoring network so public traffic cannot turn the database-backed readiness check into an
unbounded read path. Preserve both their status codes and cache policy; never synthesize a cached
`200` for a `503` readiness response.

When operational metrics are enabled, scrape them with the dedicated bearer token:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${XCS_METRICS_TOKEN}" \
  http://127.0.0.1:3001/internal/metrics
```

The snapshot is JSON schema version 1, carries `Cache-Control: no-store`, and never consumes the
public rate-limit budget. Alert on `/health/ready` separately: the metrics route intentionally stays
`200` during a database outage so process-local counters remain observable. Do not interpret
`logicalSizeBytes` as free disk or `clusterConnections` as API-pool saturation. Obtain physical
volume capacity and container/process saturation from the deployment monitoring layer; do not mount
the Docker socket or PostgreSQL volume into the API container. Scrape every 30–60 seconds rather
than continuously: registration totals are derived from the rebuildable event projection and become
more expensive as history grows. Alert separately on `database.errorCode`: `DATABASE_UNAVAILABLE`
means the snapshot query failed, while `METRICS_EVIDENCE_INVALID` means PostgreSQL answered but the
stored evidence was partial, malformed, or outside the supported bounds.

### Browser security-header rollout

Nitro is the source of truth for the web application's browser security headers. The initial
deployment emits the CSP as `Content-Security-Policy-Report-Only`; it must not emit an enforced
`Content-Security-Policy` until every enabled XRPL Connect adapter has passed the real browser
matrix below. Report-only violations are diagnostic and do not block script execution, wallet
communication or payload requests. WalletConnect modal styles and images are part of that
qualification and must not be allowlisted speculatively.

The `Permissions-Policy` must retain `hid=(self)` and `usb=(self)` for the user-initiated Ledger
path while denying those capabilities to cross-origin documents. Removing either directive can
break hardware-wallet access; broadening it beyond `self` expands the device trust boundary.

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
   `CredentialAccept` and `CredentialDelete` without relaxing the policy. Record unavailable
   adapters as untested rather than successful.
3. For WalletConnect, record the candidate wallet and prove that its session advertises the XRPL
   Testnet namespace and supports the native `Credential*` payloads; a successful QR/deep-link
   pairing alone is not compatibility evidence. Exercise Ledger on the intended physical device and
   browser rather than treating the Permissions Policy header as device evidence.
4. After explicit payload-host consent, load an issuer-hosted HTTPS payload with CORS and confirm
   that its integrity verification succeeds. Confirm that no payload request occurs before consent.

Classify and fix every application-owned violation. Record the browser, adapter, wallet
application/extension or hardware device, web image and policy versions with the evidence.
Wallet-origin messages that cannot be attributed or reproduced are not a reason to add a broad
source expression.

Only after every enabled real-wallet matrix passes may the reviewed deployment replace the single
`Content-Security-Policy-Report-Only` field with the same policy under `Content-Security-Policy`.
Re-run both `curl` checks and the DevTools matrix against the enforced candidate before promotion.
Roll back to the prior image, which restores report-only mode, if a wallet or consented payload flow
regresses; do not work around an incident by appending a second or weaker policy at the edge.

If one adapter regresses before promotion, remove its public identifier where applicable or
restrict the XRPL Connect factory in a reviewed web rollback. This changes no XCS protocol rule or
PostgreSQL schema and requires no database rollback. Never route around an adapter failure by
calling `signAndSubmit`: XCS must retain normalization, persistence and sole submission control.

## Optional Testnet demo pinning

Pinning is disabled by default. It is only intended for public, non-sensitive Testnet examples. To
enable it, set all of the following:

```dotenv
XCS_DEMO_PINNING_ENABLED=true
XCS_PINNING_NETWORKS=<exact-profile-id>
XCS_PINNING_IP_HASH_SECRET=<at-least-32-random-bytes>
XCS_IPFS_API_URL=http://ipfs:5001
```

Then include the isolated Kubo service:

```sh
docker compose --profile demo-pinning up --build
```

If server-side verification should read from that local node, also set
`XCS_PAYLOAD_FETCH_ENABLED=true` and `XCS_IPFS_GATEWAY_URL=http://ipfs:8080`. The wallet challenge,
per-wallet/IP quotas, 64 KiB demo limit, 90-day retention, and cleanup job reduce abuse; they cannot
detect all personal data. Never pin PII, secrets, or production credentials.

## Operations and rollback

- Back up PostgreSQL and the exact network profile together. Kubo blocks are reconstructable only
  while their source payload still exists.
- Monitor checkpoint age, rejected registrations, ledger continuity failures, pin-store failures,
  and disk usage.
- Roll back application images only to a version compatible with the current baseline. Before
  production, rebuild and replay the database for an incompatible schema change; never skip a
  ledger.
- Rerun `db-bootstrap` after runtime-password rotation, then restart clients with the matching
  credentials. Keep `xcs_admin` credentials out of runtime containers and logs.
- Retain a `pg_hba.conf` role-to-database allowlist as defense in depth.
- `docker compose down` preserves named volumes. Removing volumes destroys the local projection and
  pin store and is intentionally not part of this runbook.
