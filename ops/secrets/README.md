# Compose secret files

Compose materializes `xcs_metrics_token` from a file in this directory because Prometheus reads its
scrape credential with `credentials_file` and runs `read_only: true`, which Compose refuses to
combine with an environment-sourced secret.

Nothing here is committed. Before starting the `monitoring` profile, write the same value as
`XCS_METRICS_TOKEN` in `.env` into `xcs_metrics_token`:

```sh
install -m 600 /dev/null ops/secrets/xcs_metrics_token
printf '%s' "$XCS_METRICS_TOKEN" > ops/secrets/xcs_metrics_token
```

Override the location with `XCS_METRICS_TOKEN_FILE`. See `docs/runbooks/monitoring.md`.
