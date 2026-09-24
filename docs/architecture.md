# Architecture

XCS separates deterministic protocol rules from ledger I/O, storage, and signing.

```text
issuer/subject wallet -> unsigned transaction from SDK/web/CLI -> XRPL
                                                               |
                                           two rippled sources |
                                                               v
                                                    apps/indexer (writer)
                                                               |
                                                    PostgreSQL projection
                                                               |
                                            apps/web (Nitro): /v1 API + UI
                                                               |
                                                        browser/verifier
```

## Ownership

Two deployable applications, one shared schema folder, and a library that neither application
imports. See [ADR 0004](./adr/0004-two-standalone-apps.md).

- `apps/indexer` is the projection writer and the only normal writer to protocol projections. It
  advances only on validated ledger evidence agreed by its configured sources, and it owns the
  database tooling: migration generation, migration application and one-shot bootstrap.
- `apps/web` is one Nitro server with two responsibilities on one origin. Its `server/` half reads
  the projection and fetches off-ledger payloads for verification, failing closed when projection
  evidence is stale or inconsistent; its `app/` half presents the workflows and connects user
  wallets. Browser-visible RPC configuration is separate from the private indexer sources.
- `db/` defines the rebuildable PostgreSQL model — Drizzle tables and generated SQL migrations. It
  is not a package: both applications compile it as their own source through the `#db/*` alias.
- `core` parses and validates protocol values. It is browser-safe and performs no I/O.
- `sdk` builds and validates XRPL transaction JSON and submits signed blobs. It never owns keys.
- `cli` is a thin command layer over core and SDK.

The applications do not import `core` or `sdk`. Each carries hand-maintained copies of the protocol
code it needs, every file headed with its origin; `packages/core` remains the reference
implementation and the place a protocol change lands first. The mirroring rule is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

PostgreSQL itself is provisioned outside this repository. The committed Compose stack is a
local-development convenience, not a deployment topology.

## Trust boundaries

XRPL validated ledgers are authoritative for schema registrations and Credential lifecycle. PostgreSQL is replaceable cache state. HTTPS/IPFS payload bytes are untrusted until their URI digest, envelope coordinates, and schema claims all verify.

Commons may operate a convenient public indexer and API, but organizations can run the same open-source stack. Commons does not issue on their behalf, hold signing keys, or turn schema publication into endorsement.

## Verification result

Verification is dimensional rather than a single trust badge. The verifier checks:

- schema registration and UID;
- native Credential existence and lifecycle;
- URI integrity against exact payload bytes;
- issuer, subject, and schema linkage inside the payload;
- claims against the resolved schema.

An unavailable payload is distinct from a tampered payload. A cryptographically valid Credential does not prove that the issuer is trustworthy.

## Operational projection

The indexer is the only normal writer to protocol projections. Checkpoint, events, and status move atomically under a fenced writer lease. The web app's read API opens a consistent snapshot and returns `503` when the writer lease, source agreement, checkpoint, transaction-root evidence, or freshness requirements fail.

The controlled Testnet pilot is disposable. It must not be promoted to Mainnet or presented as a neutral permanent registry. See [ADR 0003](./adr/0003-disposable-controlled-testnet-registry.md).
