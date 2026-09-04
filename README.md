# XCS Protocol

XCS is an open schema and verification layer for native [XRP Ledger Credentials](https://xrpl.org/docs/concepts/decentralized-storage/credentials). It defines how schemas are registered, how their identifiers are derived, how off-ledger JSON is bound to a Credential, and how an indexer reconstructs lifecycle state.

This repository contains the XCS v0.1 specification and its reference implementation. The historical input document remains available as [`XCS_draft0.pdf`](./XCS_draft0.pdf); [`spec/XCS-0001.md`](./spec/XCS-0001.md) is the normative source for implemented v0.1 behavior. Its normative semantics are frozen: a change to schema validity, UID bytes, payload interpretation or lifecycle projection requires a later protocol version and a separately activated profile.

## Status

XCS v0.1 is alpha software intended for XRPL Testnet. The protocol, SDK, dual-source indexer,
read API, CLI, and issuer/subject playground are implemented, but the repository deliberately ships
without a live network profile. Do not use the example profile on Mainnet: its registry address and
activation ledger are invalid placeholders. The next product target is a public Testnet beta operated
by XRPL Commons, not a Mainnet launch.

The implementation never needs an XRPL seed. Applications construct transactions, then delegate signing to a wallet or an injected signer controlled by the issuer or subject.

The headless offline flow validates that a transaction is one of the profile-bound XCS operations,
requires authoritative schema-catalog evidence for every native `Credential*` operation, and commits
the exact profile/checkpoint context in a signed `xcs:prepared` Memo before relay. It supports
cryptographically verified XRPL single-signatures only in this alpha; see the offline-signing
runbook for the complete readiness and expiry sequence.

The public product takes UX inspiration from EAS and EASScan, not protocol semantics. One site uses
four simple entries—Explorer, Create, Verify and Docs—while retaining native XRPL Credentials.
Public discovery is hybrid: schemas and aggregate statistics are discoverable, while Credentials
remain exact lookups by shared generation, transaction or tuple; there is no subject feed or
account-wide enumeration. Commons assigns no issuer badge or universal trust decision. These
accepted product boundaries are recorded in
[`ADR 0002`](./docs/adr/0002-public-product-and-discovery.md).

## Repository map

- `packages/core`: deterministic parsing, canonicalization, schemas, UIDs and payload verification.
- `packages/sdk`: profile-bound XRPL transaction validation, builders and reliable submission
  primitives.
- `packages/cli`: local, non-custodial command-line workflows.
- `packages/db`: PostgreSQL schema, fresh-database bootstrap and least-privilege roles for a
  rebuildable local projection; see the [database model](./docs/database.md) for the table map.
- `apps/indexer`: validated-ledger ingestion and XCS projections.
- `apps/api`: read-only schema/catalog, credential and verification API.
- `apps/web`: accountless Nuxt 4 Testnet application for exploration, issuance and verification.
- `verifier-go`: independent conformance verifier.
- `conformance`: language-neutral test vectors.

## Prerequisites

- Node.js 24 LTS or 26
- pnpm 10
- Go 1.26 for the independent verifier
- PostgreSQL 18 for API/indexer integration
- Docker Compose 2.24.4 or newer for the self-hosted stack and its production secret overlay

## Developer validation

```bash
pnpm install
pnpm verify
(cd verifier-go && go test ./...)
```

These commands validate the source tree; they do not start a usable indexer. A real Testnet network
profile, PostgreSQL 18, and two independently operated, complete-history `rippled` WSS endpoints
must be configured before the services can run. The API defaults to `http://localhost:3001` and the
Nuxt application to `http://localhost:3000`. The full Compose startup and optional demo-pinning
procedure is in [`docs/runbooks/deployment.md`](./docs/runbooks/deployment.md).

For manual Testnet issuance without setting up an HTTPS payload host, the development-only browser
store can be enabled with `XCS_LOCAL_PAYLOAD_STORE=1`; see
[`apps/web/README.md`](./apps/web/README.md#local-browser-payload-store). It is local to one browser,
expires after 24 hours and is not Commons-hosted or publicly verifiable.

The reference deployment uses `xcs_admin` only for idempotent schema and role bootstrap,
`xcs_indexer` for bounded projection DML, `xcs_api` for projection reads plus optional pinning CRUD,
and `xcs_monitor` for PostgreSQL metrics without application-table DML. Provisioning is intentionally
cluster-wide and requires a PostgreSQL cluster dedicated to XCS. A rotation is disruptive: it
quarantines runtime logins and disconnects non-administrator database sessions before restoring the
audited roles.
`XCS_PUBLIC_RPC_URL` is a separate browser-visible submission endpoint; never put either private
indexer quorum endpoint or its credentials in that variable.

PostgreSQL is not a credential authority and does not make Commons the custodian of issuer data. It
is the reference implementation's local query cache: any organization can self-host the stack,
replay the same validated ledgers, and compare a deterministic projection digest. The Commons beta
uses issuer-hosted HTTPS payloads and does not store claims; signing keys remain in issuer/subject
wallets. Protocol and CLI support for IPFS remains available outside that hosted beta boundary.

For the database and indexer workflow, see [`docs/runbooks/indexer.md`](./docs/runbooks/indexer.md).
For Prometheus/Grafana signals and recovery objectives, see
[`docs/runbooks/monitoring.md`](./docs/runbooks/monitoring.md).
For external wallet or HSM preparation without giving XCS a key, see
[`docs/runbooks/offline-signing.md`](./docs/runbooks/offline-signing.md).
For commands and test tiers, see [`docs/TESTING.md`](./docs/TESTING.md). The reproducible tarball gate,
one-time npm scope bootstrap, and OIDC staged-release procedure are documented in
[`docs/runbooks/npm-packages.md`](./docs/runbooks/npm-packages.md); the three public package names
must not be presented as registry-installable until that external bootstrap is complete.

The outcome-based path from this Testnet alpha to organizational issuance and a possible Mainnet
decision is tracked in [`docs/implementation-plan.md`](./docs/implementation-plan.md).

## Security and privacy

- Never place a seed, private key, signed private document, or production secret in this repository.
- XCS identifiers and native Credentials are public ledger data.
- Public schemas are permissionless and discoverable; publication is not Commons endorsement.
- The public reference API deliberately provides exact Credential lookup only; it does not expose a
  subject feed or enumerate every Credential attached to an account.
- Issuer-hosted Testnet payloads are public and must contain no personal or sensitive data.

Report vulnerabilities according to [`SECURITY.md`](./SECURITY.md).
Release gates and dependency-specific constraints are tracked in [`docs/known-limitations.md`](./docs/known-limitations.md).

## License

Code and documentation in this repository are licensed under MIT unless a file says otherwise.
