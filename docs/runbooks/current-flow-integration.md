# Current flow integration — 2026-09-23

> Historical validation record for the first integration on PR #34. Its deployment commands,
> API split and future-work scope are superseded by the [standalone adaptation](../plans/pr35-standalone.md),
> [current deployment runbook](deployment.md) and PR #35. The test counts below describe that earlier commit.

## Scope and provenance

Base: Commons `main` at `61fb809` (merged PR #34). Keep its Nuxt UI/Tailwind implementation,
deployment split and security policy. Integrate the existing local functionality, not the future
role-based application. Issues #24–33 remain open; this work does not implement authentication,
issuer approval, invites, private claims, or the API-to-Nuxt migration.

The local running source was preserved on `backup/local-flow-20260923` before integration:

- `b63ffd5`: protocol/indexer changes;
- `18e6f85`: recovered payload API and migrations;
- `8c2a64f`: wallet, recipient and publication/recovery flows.

Three earlier local fixes missing from the merged base were also retained: `18db6e8` (malformed
Unicode), `27fd837` (unresolved submission recovery), `808f3e9` (wallet cleanup failure handling).
The integration branch is `integration/current-flow`. The old running checkout and database were
not replaced or reset.

## Preserved behavior

- XRPL Connect Vue rc.2, bounded connection/discovery, explicit session actions and network checks;
  the narrow, pinned Crossmark package patch is documented in `patches/README.md`.
- Schema registration, hosted/external payload issuance, recipient inbox, explicit acceptance,
  verification, deletion and operation reconciliation, adapted to Nuxt UI components.
- GemWallet raw Credential signing remains Testnet-only and requires explicit transaction consent.
- Hosted public payload bytes persist in PostgreSQL; interrupted publication is recoverable after
  reload without signing another credential. The API remains a separate service.
- English default with French available. Upstream payload-review safety checks and external-host
  validation are retained; regression coverage protects failed review with stale claims.

## Verification performed

- `pnpm install --frozen-lockfile` and `pnpm verify`: passed (791 unit tests; format, lint,
  typecheck and all seven package builds).
- `XCS_E2E_PORT=3198 pnpm --filter @xcs-protocol/web test:e2e`: 37 passed.
- `pnpm --filter @xcs-protocol/web test:e2e:security`: 3 passed against the production build;
  deterministic fixture routes are unavailable there.
- Isolated PostgreSQL 18: 13 indexer + 5 API integration tests passed. Includes fresh bootstrap,
  repeated bootstrap, upgrade from baseline and legacy hosted storage, retained profiles/bytes,
  exact runtime grants and publication quotas/collision handling.
- `pnpm --filter @xcs-protocol/db db:generate`: no schema changes. Applied SQL files remain
  byte-identical to the preserved local source; only JSON snapshot formatting was normalized.
- API production Docker image and App Platform web image built; both served HTTP successfully as
  uid 1000. API used mounted secret files and the restricted API database role on the isolated DB.
- Base + secret + hosted-payload overlays rendered with site/monitoring/demo-pinning profiles.
  Entrypoint secret-loading tests passed.
- `pnpm audit --prod --audit-level high`: passed threshold; 2 low and 1 moderate advisories remain.

Browser suites above use explicit deterministic fixtures. They are not evidence that a real
Crossmark/Otsu/GemWallet/Xaman extension signed through this new UI. Historical live-wallet reports
describe the earlier checkout only. A real fresh Testnet journey on this branch remains a
pre-merge requirement; do not market this integration as release-ready.

## Outstanding gates

- License policy check still fails for `@gemwallet/api@3.8.0`, `@walletconnect/types@2.24.0`,
  and `vaul-vue@0.4.1` (reported `Unknown`). No license exception or policy relaxation was added.
- XRPL Connect rc.2 declares an xrpl.js 3/4 peer range while this repository uses 5. Automated
  checks pass, but a peer warning is not a real-wallet compatibility guarantee.
- Xaman redirect selection is delegated to its SDK; the old redirect environment variable is no
  longer consumed. Qualify homepage and deep-link sign-in against the deployment's registered URLs.
- Quota exhaustion or an outage can prevent hosted publication after ledger validation. Recovery
  preserves the signed transaction and bytes, but does not guarantee immediate host availability.
- Public deployment/domain durability, cloud amd64 build, enforced CSP and real wallet matrix are
  not established here. Localhost-only payloads remain inaccessible from another device.

Keep the integration PR in draft until these applicable gates are resolved. After integration,
start separate issue branches from the merged Commons `main`, beginning with the role flows in
#29 before data/auth/API architecture work. Do not mix that redesign into this reconciliation PR.

## Deployment and recovery

See [optional Testnet hosting](deployment.md#optional-hosted-payloads-for-testnet-testing).
Back up the DB and profile, bootstrap migrations/grants, then deploy API and web together. Keep
immutable payload reads available when rolling back writes; ledger replay cannot recover payload
bytes. The preserved local branch is a code fallback, not a substitute for a database backup.
