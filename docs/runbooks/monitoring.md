# Monitoring and recovery objectives

The optional `monitoring` Compose profile collects authenticated metrics from the web app, from the
PostgreSQL exporter and from the host. It provisions one Grafana dashboard and Prometheus alert
rules. It does not configure an Alertmanager destination; routing notifications to the Commons
on-call system remains a deployment-specific external step.

> **Local development only.** Compose is no longer a deployment template (see
> [`deployment.md`](./deployment.md)), and this profile passes Grafana's admin password
> (`XCS_GRAFANA_ADMIN_PASSWORD`) and the exporter's database password
> (`XCS_MONITOR_DATABASE_PASSWORD`) as **plain container environment variables** read from `.env`.
> They are visible to anyone who can run `docker inspect` or read the container's environment. That
> is acceptable only because this stack is local development with loopback-only ports and disposable
> credentials. Never run this profile on a shared or public host, never put a real deployment's
> credentials in `.env`, and treat a hosted monitoring stack as a separate design that must carry
> its own secret handling.

The alert rules, dashboard and scrape configuration in `ops/monitoring/` are reusable by a hosted
monitoring stack; the Compose services around them are not.

## Objectives

- Authoritative readiness objective: at least `99.5%` over a rolling 30-day window.
- Freshness budget: the authoritative checkpoint must normally remain below `120` seconds old.
- Recovery-time objective: restore authoritative read/verification service within `4` hours of a
  declared core incident.
- Protocol recovery-point objective: `0` lost validated XCS ledger events. Recovery replays from the
  immutable activation boundary or last independently verified checkpoint and never skips,
  truncates or invents ledger evidence.

The RPO applies to reconstructible protocol state, not optional pinning administration rows. Back up
those rows separately if demo pinning is enabled. Meeting the RTO depends on retained complete
ledger history, tested backups, image availability and named operator ownership; the repository
cannot prove those external conditions by configuration alone.

## Enable the profile

Requires Docker Compose `2.24.4` or newer. In `.env` (copied from `.env.compose.example`):

```dotenv
XCS_METRICS_ENABLED=true
XCS_METRICS_TOKEN=<32+ URL-safe random characters>
XCS_MONITOR_DATABASE_PASSWORD=<the value db:bootstrap provisioned for xcs_monitor>
XCS_GRAFANA_ADMIN_USER=xcs_admin
XCS_GRAFANA_ADMIN_PASSWORD=<a distinct random value; there is no default>
XCS_GRAFANA_COOKIE_SECURE=false
```

`XCS_METRICS_TOKEN` must exist in the environment, even empty, whenever the monitoring profile runs:
an unset variable fails the Compose secret, not just the scrape. The web app and Prometheus read that
same value — Compose materializes it as the file Prometheus reads as its scrape credential.

The PostgreSQL exporter authenticates as the dedicated `xcs_monitor` role. Provisioning that role
first requires the built-in `pg_monitor`, `pg_read_all_settings`, `pg_read_all_stats` and
`pg_stat_scan_tables` attributes, exact membership graph and ACLs to match PostgreSQL's recorded
installation baseline. Drift fails closed instead of being silently repaired. Only then does
`xcs_monitor` inherit `pg_monitor`, without `SET ROLE`, application-table DML or any raw
advisory-lock function.

Validate the fully rendered configuration without printing it, then start the profile:

```sh
docker compose --profile monitoring config --quiet
docker compose --profile monitoring up --build
```

Prometheus and Grafana stay on the internal `monitoring` network and publish no port. To inspect them
on loopback during development, layer the explicit override:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --profile monitoring up --build
```

Set `XCS_GRAFANA_COOKIE_SECURE=false` only for that local HTTP session.

## Signals and alerts

Prometheus scrapes the `web` service (`web:3000`) at `GET /internal/metrics/prometheus` every 30
seconds with the metrics bearer token. Both metrics routes belong to the web app, which serves the
`/v1` API; there is no separate API service. The route is disabled unless metrics are enabled,
bypasses public rate-limit accounting and must retain `Cache-Control: no-store`. The separate
`/internal/metrics` JSON representation is for bounded operator diagnostics; Prometheus does not
scrape it.

Committed rules cover:

- web-app metrics, PostgreSQL and exporter unavailability or snapshot failures;
- missing readiness telemetry and a halted or persistently non-ready indexer;
- checkpoint age above 120 seconds and projection lag above five ledgers;
- missing or diverging source tips;
- PostgreSQL connection use above 80 percent;
- rolling 30-day authoritative readiness below 99.5 percent, with scrape failures and missing
  readiness samples counted as unavailable;
- host filesystem use above 80 and 90 percent.

The Grafana dashboard is provisioned from `ops/monitoring/grafana/dashboards/xcs-core.json`. Validate
configuration changes before deployment:

```sh
docker compose --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus check rules /etc/prometheus/rules/xcs-alerts.yml
docker compose --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus test rules /etc/prometheus/tests/xcs-alerts.test.yml
jq empty ops/monitoring/grafana/dashboards/*.json
```

Node exporter mounts host `/proc`, `/sys` and `/` read-only and receives no Docker socket. The
PostgreSQL exporter uses its dedicated least-privilege `xcs_monitor` database identity. Neither
exporter is protocol authority.

## Incident response and recovery drill

1. Record alert time, profile ID, current image digests, writer epoch, checkpoint index/hash and the
   two source tips. Do not paste tokens or connection URLs into the incident record.
2. Treat a halted indexer or source divergence as fail-closed. Keep the web app's read API
   non-authoritative; do not override readiness or manually advance a checkpoint.
3. Determine whether the fault is source, host, database, image or configuration. Preserve the exact
   network profile and database backup before mutation.
4. Restore the last known-good compatible images/database or provision a fresh database. Replay only
   from complete, quorum-agreed ledger evidence under the same immutable profile.
5. Compare the deterministic projection digest and latest checkpoint against an independent replay.
   Re-enable authoritative traffic only after the writer lease, source agreement, transaction root
   and freshness checks all pass.
6. Record time to recovery and whether every event after activation was reconstructed. A recovery
   beyond four hours or any unavailable ledger range is an objective breach, even if the web process
   itself stayed live.

Exercise this process before the public beta and after changes to PostgreSQL, provider retention,
backup tooling or deployment topology. A real drill needs Commons infrastructure, provider access
and named incident authority; CI validates configuration and a local web-app smoke, not those
external facts.

## Rotation and retention

`XCS_METRICS_RETENTION` defaults to 30 days, matching the readiness objective window. Retain incident
records and drill evidence outside Prometheus according to Commons policy. To rotate the metrics
token, update `XCS_METRICS_TOKEN` and restart both the web app and Prometheus; a partial rotation
intentionally makes the scrape fail. Rotate the database and Grafana passwords through their normal
procedures and rerun `pnpm --dir apps/indexer db:bootstrap` after a database password change.
