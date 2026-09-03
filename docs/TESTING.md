# Testing

## Local checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:smoke
```

`package:smoke` starts from the publishable package manifests rather than workspace links. It builds
and packs `core`, `sdk`, and `cli`, proves the tarballs are reproducible and contain no `workspace:`
dependency, then installs them into an isolated offline consumer and exercises their types, ESM
exports, binary and an offline CLI command. CI runs this in a separate fresh-checkout job so a stale
local `dist/` cannot hide a missing build step. See
[`runbooks/npm-packages.md`](./runbooks/npm-packages.md) for retained artifacts and release gates.
The isolated type/runtime consumer also imports strict verification reports, schema-catalog types
and the prepared-transaction envelope API so a missing public export fails the release gate.

The independent verifier is checked separately:

```bash
cd verifier-go
go test ./...
go test -race ./...
go vet ./...
go build ./...
```

Use the repository-pinned Go 1.26 line. XCS v0.1 freezes IDNA to Unicode 15.0.0; the verifier checks
the selected `x/net/idna` table version and fails closed if a newer toolchain selects different
tables.

The TypeScript generative suite is deterministic. Its JSON/JCS and UID properties run 512 generated
cases with seed `0x58435301` by default. Schema resolution exhausts all supported inheritance depths
from 1 through 16 and the 256/257 resolved-descriptor boundary with deterministic fixtures. Failures
print the property, seed, case index and generated input context. Reproduce or widen the configurable
properties without changing committed fixtures:

```bash
XCS_GENERATIVE_SEED=0x58435301 XCS_GENERATIVE_RUNS=512 \
  pnpm --filter @xcs-protocol/core exec vitest run test/generative-conformance.test.ts
```

`XCS_GENERATIVE_SEED` must be a non-zero unsigned 32-bit integer and
`XCS_GENERATIVE_RUNS` must be between 1 and 10,000. Turbo includes both variables in its test cache
key. SDK and indexer mutation matrices use their own fixed seed and do not read these overrides.

API tests also exercise the disabled-by-default operational snapshot: bearer authentication occurs
before database reads, scrapes remain outside public budgets and OpenAPI, PostgreSQL failures do not
leak details, invalid projection evidence has a distinct stable code, and process counters classify
only bounded rate-limit and server-resolver outcomes. The JSON contract is `schemaVersion: 2`; the
Prometheus rendering is derived from the same collection and includes durable fenced halt counts.
Repository tests reject partial or unsafe durable gauges and inconsistent incident history while
accepting profiles that have not yet published status/checkpoint rows.

The v0.1 revision 12 manifest is consumed independently by TypeScript and Go. In addition to schema,
UID, JCS and claim cases, it covers inherited payload resolution, exact 1 MiB payload and 256-byte URI
boundaries, strict public network profiles and anchor normalization, pinned Unicode 15 UTS #46
authority normalization, port and IP boundaries, canonical
path/query retrieval URLs, Ripple/Unix/ISO conversion and lifecycle state precedence. Its shared
retrieval cases also require identical `valid`, `unavailable`, `tampered`, and `invalid` outcomes,
including invalid-URI precedence and the 1 MiB plus one byte rejection. Schema-catalog vectors add
the 256/257 combined relation-closure boundary and shared-ancestor deduplication. Raw JSON-token
vectors prove that both runners accept semantically integral decimal and exponent spellings,
normalize accepted `-0` values to positive zero before applying field bounds, and reject non-finite
`1e400` as `JSON_NON_IJSON_NUMBER`. A runner fails if a declared handler is missing or an undeclared
vector file is present.

Go's normal test command executes every registered fuzz seed, including those loaded from the
committed conformance vectors. Run the same bounded campaigns as CI when changing strict JSON,
canonicalization or UID behavior:

```bash
cd verifier-go
go test -run=^$ -fuzz=^FuzzStrictJSONCanonicalRoundTrip$ -fuzztime=10s -parallel=2 ./xcs
go test -run=^$ -fuzz=^FuzzSchemaUIDDeterminism$ -fuzztime=10s -parallel=2 ./xcs
```

Fuzz caches are local build artifacts and must not be committed. Reduce and review every real
counterexample in both implementations. If it only exposes a missing example of frozen v0.1
semantics, add a language-neutral v0.1 vector and increment the manifest revision. If fixing it
would change historical validity, a stable error code or derived bytes, create a new protocol
version and activation profile instead. Existing vector IDs and expected results are immutable.

The deterministic browser gate requires Chromium once, then runs without Testnet, PostgreSQL or
wallet keys:

```bash
pnpm --filter @xcs-protocol/web exec playwright install chromium
pnpm test:e2e
```

The browser gate also exercises the loopback-only local payload store: it rejects issuance without
the explicit no-PII acknowledgement, permits a `prenom` field containing a deterministic fictitious
value only after that acknowledgement, proves fail-closed behavior after the local bytes disappear,
then issues, accepts and verifies the same canonical IPFS-addressed payload from that browser. It
also proves that an external IPFS CID absent from the store is not presented as browser-local.

CLI unit integration covers the equivalent headless boundary without a live server. It proves the
profile-bound transaction semantics, mandatory catalog download for every `Credential*` operation,
pre-autofill `xcs:prepared` context commitment, deterministic single-signature verification, final
readiness-before-`ledger_current` order, WSS policy and strict UTF-8/BOM handling. A wallet mutation,
unsigned or invalid signature, invalid current-ledger response or regressed checkpoint is rejected
before relay. Live wallet/HSM and public Testnet evidence remain separate gates.

Web unit tests compose the six self-configuring XRPL Connect adapters and all eight when the optional
Xaman and WalletConnect public identifiers are present. They also normalize sign-only `tx_blob` and
signed `tx_json` responses and reject mismatched artifacts, hashes, signatures, signer addresses or
reviewed fields before persistence/submission. These tests never call `signAndSubmit` and do not
replace real wallet compatibility evidence.

The wallet compatibility unit gate also covers all three native Credential transaction types. It
keeps GemWallet available for schema-registration `Payment`, rejects its known pre-XLS-70
`Credential*` path, and maps only the exact nested legacy codec error to the stable
`WALLET_CREDENTIAL_TRANSACTION_UNSUPPORTED` diagnostic. Playwright exercises that early rejection
with a GemWallet-identified adapter and proves that no transaction preview, wallet signature or
ledger submission occurs. This regression test explains a known incompatibility; it does not claim
that another wallet has passed the manual Testnet matrix.

## Integration tiers

1. Pure unit, conformance, generative and fuzz-corpus tests require no network.
2. Database integration tests require an isolated PostgreSQL 18 server and an admin URL configured
   with `XCS_TEST_DATABASE_URL`; the suite creates and removes its own random databases.
3. Indexer fixture tests consume captured public-ledger bundles produced only after exact agreement
   between both configured `rippled` sources.
4. Testnet E2E requires a real network profile and externally controlled funded wallets.
5. The deterministic Playwright browser gate uses explicitly development-only issuer and subject
   wallets plus a fake XRPL client. It proves exact application transitions and indexed business
   evidence, including the subject's payload consent, separate trust-neutral acknowledgement, and
   the two readiness gates around wallet signing and blob persistence/submission. It also reloads a
   signed IndexedDB operation and proves that retransmission requires fresh readiness, uses no new
   wallet signature, preserves recovery material when blocked and removes it after terminal XRPL
   validation. A corrupted stored expiry is rejected before reconciliation and leaves the exact blob
   untouched;
   real Xaman, Crossmark, GemWallet, WalletConnect, Ledger, Xyra, Otsu and MetaMask Snap signing
   remains a separate manual Testnet gate. WalletConnect candidates must additionally prove the XRPL
   Testnet namespace and native `Credential*` support; QR/deep-link discovery alone is insufficient.

Never use a production seed in tests. A Testnet reset invalidates the activation profile and
requires a new fixture/profile rather than editing historical expected UIDs.

The destructive PostgreSQL integration suite receives an **admin database URL**, creates random
databases named `xcs_it_<uuid>` or `xcs_api_it_<uuid>` and the fixed `xcs_indexer`, `xcs_api` and
`xcs_monitor` roles, then removes those exact objects after each suite. Fixed roles are cluster-wide,
so use only a disposable dedicated CI/test cluster; never point this suite at a shared or production
PostgreSQL instance.

```sh
XCS_TEST_DATABASE_URL=postgres://postgres:postgres-integration-password-0001@127.0.0.1:5432/postgres pnpm test:postgres
```

It requires PostgreSQL 18 and proves that the single current-schema baseline initializes an empty
database and is safe to run again. Schema assertions cover discovery indexes, projection-integrity
constraints and durable `indexer_incidents`. Bootstrap cases prove idempotent role configuration,
SCRAM-SHA-256 passwords and the exact application-table permissions.

The indexer cases also cover `shared` versus `exclusive-profile` database initialization,
lease takeover/fencing, projection rollback, restart/idempotence, transaction-root persistence, and
equal timestamp-free digests across two replays. They provision the fixed runtime roles in the
isolated cluster, prove column-level permission boundaries, finite connection limits and monitoring
membership, and verify SCRAM-SHA-256 password verifiers. Concurrent exclusive-profile
initialization admits exactly one profile, while the fenced lease cases reject stale writers before
projection persistence. Two replays with different source tips must stop at the same
quorum-verified index/hash boundary; the unit suite separately proves that a tip advancing during
replay cannot move that boundary. The complete-bundle case captures a deterministic four-ledger
bundle, validates and opens it
independently twice, and runs the normal worker through schema registration, six Credential
creations, acceptance and all six deletion causes. Both empty projections must match the pinned
complete digest and exact rows. This exercises the real bundle pipeline locally; a reviewed capture
from public Testnet remains separate release evidence.

The API cases initialize another empty database. They prove that authoritative
read-only snapshots decode database time through the real driver and least-privilege role; execute
the operational metrics SQL and runtime type normalization, including `schemaVersion: 2` halt
history; serialize concurrent pin-quota reservations through a `SERIALIZABLE` challenge-row lock
without advisory locks; and execute the recursive schema-catalog CTE against a real 256/257-node
DAG, shared ancestor and corrupted cycle, proving deduplication, termination and explicit overflow
rather than truncation. Normal `pnpm test` skips PostgreSQL integration cases when the admin URL is
absent; CI runs them as a required separate job.

The database unit suite exercises the shared `SERIALIZABLE` helper independently: it retries the
complete unit for SQLSTATE `40001` and `40P01` with bounded full-jitter delay, does not retry an
unrelated database error, and stops at the five-attempt default budget.

## Captured ledger bundles

Capture begins at the immutable profile activation ledger and stops at an explicit target. The tool
stores normalized ledger headers and every public transaction/metadata object in that range, plus
public operator labels. It omits RPC URLs and local credentials, but the on-ledger evidence can
contain Memos, URIs, public keys, signatures and personal identifiers. Treat the complete bundle as
public data, review it before publication, and never put secrets or sensitive claims on XRPL.

```sh
export XCS_FIXTURE_TARGET_LEDGER_INDEX=123456
export XCS_FIXTURE_OUTPUT=./fixtures/testnet-pilot
export XCS_FIXTURE_PRIMARY_OPERATOR='XRPL Commons'
export XCS_FIXTURE_SECONDARY_OPERATOR='Independent Operator'
pnpm --filter @xcs-protocol/indexer fixture:capture
```

Validate a bundle offline against the exact profile file and its byte-level digest:

```sh
export XCS_FIXTURE_BUNDLE=./fixtures/testnet-pilot
export XCS_FIXTURE_BUNDLE_SHA256='<bundleDigest printed by fixture:capture>'
pnpm --filter @xcs-protocol/indexer fixture:validate
```

The same artifact can drive the normal replay worker and an empty PostgreSQL projection without
either live RPC URL. Set `XCS_REPLAY_FIXTURE_BUNDLE` and
`XCS_REPLAY_FIXTURE_BUNDLE_SHA256`, then run the documented `replay` command; its immutable target is
the last ledger committed by the bundle.

The manifest format is `xcs-ledger-bundle/1`. Each ledger is exact canonical JSON compressed as a
separate gzip member and protected by compressed and uncompressed SHA-256 digests stored in
canonical, compressed index chunks. The compact manifest binds the ordered chunks, so capture is not
limited by one monolithic list. Validation also requires the externally recorded SHA-256 of the
exact canonical `manifest.json` bytes; this root digest transitively binds the profile, range,
indexes and every ledger file. The directory inventory is strict, and any extra file, symlink or
missing ledger is rejected. Manifest, index, compressed-ledger and decompressed-ledger sizes are
bounded independently to limit hostile artifact memory use. Operator labels are audit metadata, not
proof of operational independence; release evidence must identify and review both operators
separately.
