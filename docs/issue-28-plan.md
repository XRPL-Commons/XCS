# Issue 28 — Nuxt API integration

Base: `integration/current-flow` / PR #35, commit `212ba0c`. Branch: `issue/28-nuxt-api`.
PR #35 is not merged; this change must remain a separate stacked PR until its base is accepted.

## Approved scope

Fold the standalone HTTP API into Nuxt/Nitro, preserve `/v1/**`, `/health/**`, `/p/**`,
metrics and OpenAPI contracts. Use `xcs_api` for projection reads and a separate
`xcs_payload_writer` connection for hosted payload/demo pinning writes. No new product roles,
authentication, invitation flow, protocol changes or reset of the running site/database.

## Milestones

1. Complete: move the existing business logic and contract tests into the web server;
   replace the Fastify boundary with native H3 handlers, preserving schema validation,
   serialization, limits, CORS, exact error codes and ledger evidence checks.
2. Complete: provision least-privilege DB identities, wire lifecycle-managed separate pools,
   remove the SSR HTTP/token hop and use in-process same-origin requests.
3. Complete: update deployment/env/OpenAPI documentation, test empty/upgrade databases and
   denied writes, run unit/static/browser/production build and isolated Docker checks.
4. Reviewed locally; prepare one issue-specific commit and a separate draft PR. PR #35 must merge
   first. Upstream write permission is unavailable, so the PR targets upstream `main` from the fork
   and must link the focused comparison against `212ba0c` until that dependency lands.

## Validation and rollback

Retain the existing API contract tests against the new HTTP stack. Add tests for oversized bodies,
spoofed forwarding/internal headers, canonical responses, SSR identity and no network hop.
Test SQL grants with independent restricted connections; neither web role can mutate the
projection. Preserve all applied migration bytes. Verify bootstrap against an isolated external
PostgreSQL URL, never the active pilot database. Build both production image paths and render
Compose overlays without starting the active project.

Retain the original API origin at the ingress when moving it to Nuxt. Preserve the browser origin
and immutable payload URLs so local recovery records and ledger-bound URIs keep working. The
read-role grant change requires coordinated rollout; rollback must restore old code/grants from
the recorded baseline, not drop application data. Existing dependency-license and real-wallet
release gates remain separate and cannot be bypassed by this migration.

## Verification — 2026-09-23

- `pnpm verify`: formatting, lint, types, 797 unit tests and all six package builds passed.
- PostgreSQL 18: 13 indexer and five API integration tests passed on an isolated cluster,
  including legacy privilege revocation and denied projection writes.
- Production Nuxt runtime: two integration tests passed. Real PostgreSQL pools and local
  cryptographic signing exercise hosted publication/idempotency/immutable bytes; the projection
  is explicitly synthetic, not a claim of live XRPL validation. SSR ignores an unreachable
  browser API URL. A real Nitro localFetch regression proves independent quota identities.
- Playwright: 37 deterministic browser flows and three production security tests passed.
  Fixed an existing host/browser clock race in the pending-wallet test; five repeated runs passed.
- Both `Dockerfile` and `docker/Dockerfile.node` web images built and served health/docs/HTML,
  HEAD and POST validation under UID 1000 with read-only filesystem, dropped capabilities and
  file-mounted read/writer configuration. No live deployment was replaced.
- Compose overlays/profiles rendered; entrypoint tests, ShellCheck, actionlint and immutable
  workflow-reference checks passed. `db:generate` produced no migration changes.
- Production advisory gate at `high`: passed (two low, one moderate remain).
- License gate: still fails on pre-existing unknown metadata for `@gemwallet/api@3.8.0`,
  `@walletconnect/types@2.24.0`, `vaul-vue@0.4.1`. No license exception was added.

Not performed: live extension-wallet approvals, public deployment, production managed-provider
bootstrap, remote CI execution or merging PR #35. This is reviewable implementation evidence,
not a declaration that all release gates are cleared.
