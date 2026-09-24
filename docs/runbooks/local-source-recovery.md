# Local source recovery — 2026-09-15

Historical incident record for the deployments recovered on September 15–21, 2026. Commands,
package names and grants below describe those revisions, not current deployment instructions.
Issue #28 moved the API into Nuxt and split publication privileges into `xcs_payload_writer`.
For current builds, rollout and rollback use [deployment](./deployment.md) and
[ADR 0005](../adr/0006-nuxt-api-boundary.md).

The running local HTTPS site was built from `/private/tmp/xcs-pr22-ready`, whose source files had
expired. The top-level checkout is an older implementation and must not replace that deployment.

The durable development checkout is now `/Users/sanka/dev/xcs-protocol/.data/xcs-live`.
It was cloned locally from `fix/pr22-ready` (`3fced395`), without modifying the original checkout.
Newer web application files, configuration, assets and documentation were recovered from the
running `xcs-local-site-web-1` container. The deployed core bundle differs only by the public
`payloadDigest` export, restored in source. The deployed SDK source map supplied the exact newer
`submission.ts`. No wallet profiles, environment secrets or database contents were copied.

Recovered changes predate the current wallet fix. Git diff against the PR therefore includes both
recovered work and the new fixes; do not treat the whole diff as newly authored work.

## Payload API recovery — 2026-09-21

The deployed API's readable JavaScript modules and declarations were used to restore the missing
hosted-payload service, repository, resolver, HTTP routes, configuration and startup wiring. The API
declares its existing SDK dependency explicitly. The recovered database schema, runtime grants and
original migrations `0001_hosted_payloads` / `0002_hosted_payload_locator_compatibility` are restored
alongside the source. Their SQL bytes match the deployed migrations; do not reformat or rewrite them.
The original `0000` baseline is unchanged. Existing deployed databases already have these migrations.

The restored service keeps the deployed authorization boundary: Testnet allowlist, canonical payload
and schema checks, a cryptographically valid matching `CredentialCreate`, fresh indexed creation
evidence, 64 KiB limit, quotas and immutable content. Legacy 20-character
locators remain readable; new publications use 18 characters. No private keys are handled by the API.

Hosted Testnet publication no longer rejects claims based on field names such as `prenom`,
`firstname` or `email`. Claims must still match the registered schema. Use synthetic data only:
payloads are public, and accepting a field name does not establish that its value is non-personal.
The separate demo-pinning and browser-local test-storage policies are unchanged.

The following rebuild commands were used for that recovered revision only:

```sh
pnpm install --frozen-lockfile
pnpm --filter @xcs-protocol/api... build
docker build -f docker/Dockerfile.node --build-arg XCS_PACKAGE=@xcs-protocol/api -t xcs-api:hosted-source-recovery .
docker build -f docker/Dockerfile.node --build-arg XCS_PACKAGE=@xcs-protocol/web -t xcs-web:publication-recovery .
```

For a fresh database or an older baseline-only deployment, run the existing secret-file bootstrap
workflow before starting the recovered API. It applies migrations and provisions append-only
`xcs_api` access to the hosted tables. Back up an existing database first; never reset the projection
or delete payloads as part of this rollout. Roll back application images without reversing these
compatible table additions. Use the same fixed HTTPS origin and existing secret files.

API hosting configuration: `XCS_HOSTED_PAYLOADS_ENABLED=true`,
`XCS_PUBLIC_PAYLOAD_BASE_URL` (exact short HTTPS origin), `XCS_HOSTED_PAYLOAD_NETWORKS`
(allowed Testnet profile IDs) and `XCS_PAYLOAD_STORAGE_IP_HASH_SECRET` (at least 32 bytes).
The web's `NUXT_PUBLIC_PAYLOAD_BASE_URL` must match the API origin. Keep secrets out of source and
command output. GET `/p/:locator` serves immutable JSON; POST `/v1/payloads/:locator` publishes only
after validating its signed transaction and indexed evidence.

The web now rejects oversized hosted payloads before signing and keeps consented recovery jobs
across reloads. See the web README for retry, retention and cleanup semantics.

Verification on 2026-09-21:

- Web: 244 unit tests and Nuxt typecheck passed; API: 231 unit tests; DB: 38 unit tests.
- Five API integration tests passed against an isolated PostgreSQL 18 instance, including bootstrap,
  append-only permissions, hosted idempotency/quotas, legacy locators and size constraints.
- API/DB builds and typechecks passed. `pnpm --filter @xcs-protocol/db db:generate` reported no drift.
- Both Docker images built from source with the frozen lockfile. The local API and web were replaced
  without replacing the database or indexer; the API still reported signing readiness `ready`.
- Brave, with normal certificate validation and the real Crossmark extension, showed Crossmark
  available on the first chooser opening. This is discovery evidence, not a new credential-signing
  compatibility claim; Crossmark 0.2.19 still rejects native Credential transactions.
- A recovery drill used an existing validated Testnet `CredentialCreate` blob fetched with
  `binary:true`, and its real hosted payload. Reloading the recovery UI and retrying against the
  rebuilt API returned 200. The unsigned-copy/signed-journal interruption case also recovered;
  browser IndexedDB confirmed terminal signature cleanup. These were idempotent publication retries,
  not new ledger transactions or simulated wallet approvals. The credential remained ACTIVE with
  VALID schema and payload when checked without a connected wallet.

## Historical recovery verification (2026-09-15)

Original repair scope:

- Wallet pending/connected/error states, bounded cancellation, and Crossmark session invalidation.
- Official adapter/Vue-binding regression coverage; removal of obsolete rc.0 patch tests.
- Indexer normalization of synthetic API metadata, retaining strict canonical ledger comparison.

Use the existing local HTTPS Compose deployment and its private runtime env file. Do not copy
secrets into this checkout. Keep prior Docker images available for rollback; no ledger checkpoints
or PostgreSQL data should be reset for these repairs.

## Verification and limitations

- `pnpm --filter @xcs-protocol/web typecheck` passes.
- The web unit suite passes, including official Crossmark adapter + Vue binding integration
  against extension-transport test doubles, not injected production accounts.
- Wallet UI and essential schema/issue/accept/verify Playwright cases pass in the explicitly
  isolated browser test environment. These are not real extension approvals or live ledger writes.
- Production web and indexer Docker builds pass. Brave loads `/learn` with normal certificate
  validation (HTTP 200, TLS 1.3), no page errors and no production E2E adapter.
- The indexer resumed past ledger `20711127`; its API reports `catching_up` with no source error.
  Signing readiness remains blocked by the existing backlog. No checkpoint was skipped.
- The user's real Crossmark approval remains a manual retest. No wallet secrets were accessed.
- rc.2 declares an `xrpl` 3/4 peer range; this existing application uses `xrpl` 5. The tested paths
  pass, but the warning remains and does not establish compatibility for every supported wallet.

Rollback images remain `xcs-web:local-https` and
`sha256:f8fc6b5f4c758a6cbfa5f477d15ba6e7c63d45f94c057e214e3d13b261478ddd` (indexer).
Restore only the corresponding Compose image entry and recreate that service; leave databases,
profile files, wallet profiles and certificates untouched. The prior indexer image retains the
known synthetic-metadata divergence bug.
