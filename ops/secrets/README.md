# Compose secret files

Compose materializes `xcs_metrics_token` from a file in this directory because Prometheus reads its
scrape credential with `credentials_file` and runs `read_only: true`, which Compose refuses to
combine with an environment-sourced secret.

Nothing here is committed. Before starting the `monitoring` profile, write the same value as
`XCS_METRICS_TOKEN` in `.env` into `xcs_metrics_token`:

```sh
mkdir -p ops/secrets
chmod 700 ops/secrets
printf '%s' "$XCS_METRICS_TOKEN" > ops/secrets/xcs_metrics_token
chmod 644 ops/secrets/xcs_metrics_token
```

The modes matter: a file-backed Compose secret is a bind mount that keeps the host file's mode and
owner, so a too-restrictive file is unreadable by the container's unprivileged user (`cat: can't
open '/run/secrets/xcs_metrics_token': Permission denied`) while a too-permissive directory exposes
it to other host users. Keep the directory `0700` and each secret file `0644`, and never
`chmod -R` the tree.

Override the location with `XCS_METRICS_TOKEN_FILE`. See `docs/runbooks/monitoring.md`.
