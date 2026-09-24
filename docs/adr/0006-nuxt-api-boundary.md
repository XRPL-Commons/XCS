# ADR 0006: serve the API in Nuxt with separate database privileges

Status: accepted for issue #28.

## Decision

Nuxt owns the site and the existing REST API through native Nitro handlers. The indexer remains
an independent worker; PostgreSQL remains external to both processes (managed in production,
available in local Compose). The standalone `apps/api` service is removed, not proxied internally.
Existing `/v1/...`, payload, health and operational endpoints keep their paths and contracts.

Two server-only Nuxt connections enforce different privileges:

- `XCS_DATABASE_URL` uses `xcs_api` for read-only ledger projections.
- Optional `XCS_PAYLOAD_DATABASE_URL` uses `xcs_payload_writer` for hosted payloads and demo
  pinning. It can insert immutable hosted content and publication records and modify demo-pinning
  tables; it cannot write ledger projections or perform DDL.

The independent indexer keeps `xcs_indexer`; only administrative bootstrap owns schema changes.
Credentials are distinct and no database URL enters browser runtime configuration.

## Rationale and consequences

The issue asks for two application services without removing existing public payload hosting.
A read-only Nuxt connection alone cannot publish payloads. A second restricted pool preserves
that feature without granting publication code the indexer's authority or keeping a third service.
This is a privilege boundary, not process isolation: compromising Nuxt exposes both configured
pools. The grants still prevent projection writes by either pool.

Browser calls are same-origin by default. SSR calls the same handlers locally, so the former
shared SSR token/HMAC forwarding scheme and private API URL disappear. Public IP request budgets,
bounded bodies, CORS, payload checks and fail-closed readiness remain. Ingress client-IP forwarding
is trusted only for explicitly configured narrow `XCS_TRUSTED_PROXY_CIDRS`.

Nitro entry points live in `server/routes`, not `server/api`, to preserve `/v1` rather than
introducing an `/api/v1` prefix. Domain services live under `server/xcs` and remain independent
of Nuxt's auto-imports. `/documentation` is an HTML endpoint index linked to the OpenAPI JSON;
the standalone Swagger UI dependency is removed.

The API transport owns body limits and quotas rather than enabling duplicate Nuxt Security
middleware. The installed module's limiter trusts forwarding headers directly, while its size
guard relies on Content-Length. Native H3 handlers preserve explicit proxy trust, bounded chunked
reads and the existing JSON error contract; Ajv and fast-json-stringify reuse the API schemas.

## Rollout and rollback

Stop the old API writers, back up the database, rerun administrative bootstrap with the new writer
password, then deploy Nuxt with the restricted pools. No ledger replay, database reset or schema
rewrite is required for this boundary change. Preserve existing API and payload hostnames through
ingress routing and preserve the site's origin so signed-operation recovery remains available.

The old API loses publication rights when bootstrap runs. Rolling its image back requires an
explicit grant rollback as well; administrator credentials are never an acceptable workaround.
See [deployment](../runbooks/deployment.md) and [API surfaces](../api-surfaces.md).

## Non-goals

This decision does not introduce accounts, organizations, roles, private payloads, protocol changes,
or additional API capabilities. Those require separate issues and product decisions.
