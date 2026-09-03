# Monitoring and recovery objectives

The optional `monitoring` Compose profile collects authenticated XCS API metrics, PostgreSQL
exporter metrics and host capacity metrics. It provisions one Grafana dashboard and Prometheus alert
rules. It does not configure an Alertmanager destination; routing notifications to the Commons
on-call system remains a deployment-specific external step.

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

Hosted monitoring requires Docker Compose `2.24.4` or newer and the production secret overlay. Set
`XCS_METRICS_ENABLED=true` and configure the eight core secret-file paths:

- `XCS_POSTGRES_ADMIN_PASSWORD_FILE`;
- `XCS_INDEXER_DATABASE_PASSWORD_FILE`;
- `XCS_API_DATABASE_PASSWORD_FILE`;
- `XCS_MONITOR_DATABASE_PASSWORD_FILE`;
- `XCS_INTERNAL_API_TOKEN_FILE`;
- `XCS_METRICS_TOKEN_FILE`;
- `XCS_RPC_URL_PRIMARY_FILE`;
- `XCS_RPC_URL_SECONDARY_FILE`.

The API and Prometheus read the same metrics-token file. PostgreSQL exporter authenticates as the
dedicated `xcs_monitor` role. Provisioning first requires the built-in `pg_monitor`,
`pg_read_all_settings`, `pg_read_all_stats` and `pg_stat_scan_tables` attributes, exact membership
graph and ACLs to match PostgreSQL's recorded installation baseline. Drift fails closed instead of
being silently repaired. Only then does `xcs_monitor` inherit `pg_monitor`, without `SET ROLE`,
application-table DML or any raw advisory-lock function. Create a ninth, independent
`XCS_GRAFANA_ADMIN_PASSWORD_FILE` for Grafana. Compose implements file-backed secrets as bind mounts:
keep their parent directory mode `0700` and each file mode `0644`, allowing the distinct
unprivileged container UIDs to read only secrets mounted into their service. Do not put them in a
host directory accessible by another user, commit them, log them or pass their contents on a command
line. The default paths are under `ops/secrets/`, whose contents are ignored by Git.

Validate the fully rendered configuration without printing it, then start the profile:

```sh
docker compose -f docker-compose.yml -f docker-compose.secrets.yml \
  --profile monitoring config --quiet
docker compose -f docker-compose.yml -f docker-compose.secrets.yml \
  --profile monitoring up --build
```

This example builds the alpha source locally. For digest-pinned deployment images, follow the
`pull` plus `up --no-build` procedure in [`deployment.md`](./deployment.md).

Prometheus and Grafana stay on the internal monitoring network and publish no port. Use an
authenticated reverse proxy or an operator tunnel in a hosted environment. The explicit
`docker-compose.dev.yml` override may expose them on loopback for development; set
`XCS_GRAFANA_COOKIE_SECURE=false` only for that local HTTP session.

## Signals and alerts

Prometheus scrapes `GET /internal/metrics/prometheus` every 30 seconds with the metrics bearer token.
The public route is disabled unless metrics are enabled, bypasses public rate-limit accounting and
must retain `Cache-Control: no-store`. The separate `/internal/metrics` JSON representation is for
bounded operator diagnostics; Prometheus does not scrape it.

Committed rules cover:

- metrics/API, PostgreSQL and exporter unavailability or snapshot failures;
- missing readiness telemetry and a halted or persistently non-ready indexer;
- checkpoint age above 120 seconds and projection lag above five ledgers;
- missing or diverging source tips;
- PostgreSQL connection use above 80 percent;
- rolling 30-day authoritative readiness below 99.5 percent, with API scrape failures and missing
  readiness samples counted as unavailable;
- host filesystem use above 80 and 90 percent.

The Grafana dashboard is provisioned from `ops/monitoring/grafana/dashboards/xcs-core.json`. Validate
configuration changes before deployment:

```sh
docker compose -f docker-compose.yml -f docker-compose.secrets.yml \
  --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose -f docker-compose.yml -f docker-compose.secrets.yml \
  --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus check rules /etc/prometheus/rules/xcs-alerts.yml
docker compose -f docker-compose.yml -f docker-compose.secrets.yml \
  --profile monitoring run --rm --no-deps \
  --entrypoint /bin/promtool prometheus test rules /etc/prometheus/tests/xcs-alerts.test.yml
jq empty ops/monitoring/grafana/dashboards/*.json
```

Node exporter mounts host `/proc`, `/sys` and `/` read-only and receives no Docker socket. The
PostgreSQL exporter uses its dedicated least-privilege `xcs_monitor` database identity. Neither
exporter is protocol authority.

## Incident response and recovery drill

1. Record alert time, profile ID, current image digests, writer epoch, checkpoint index/hash and the
   two source tips. Do not paste tokens or connection URLs into the incident record.
2. Treat a halted indexer or source divergence as fail-closed. Keep the API non-authoritative; do not
   override readiness or manually advance a checkpoint.
3. Determine whether the fault is source, host, database, image or configuration. Preserve the exact
   network profile and database backup before mutation.
4. Restore the last known-good compatible images/database or provision a fresh database. Replay only
   from complete, quorum-agreed ledger evidence under the same immutable profile.
5. Compare the deterministic projection digest and latest checkpoint against an independent replay.
   Re-enable authoritative traffic only after the writer lease, source agreement, transaction root
   and freshness checks all pass.
6. Record time to recovery and whether every event after activation was reconstructed. A recovery
   beyond four hours or any unavailable ledger range is an objective breach, even if the API process
   itself stayed live.

Exercise this process before the public beta and after changes to PostgreSQL, provider retention,
backup tooling or deployment topology. A real drill needs Commons infrastructure, provider access
and named incident authority; CI validates configuration and a local API smoke, not those external
facts.

## Rotation and retention

`XCS_METRICS_RETENTION` defaults to 30 days, matching the readiness objective window. Retain incident
records and drill evidence outside Prometheus according to Commons policy. To rotate the metrics
token, update the API environment and token file atomically, then restart API and Prometheus; a
partial rotation intentionally makes the scrape fail. Rotate the database and Grafana passwords
through their normal secret procedures and rerun database bootstrap after a database
password change.
