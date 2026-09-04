# Reference architecture

XCS separates deterministic protocol logic from I/O and signing.

```text
Wallet/HSM ──signs──> SDK / CLI / Nuxt site
                         │ signed transaction
                         ▼
                  validated XRPL ledgers
                    │              │
             rippled source A  rippled source B
                    └──── normalized quorum ────┘
                                  │ full transaction + metadata
                                  ▼
                     fenced single-writer indexer (`xcs_indexer`)
                                  │ atomic event/checkpoint/status
                                  ▼
                         PostgreSQL projection <──SELECT── API (`xcs_api`)
                                                            │
                                               verifier / explorer / apps
```

## Boundaries

- `core` is deterministic and browser-safe. It does no network or database I/O.
- `sdk` understands XRPL transaction JSON and delegates signing through an interface.
- `indexer` is the only writer of schema and lifecycle projections. A PostgreSQL lease epoch fences
  stale replicas, and authoritative reads require the live writer's exact agreed checkpoint.
- `api` is read-only except for the optional, isolated Testnet pinning surface.
- `web` connects wallets through the client-only XRPL Connect adapter factory and submits through
  the explicitly public `XCS_PUBLIC_RPC_URL`; `XCS_RPC_URL_PRIMARY` and
  `XCS_RPC_URL_SECONDARY` remain server-only and are never forwarded automatically into browser
  configuration. The public submission RPC is not a source of authoritative verification.
- `verifier-go` is intentionally independent and consumes the same language-neutral vectors.

The shared public service is convenient, not authoritative. XRPL Commons operates the reference
web, indexer, API and PostgreSQL deployment for the Testnet beta, but a self-hosted indexer
reconstructing the same validated ledgers must produce the same protocol result.

## Private controlled-pilot exception

The pre-beta staging profile `commons-testnet-xcs-v0.1-controlled-pilot` is the sole exception to
the blackholed-registry deployment invariant. As recorded in
[`ADR 0003`](./adr/0003-disposable-controlled-testnet-registry.md), it requires the explicit
`controlled-testnet-pilot` registry policy plus the
`DISPOSABLE_PROFILE_AND_DATABASE` acknowledgement, Testnet network ID `1`, and a dedicated fresh
PostgreSQL projection. The exception changes operational trust only; it does not change any XCS
v0.1 parsing, UID, payload, registration or lifecycle result.

That staging deployment is private and non-promotable. Its registry controller may retain master,
regular-key, SignerList or delegate authority, although the account must remain able to receive a
one-drop Payment. The controller can therefore change account controls or impede future
registrations, so the profile cannot supply the neutrality evidence required of the public beta.

The pilot indexer compares a Commons-operated complete-history primary with Ripple's public Testnet
secondary. The browser submits through XRPL Labs' public Testnet endpoint. Endpoint URLs are not
profile fields: the two public services carry no XCS SLA, and the browser endpoint never
participates in authoritative reads or quorum. Before beta, Commons creates and audits a different
blackholed registry, publishes a new profile and activation boundary, and rebuilds into another
fresh database. No pilot registry, profile or projection is renamed or promoted.

## Product surface and discovery

The accountless Nuxt application exposes four primary entries: Explorer for public schemas and
aggregate statistics, Create for wallet-based schema and unit-issuance workflows, Verify for exact
Credential evidence, and Docs for REST, SDK and CLI integration material. The Create and Docs
entries continue to use the `/studio` and `/developers` implementation routes respectively. EAS and
EASScan inform interaction design only. XCS continues to use native XRPL Credentials and the frozen
v0.1 protocol described in `spec/XCS-0001.md`.

Discovery is hybrid. Every valid permissionless schema is public and discoverable, but Credentials
are resolved only from exact shared coordinates: generation ID, transaction hash or the complete
issuer/subject/schema tuple. The reference service exposes no subject feed, account-wide Credential
enumeration or claims search. A future browsable Credential catalog would require an explicit,
separately specified opt-in signal. Aggregate counts contain no payload claims.

This boundary limits privacy amplification; it does not make public ledger identifiers private.
Schema visibility is not endorsement. The API and site expose the issuer address and independent
verification dimensions without Commons badges, rankings or universal trust decisions. See
[`ADR 0002`](./adr/0002-public-product-and-discovery.md).

The implemented REST discovery surface exposes aggregate checkpoint statistics, paginated schemas,
schema-only registration activity, exact generation timelines and exact XCS transaction
projections. Text and publisher searches return schemas only; a complete 256-bit hexadecimal value
may resolve an exact schema UID, Credential generation ID and transaction hash. These reads use the
same repeatable-read snapshot and fail-closed checkpoint guard as verification. None reads payload
claims or creates an issuer/subject Credential listing.

`GET /v1/networks/:network/schemas/:uid/catalog` exports the target's complete,
registration-evidenced lineage as `xcs-schema-catalog/1`. The API derives it inside the same
fail-closed repeatable-read snapshot, binds it to the authoritative checkpoint, and marks the
response `no-store`. Core, the CLI and the independent Go verifier each revalidate the profile,
registration coordinates, recomputed UIDs and relation graph before resolving inherited fields. A
combined `extends`/`supersedes` closure contains at most 256 unique schemas; the API queries one
lookahead row and fails explicitly instead of truncating. This is a portable-transport bound, not a
new on-ledger registration-validity rule.

The portable bundle proves internal consistency, not XRPL inclusion by itself: it carries no ledger
header chain, transaction metadata or inclusion proof. The reference CLI trusts its configured
authoritative API projection. An independent verifier must instead trust a checkpoint/source out of
band or verify the corresponding validated ledger evidence before claiming on-ledger registration.

## Persistence

Raw XCS-relevant events are append-only. Current schema and Credential views are rebuildable
projections. A checkpoint stores network, ledger index/hash, parent, close time, transaction count,
and transaction root. Advancing the checkpoint, writing events, and publishing the agreed indexer
status occurs in one fenced SQL transaction. PostgreSQL is an interchangeable local read model, not
the source of protocol truth; XRPL validated ledgers remain the source.

The public API reads ledger-derived rows and their integrity evidence from one repeatable-read
snapshot. It fails with `503` if the writer lease expired, either source disagreed, the status and
checkpoint differ, transaction-root evidence is absent, or the checkpoint is stale.

An optional internal metrics reader uses its own read-only repeatable-read transaction and a secret
that is distinct from the Nuxt SSR identity. Its JSON `schemaVersion: 2` snapshot and Prometheus
endpoint combine rebuildable database gauges with process-local API counters and label their scope
explicitly. They expose the active halt plus the count and latest durable fenced halt incident, but
no request identity or payload content; none of these signals is protocol truth. Client-side wallet
submissions, physical disk capacity and API pool saturation remain outside the API snapshot because
the process does not reliably observe them.

The generated `0000_baseline.sql` creates the complete current schema for a fresh XCS projection
database. It is not compatible with the database used by the historical `XRPL-Commons/xcs` MVP.
Because this application has not entered production, schema changes regenerate that baseline and
require recreating the disposable projection database. At production launch the baseline freezes;
subsequent changes must use reviewed forward migrations and preserve mixed-version reads.

The [database model](./database.md) provides a Mermaid relationship diagram, a table-by-table catalog,
the main integrity boundaries and the runtime-role access model.

The baseline includes the discovery indexes, projection-integrity constraints and
`indexer_incidents`, keyed by profile and writer lease epoch. A fenced writer records halt status and
the incident in one transaction; runtime grants make the history append-only for `xcs_indexer` and
read-only for `xcs_api`. A failed incident insert rolls back the halt update rather than publishing
partial operational evidence.

PostgreSQL uses four fixed trust identities. `xcs_admin` owns the schema and runs the one-shot
bootstrap; it is absent from runtime services. `xcs_indexer` receives
`SELECT`/`INSERT` on append-only projections and column-limited `UPDATE` only for indexer status and
Credential lifecycle transitions. `xcs_api` receives projection `SELECT` and CRUD on isolated
pinning tables. `xcs_monitor` inherits `pg_monitor` but no application-schema DML. Runtime roles
cannot create objects, have finite connection limits, and can connect only to the selected XCS
database.

The PostgreSQL administrator and reviewed baseline are inside the trust boundary. Runtime identities
remain outside it: they own no database objects and receive no DDL capability. Because fixed roles
are cluster-wide, bootstrap requires an explicit dedicated-cluster acknowledgement. It serializes
concurrent runs, removes unexpected runtime-role memberships, resets role attributes and timeouts,
revokes broad access in the current database, grants only the permissions above and writes
SCRAM-SHA-256 password verifiers. It does not attest or repair unrelated databases or protect
against a malicious administrator.

Runtime concurrency therefore uses native transactions and row locks. A shared helper runs profile
initialization and demo-pin reservation at `SERIALIZABLE`, retrying serialization failures and
deadlocks with bounded full jitter within a five-attempt budget; pin reservation also locks its
challenge row. Every ledger-persistence transaction first locks and validates the active writer
lease row with `FOR UPDATE`, then commits projections, checkpoint and status together, so a lease
takeover cannot race a projection write. No database URL or password is logged.

PostgreSQL contains ledger-derived schemas, lifecycle events, current projections, checkpoints and
optional demo-pinning administration rows. It contains no XRPL signing key and the Commons beta does
not ingest or persist credential claims. Public credential payloads remain exact canonical HTTPS
documents on issuer-controlled infrastructure.

`XCS_DATABASE_SCOPE=shared` permits several immutable network profiles in one projection database.
`exclusive-profile` rejects initialization when any different profile is already present. The
disposable controlled-pilot policy requires `exclusive-profile`, preventing its staging history from
sharing a database with another profile.

A maintenance replay has a content-addressed upper bound: the operator supplies a ledger index and
hash, both sources quorum-verify that ledger, and the worker never processes beyond it even if the
live tips advance. Consequently two rebuilds can compare deterministic digests for the same finite
ledger history instead of racing a moving network tip.

## Submission

Transaction builders return unsigned semantic JSON. The application autofills fees, sequence and
`LastLedgerSequence`, previews the complete transaction, and asks an external wallet to sign. XCS
calls XRPL Connect `sign()` only, normalizes a returned `tx_blob` or signed `tx_json`, verifies its
derived hash, signature, optional signer address and exact transaction-field equality, persists the
resulting hash/blob, submits it itself, and waits for a validated result. It never delegates
submission through `signAndSubmit`; a provisional submission response is never treated as success.

The hosted site requires `GET /v1/networks/:profile/readiness` immediately before invoking the
wallet and again after the wallet returns but before persisting or submitting the blob. That route
uses the same repeatable-read, DB-time lease, quorum, checkpoint-root and freshness checks as
authoritative reads. The diagnostic `/status` route and public submission RPC are never fallback
authority. This is a product safety boundary, not a normative dependency of core XCS or the generic
SDK. The API marks every readiness outcome `private, no-store`, the browser explicitly bypasses its
cache, and the deployment ingress must preserve the header and never cache or synthesize the route.
Recovery first decodes the stored blob and matches its derived hash, `LastLedgerSequence`, account,
transaction type and any explicit `NetworkID` against the journal. Only then may it inspect that
hash against XRPL without a readiness proof, because the read has no ledger side effect. If the
transaction is still unvalidated, the browser must obtain a fresh readiness proof and reassert its
IndexedDB business lock immediately before retransmitting the exact stored blob. Any failed
integrity or readiness proof leaves the blob recoverable and creates no submission.

The headless CLI applies the same boundary across an offline signer. `tx prepare` first proves that
the transaction is one of the profile-bound XCS operations. Every `Credential*` operation must also
obtain and validate the referenced authoritative schema catalog. The CLI commits the exact profile
SHA-256 and checkpoint digest in an `xcs:prepared` Memo **before** autofill, then writes the final
transaction to an `xcs-prepared-transaction/1` envelope. The external signature therefore protects
the profile/checkpoint context together with `Fee`, `Sequence` and `LastLedgerSequence`.

`tx submit --prepared` requires a cryptographically valid XRPL single-signature, rejects multisign
in this alpha and permits no non-signature field mutation. Immediately before its first relay side
effect it obtains final non-cacheable readiness and only then reads `ledger_current` to prove the
window remains open. Non-loopback CLI XRPL endpoints require WSS, and profile, envelope, catalog and
API JSON use strict UTF-8/JSON parsing that does not silently discard a BOM. The envelope contains
public review material rather than a key; the signed blob remains an executable authorization and is
never written to the sanitized operation journal.

The Testnet beta performs one wallet operation at a time through the pinned
`xrpl-connect@1.0.0-rc.0` boundary. Its factory covers Xaman, Crossmark, GemWallet, WalletConnect,
Ledger, Xyra, Otsu and MetaMask Snap; Xaman and WalletConnect are omitted when their optional public
application identifiers are unset. This is an adapter surface, not a promise that every discovered
wallet supports XRPL Testnet and native Credential transactions. The beta has no XCS account,
server session, batch issuer, team or multi-tenant authorization layer. Recovery state and sanitized
receipts stay in the browser's IndexedDB; clearing site data removes that local history. Credential
payloads are published by the issuer over HTTPS and verified immediately before issuance. Commons
never receives a signing seed or private key.
