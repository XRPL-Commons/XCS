# PR 35 — adapt to standalone applications

Goal: preserve tested wallet, authentication, admin, issuer and private payload behaviour while
adopting Luc’s merged #36 architecture (25ea0b4). Original reference: a9777cc.

Invariants: no apps/api or packages/db; apps install independently with --ignore-workspace;
only db/schema and migrations are shared; protocol copies track root sources; PostgreSQL is external
in production; Compose is local-only; no private claims in public projection; unchanged applied SQL.
No live deployment, wallet approval, external email or new #32/#33 feature is included.

1. Complete: port independent app/schema code, dependencies and existing regression coverage.
2. Complete: adapt deployment/CI/docs and validate copy/schema/lockfile boundaries.
3. Complete: per-app/root static/unit/build, isolated PostgreSQL/runtime/browser, images and local Compose.
4. Delivery: review exact integration diff, preserve both histories and publish to PR35; remote CI
   results are tracked on the PR, which remains draft for the gates below.

Recovery: retain a9777cc and upstream main unchanged; forward-only migration history, no pilot DB touched.
Main risks: duplicate public routes during port, least-privilege pools, migrations across moved paths,
independent module resolution, drift of protocol copies, old CI license gates.

## Validation on the standalone tree

- `pnpm verify`: passed (59 shared-package, 766 web and 287 indexer unit tests; 1,112 total),
  including format, copy provenance, Drizzle parity, lint, types and all builds.
- Isolated PostgreSQL 18: 55 indexer/database and 32 web tests passed. The 15 SQL/snapshot/journal
  files remain byte-identical to a9777cc; `pnpm --dir apps/indexer db:generate` emits no migration.
- `pnpm --dir apps/web test:runtime`: four compiled Nitro scenarios passed: HTTP quotas versus
  local SSR exemption, public publication/readiness/SSR, authenticated admin and issuer workflows.
  The latter two use Chromium, restricted database pools, private documents and local SMTP.
- Browser suites: 53 public/admin/issuer, two authentication and three production-security tests
  passed (58 total). An initial schema-flow failure coincided with a source-edit HMR reload;
  the isolated scenario and complete stable-source rerun passed without changing assertions.
- Both standalone Docker images built with only their own app plus shared db/config, execute as
  UID 1000 and contain no TypeScript/Vitest/tsx development tools. Local Compose validation covers
  32 exact overlay/profile combinations, restricted grants and optional application/public hosting.
- Dependency audits for all three independent lockfiles pass the high/critical threshold.
- License policy remains blocked: `@gemwallet/api@3.8.0`, `@walletconnect/types@2.25.0` and
  `vaul-vue@0.4.1` are reported Unknown; `nodemailer@10.0.10` reports MIT-0, outside the allowlist.
  No policy exception or relaxation was added.

Real XRP Identity registration, physical wallet consent, live Testnet transactions, mockup user
acceptance and production deployment are separate gates; automated fixtures do not establish them.
The full recipient/verifier flows (#32/#33) remain outside this port. Keep PR #35 in draft.
