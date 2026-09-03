# XCS implementation plan

This plan takes XCS from the current Testnet alpha to an accountless public Testnet beta that
organizations can use to discover and register schemas, issue native XRPL Credentials, and inspect
exact verification evidence without giving XCS custody of their signing keys or claims. It is
outcome-driven: a milestone is complete only when its exit criteria are demonstrated.

## Product outcome

An organization must be able to complete this flow:

1. define and locally validate an XCS schema;
2. register it on the intended XRPL network through an externally controlled wallet or signer;
3. build a canonical, integrity-bound credential payload and publish it to an approved public
   location;
4. create the native Credential, let its subject accept it, and later revoke or remove it;
5. let an independent verifier reconstruct the same schema and lifecycle state from validated
   ledgers and report payload integrity separately from issuer trust.
6. expose the result through one Explorer, Studio and Developers site without creating a Commons
   issuer directory or a public subject feed.

The reference service remains non-custodial and reproducible. A self-hosted indexer processing the
same validated ledgers must reach the same protocol result as the shared service.

## Accepted beta product boundaries

- XCS v0.1 normative semantics are frozen. Product/API work must not alter historical schema
  validity, UID bytes, payload interpretation or lifecycle projection.
- EAS and EASScan are UX references only; the protocol remains native XRPL Credentials plus XCS.
- All valid permissionless schemas and aggregate statistics are publicly discoverable.
- Credential lookup is exact by shared generation ID, transaction hash or complete
  issuer/subject/schema tuple. There is no public subject feed, account-wide Credential enumeration
  or claims search. A future browsable Credential catalog needs a separately designed opt-in signal.
- Commons presents addresses and four-dimensional verification without issuer badges, ranking or a
  universal trust decision.
- The beta uses issuer-hosted HTTPS payloads, unit issuance through the pinned XRPL Connect
  sign-only boundary, and no XCS account or multi-tenant backend. Its eight-adapter factory is not a
  claim that every WalletConnect-discovered wallet supports XRPL Testnet or native Credentials.
- One site contains Explorer, Studio and Developers surfaces. Its public integration contract is
  REST-first; GraphQL is deferred until real usage demonstrates a need.
- The initial pilot covers course participation/completion and diploma-style credentials.
- Commons hosts the shared web, dual-source indexer, API and PostgreSQL cache, but no signing keys or
  claims. Independent operators can reconstruct the same ledger-derived state.

These choices are recorded in [`ADR 0002`](./adr/0002-public-product-and-discovery.md).

Before the irreversible beta ceremony, [`ADR 0003`](./adr/0003-disposable-controlled-testnet-registry.md)
allows one private staging profile, `commons-testnet-xcs-v0.1-controlled-pilot`, whose registry is
still controlled. The profile and its fresh database are disposable and cannot be promoted; this
operational exception changes no v0.1 semantics or beta exit criterion.

## Current implementation evidence

The repository now contains the frozen v0.1 specification and conformance contract, strict
dual-`rippled` preflight/quorum, a fenced PostgreSQL writer,
transaction-root checkpoints, fail-closed repeatable-read API guards, quorum-verified bounded
empty-database replay, least-privilege database roles, and a timestamp-free projection digest. The
browser submission RPC is configured separately from the two private indexer sources.
Every new browser signature is gated by a profile-bound authoritative readiness snapshot immediately
before wallet invocation and again before a returned artifact can be retained or submitted. The web
pins `xrpl-connect@1.0.0-rc.0`, registers Xaman, Crossmark, GemWallet, WalletConnect, Ledger, Xyra,
Otsu and MetaMask Snap when their required public configuration is available, and invokes only
`sign()`. It normalizes `tx_blob` or signed `tx_json`, checks hash, signature, signer address and
reviewed-field equality, then persists and submits itself; `signAndSubmit` is outside the accepted
boundary.
Recovery first binds the decoded blob to its stored hash, expiry, account, transaction type and any
explicit network ID. It then reconciles that hash, requires another readiness snapshot and reasserts
the local business lock immediately before any signed-blob retransmission; a failed gate retains the
blob for a later retry without reopening the wallet.
Unit/conformance suites cover the deterministic protocol, source normalization, worker, API, CLI
and browser flow; CI contains a PostgreSQL 18 job for database-bootstrap, role-permission,
fencing, replay, and operational-snapshot scenarios. The complete-replay case captures one integrity-bound synthetic
ledger bundle, validates it twice, runs both copies through the normal worker into empty projections,
and requires the same fixed full-projection digest and all six deletion causes.
The v0.1 conformance manifest revision 12 adds network-profile, boundary, schema-resolution,
schema-catalog, Ripple-time, lifecycle and payload-retrieval cases. The catalog cases fix the
combined relation closure at 256 unique schemas, reject 257, and count shared ancestors once. Raw
JSON-token cases require TypeScript and Go to accept semantically integral decimal and exponent
spellings, normalize accepted `-0` values to positive zero before field validation, and reject
non-finite `1e400` as `JSON_NON_IJSON_NUMBER`. Shared payload vectors cover the four retrieval
outcomes, tampering, exact 1 MiB limits, HTTPS authority parsing and inherited claims, including
fail-closed incomplete catalogs. Deterministic TypeScript properties exercise strict JSON/JCS, UID
invariants and every supported inheritance depth; SDK/indexer matrices cover memo encoding and
hostile normalized XRPL shapes; and two bounded native Go fuzz targets cover canonical JSON and UID
preimages. The independent Go library now
resolves inheritance and supersession from a caller-supplied, previously validated catalog and can
use that resolution while checking credential payload claims. It also independently converts Ripple
time and projects Credential lifecycle state from the shared vectors. The indexer and API reject
ledger-derived indices, `Expiration` and close-time values outside the native uint32 range, and the
API rejects contradictory generation timelines including in aggregate statistics. Seeds and
configurable run counts are reproducible and part of the Turbo cache key.
The generated database baseline mirrors those boundaries with storage constraints and adds a
durable halt record keyed by profile and fenced writer epoch. The indexer writes status and incident
atomically; its runtime role can append but not rewrite incidents, while the API role can only read
them. `XCS_DATABASE_SCOPE` also makes the storage assumption explicit: `shared` permits multiple
profiles, `exclusive-profile` rejects any different existing profile, and the controlled pilot
requires the exclusive mode.

PostgreSQL bootstrap treats fixed cluster-wide roles as a dedicated-cluster boundary. It applies the
single current-schema baseline, serializes role changes, removes unexpected direct memberships,
normalizes role attributes and current-database grants, and writes SCRAM-SHA-256 passwords. A
`pg_hba.conf` role-to-database SCRAM allowlist remains required defense in depth.

Runtime database serialization no longer relies on advisory locks. Concurrent profile
initialization and pin reservation use the same `SERIALIZABLE` helper with five bounded,
full-jitter retries for serialization failures or deadlocks; pinning locks the consumed challenge
row, while ledger persistence locks the active fenced lease row with `FOR UPDATE` before committing
projections, checkpoint and status together.

Portable cross-process evidence is now explicit. Core and the independent Go implementation both
strictly validate `xcs-schema-catalog/1`, recompute each registration UID and resolve the complete
topological lineage; successful verification reports also pass an exact four-dimensional runtime
parser. The authoritative API now exports a no-store catalog for one schema and its complete lineage;
the Go CLI consumes catalog bundles for claims and payload checks. Combined relation closures are
bounded to 256 unique schemas in transport, with no change to historical on-ledger validity. The
bundle is internally consistent rather than self-authenticating: CLI output says that XRPL inclusion
was not independently verified, and an independent consumer still needs trusted checkpoint/source
or validated ledger transaction and metadata evidence.

The TypeScript CLI can download a catalog, validate inherited payloads and verify a profile's
activation anchor. Offline preparation now rejects generic XRPL transactions with a profile-bound
semantic validator and requires an authoritative catalog for every native `Credential*` operation.
It commits the exact profile SHA-256 and checkpoint in an `xcs:prepared` Memo before autofill and
writes the resulting transaction to an `xcs-prepared-transaction/1` artifact. Submission accepts
only a cryptographically valid XRPL single-signature, rejects multisign in the alpha, obtains final
readiness and then checks `ledger_current` before the first relay side effect. Non-loopback endpoints
require WSS, and profile/API artifacts use strict UTF-8/JSON handling that cannot silently discard a
BOM. The public package smoke compiles and imports these contracts from two byte-reproducible tarball
builds in an isolated offline consumer.

The reference product now also has REST reads for aggregate statistics, schema search and
registration activity, exact Credential generation timelines, and exact XCS transaction
projections, plus an authoritative complete-lineage schema catalog. The Nuxt application exposes
corresponding Explorer pages, a Studio workflow index and a Developers page. Its guided schema
editor includes course-completion and diploma templates, while advanced JSON remains available for
schemas outside the scalar-field editor. The generated database baseline includes its supporting
indexes and projection-boundary checks.

This does **not** close milestones 0–2: PR review/merge, a real blackholed Testnet profile, proof that
the two providers are independent, live PostgreSQL execution, real adapter-by-adapter XRPL Connect
transactions, captured ledger fixtures, and two-entity pilot evidence remain external gates. The RC
peer range (`xrpl ^3 || ^4`) does not yet declare XCS's `xrpl` 5 combination; its bundle cost,
WalletConnect CSP assets and the temporary Otsu availability workaround also remain release risks.

The controlled-pilot deployment configuration is now explicit: it is guarded by an exact policy
and acknowledgement, uses a Commons-operated primary, Ripple's public Testnet secondary and XRPL
Labs' browser-only submission endpoint, and requires profile
`commons-testnet-xcs-v0.1-controlled-pilot` plus a fresh private-staging database. Those public
services have no XCS SLA. Evidence from this deployment is useful for staging drills and wallet
feedback, but it is not blackhole, provider-retention, public-beta or Mainnet evidence.

The browser Playwright journey is deterministic and synthetic: it replaces the wallet, RPC, API and
payload host with fakes and covers schema registration, issuance, and subject acceptance through
separate issuer and subject accounts. The acceptance path keeps payload consent distinct from the
subject's generation-bound acknowledgement of an issuer whose trust status is `unknown`, then
requires exact indexed `accepted` evidence. Negative cases also prove that an unavailable or
mid-wallet-degraded indexer produces no XRPL submission or retained signed blob. Reload recovery
cases use a syntactically valid synthetic blob to prove that an unavailable indexer prevents
retransmission while preserving recovery material, that a ready indexer completes recovery without
another signature, and that inconsistent stored metadata is rejected before reconciliation. It is useful CI
evidence for application state transitions, but it is not evidence for browser-extension
compatibility, issuer-hosted CORS behavior, a live Commons deployment or validated Testnet pilot
transactions.

The public `core`, SDK, and CLI manifests now have a coordinated artifact contract. A fresh-checkout
CI job builds and twice-packs all three, rejects non-reproducible or workspace-linked tarballs, and
smokes them from an isolated offline consumer. This is release evidence, not publication evidence:
the npm scope bootstrap, first public versions, Trusted Publisher records, and human approval of a
staged alpha remain external organization gates.

## Scope boundaries for v0.1

The following are deliberately not v0.1 promises:

- no global directory that declares which issuers are trustworthy;
- no storage of seeds, private keys, or HSM credentials in XCS;
- no private-credential or personal-data storage on public IPFS;
- no Mainnet launch before the Testnet, interoperability, operations, and security gates below;
- no in-place migration from the historical Nuxt MVP database;
- no public subject feed, account-wide Credential enumeration or claims search;
- no Commons issuer badge, ranking or universal trust directory;
- no XCS user or organization account and no GraphQL API in the beta;
- no HSM integration, batch issuance, private claims, multi-tenant administration, or Mainnet
  activation in the first controlled pilot.

## Milestone 0 — adopt the reference baseline

**Goal:** make one reviewed repository state the unambiguous implementation baseline.

Work:

- review and merge the replacement pull request with the database incompatibility explicitly
  acknowledged;
- decide the disposition of the historical implementation pull requests without deleting their
  branches or history;
- confirm ownership and licensing of the imported implementation and historical documents;
- enable required reviews, signed commits, protected `main`, and required CI checks;
- remove obsolete deployment secrets from repository and hosting settings after confirming that no
  active legacy deployment depends on them;
- convert each later milestone in this document into tracked issues with an owner and evidence link.

Exit criteria:

- `main` contains the monorepo baseline and its CI is green;
- reviewers have approved the breaking database and API replacement;
- the legacy database remains backed up and untouched for rollback;
- unresolved historical work is linked from, or explicitly superseded by, tracked decisions.

Rollback: revert the merge and run the former application only against its untouched legacy
database. Never point the former application at the new projection database.

## Milestone 1 — establish the immutable Testnet profile

**Goal:** replace all placeholder network data with an independently auditable Testnet activation.

Work:

- treat any run of `commons-testnet-xcs-v0.1-controlled-pilot` as disposable pre-beta staging; do
  not reuse its registry, profile, activation boundary, events or PostgreSQL database for this
  milestone;
- perform the dedicated registry-account blackhole ceremony in
  `config/networks/README.md`, using `ACCOUNT_ZERO` unless a documented reason requires
  `ACCOUNT_ONE`, and retain public transaction and ledger evidence;
- confirm that the required Credentials amendment is supported and enabled on the selected network;
- record the exact activation ledger index and hash after the ceremony;
- publish `config/networks/testnet.json` and its SHA-256 digest through at least two organization
  channels;
- provision a fresh PostgreSQL database and a validated-ledger source that retains the full range
  from activation;
- add a profile smoke check that validates the registry account flags, activation hash, amendment,
  network ID, and source history before indexing starts;
- require two independently operated ledger providers and compare every normalized ledger header,
  transaction root, transaction, and metadata object before projection;
- reject missing transaction arrays, metadata, hashes, duplicate transaction hashes, discontinuous
  transaction indexes, and provider disagreement instead of treating incomplete input as empty;
- persist an indexer state (`starting`, `catching_up`, `ready`, or `halted`) and make authoritative API
  reads return `503` immediately while the indexer is halted or lacks quorum;
- bootstrap a fresh XCS database; prove transaction rollback, restart, bootstrap idempotency, and
  deterministic replay against real PostgreSQL.

Exit criteria:

- two reviewers independently reproduce the profile validation;
- the indexer starts at the activation boundary, reaches the Testnet tip, and remains ready;
- a clean rebuild produces identical schema UIDs, events, projections, and checkpoint hashes;
- reusing a `profileId` with any changed immutable profile field causes startup to fail closed;
- a Testnet reset or corrected profile field is published under a new `profileId` and activation
  boundary rather than changing the prior profile;
- omitting or changing any ledger transaction or metadata field on either provider halts ingestion
  before the checkpoint advances;
- two fresh databases replayed from activation produce the same timestamp-free projection digest.

Rollback: discard the new projection database and profile deployment. A faulty or reset Testnet
profile is replaced by a new profile ID and activation boundary, never edited in place.

## Milestone 2 — prove the complete Testnet journey

**Goal:** demonstrate the real user journey with released wallets and validated ledger results.

Work:

- execute a wallet matrix for each configured Xaman, Crossmark, GemWallet, WalletConnect, Ledger,
  Xyra, Otsu and MetaMask Snap adapter covering schema registration, `CredentialCreate`,
  `CredentialAccept`, and both issuer- and subject-initiated deletion;
- for every WalletConnect candidate, prove the XRPL Testnet namespace and native Credential support;
  QR/deep-link pairing alone is not a passing result;
- cover rejection, wallet cancellation, account or network changes, lost submission acknowledgements,
  expiry, restart recovery, and duplicate submission attempts;
- verify that every UI preview exactly matches the signed blob and that every success shown to the
  user is `validated` with `tesSUCCESS`;
- capture the exact public ledger transactions and metadata for deterministic indexer regression
  tests, review the bundle for on-ledger identifiers, and bind it to a published manifest digest;
- add PostgreSQL integration tests that bootstrap an empty database, ingest fixtures,
  restart at checkpoints, and rebuild projections;
- add browser tests with a deterministic mock signer, while retaining the manual real-wallet matrix
  as a release gate;
- publish issuer, subject, and verifier walkthroughs using disposable Testnet accounts only.

Exit criteria:

- two independent account pairs complete register → issue → accept → verify → delete;
- the TypeScript and Go verifiers agree on every captured payload and schema;
- recovery after browser, API, indexer, and database restarts is demonstrated;
- all automated checks run in CI and the manual wallet evidence records adapter, wallet application
  or extension, browser and hardware-device versions as applicable.

## Milestone 3 — prove frozen v0.1 interoperability

**Goal:** demonstrate that independent implementations reproduce the frozen v0.1 contract without
changing its normative semantics.

Work:

- expand language-neutral vectors for malformed JSON, Unicode, nested schemas, inheritance, UID
  boundaries, payload linkage, time boundaries, and lifecycle deletion metadata;
- add property and fuzz testing for strict JSON, JCS, schema resolution, payload parsing, and XRPL
  metadata extraction;
- replay the same ledger fixtures through clean TypeScript projections and compare their complete
  output, not only counts;
- submit or adopt the `xrpl.js` URI-length correction; keep the documented 128-byte interoperability
  guard until a released dependency is verified at the normative 256-byte boundary;
- obtain review from at least one implementer who did not write the TypeScript core and record any
  clarification that does not change validity or derived bytes in the ADR/specification;
- version the conformance vectors and define the compatibility policy for future protocol profiles.

The first local milestone slices now cover additive boundary and shared schema-resolution vectors,
deterministic TypeScript properties, SDK/indexer mutation matrices, bounded Go fuzzing, independent
Go inheritance/supersession resolution, inherited-claim payload checks, payload byte/URI boundaries,
Ripple-time conversion, lifecycle-state parity, shared retrieval classification, all six deletion
causes, and complete capture/validation/replay comparison through a synthetic ledger bundle. The
remaining interoperability gates are running that same complete-projection proof against a reviewed
public Testnet capture, the URI-length released-dependency gate, and external implementation review.

Exit criteria:

- TypeScript and Go pass every v0.1 conformance vector with identical validity outcomes and stable
  error codes; diagnostic messages and paths need not be identical;
- any proposal that changes historical schema validity, UID bytes, payload interpretation or
  lifecycle projection is assigned to a new protocol version and activation profile;
- an external implementation can derive a known UID and verify a known Credential from the published
  specification and vectors alone.

## Milestone 4 — make the service operable and defensible

**Goal:** run the shared reference service predictably without turning it into a trust authority.

Work:

- expose metrics for ledger lag, checkpoint hash, continuity failures, invalid registrations,
  submission outcomes, payload fetch failures, database saturation, rate limits, and disk usage;
- define availability and freshness objectives, alerts, dashboards, and an incident runbook;
- test backup restoration, full replay, provider failover, database outage, malformed-ledger input,
  and safe rollback in a staging environment;
- add container, dependency, license, secret, and software-bill-of-materials checks to release CI;
- sign release tags and container artifacts and record build provenance;
- make Nitro the source of truth for browser security headers; deploy one CSP in report-only mode,
  require the edge to overwrite rather than append policy values, and keep HSTS scoped to the
  current host without `includeSubDomains` or `preload`;
- validate the report-only policy with `curl`, browser DevTools and real transaction matrices for
  every enabled XRPL Connect adapter, including WalletConnect modal styles/images, then promote the
  same single policy to enforcement only after all application-owned violations and wallet
  regressions are resolved; retain `connect-src https:` for permissionless issuer payload hosts,
  retain same-origin-only `hid`/`usb` for Ledger, and do not add a CSP report collector without a
  separate privacy review;
- perform an internal threat-model and defensive design review, and close release-blocking findings
  before exposing the pilot; this review does not replace the final post-freeze audit in milestone 6;
- document data retention, public-payload constraints, abuse handling, and incident contacts.

The first local operability slices are implemented: process liveness and deployment readiness have
separate contracts, all probe outcomes are non-cacheable and outside request budgets, Compose checks
API liveness, and the web service waits for that health signal. A separately authenticated,
disabled-by-default JSON `schemaVersion: 2` snapshot and Prometheus endpoint now expose ledger lag,
checkpoint hash/age, the active halt, durable fenced halt count/latest evidence,
accepted/rejected registrations, logical database size, cluster client connections, rate-limit
outcomes and optional server payload-resolution outcomes without recording request identifiers. The
coverage metadata does not mislabel browser-local submissions, physical disk capacity or
postgres.js pool saturation as observed. Client-submission observability, staging recovery drills,
review of production objectives/alerts, and release signing/provenance evidence remain open; the
presence of local monitoring configuration does not satisfy those operational exit criteria.

Exit criteria:

- an operator restores the service from backups and validated ledgers within the agreed recovery
  objectives;
- stale, discontinuous, or inconsistent ledger data never produces an authoritative active/valid
  response;
- the public web origin exposes one enforced CSP and one host-scoped HSTS value, with recorded curl,
  DevTools and real enabled-wallet evidence from the promoted policy;
- the threat model, audit report, operational dashboards, alerts, and incident procedures are
  reviewed and linked from the release record;
- production services hold no XRPL signing secret.

## Milestone 5 — deliver the public Explorer, Studio and Developers beta

**Goal:** let a visitor discover public schemas and exact evidence, and let pilot entities issue
repeatably without accounts or protocol-specific integration work.

Work:

- present public permissionless schemas, aggregate statistics and exact Credential evidence without
  exposing a subject feed, account-wide listing or claims index;
- provide exact Credential resolution from a shared generation ID, transaction hash or complete
  issuer/subject/schema tuple;
- organize one accountless site into Explorer, Studio and Developers surfaces with a REST-first
  integration path;
- retain the schema-authoring workflow that validates locally, previews canonical bytes and memo
  size, and records the resulting registration operation;
- build the controlled pilot on the SDK `Signer` boundary using the pinned XRPL Connect
  sign-only factory for low-volume, unit issuance; Xaman and WalletConnect require their public
  application identifiers, and only adapters certified by the real Testnet matrix may be promoted;
- retain deterministic payload generation, issuer-hosted HTTPS publication and the mandatory proof
  that published bytes match the URI before issuance;
- support idempotent resumption and sanitized local receipts for each unit operation;
- add organization-local audit exports containing schema, operation, ledger, hash, actor, and outcome
  metadata, but never seeds or private claim data by default;
- add subject acceptance links and clear pending/active/expired/deleted lifecycle guidance;
- publish REST, SDK and CLI guidance alongside the application;
- run a course participation/completion pilot and a diploma-style pilot with issuer-controlled HTTPS
  hosts.

Public subject feeds, Commons trust badges, XCS accounts, GraphQL, offline/HSM signing, batch
issuance, multi-operator administration, and multi-tenant hosting are outside the beta. Adding any
of these changes the privacy, signing or authorization surface and requires a new product decision
and threat-model review.

Exit criteria:

- a new issuer follows published documentation without repository maintainer intervention;
- a visitor can discover a public schema and open exact shared Credential evidence without creating
  an account;
- neither the site nor API enumerates a subject's Credentials or stores issuer payload claims;
- retrying any interrupted operation cannot create an untracked duplicate or report a provisional
  result as final;
- signing keys remain within the issuer- or subject-controlled wallet;
- pilot feedback is resolved or explicitly deferred before a stable release.

Wallet integration rollback removes the optional public Xaman/WalletConnect identifiers or
restricts the reviewed factory to the passing adapters. It requires no protocol, network-profile or
database-schema rollback and must never replace `sign()` with `signAndSubmit`.

## Milestone 6 — final audit and Mainnet go/no-go

**Goal:** decide whether a separately activated Mainnet profile is justified.

Required gates:

- the frozen v0.1 contract is independently implemented;
- real-wallet Testnet matrices and issuer pilots are complete;
- an independent defensive security audit covers the exact frozen commit, container digests, signer
  adapters, indexer quorum, payload resolver, and authorization surfaces shipped after milestone 5;
- security review findings are closed and operational recovery drills pass; any material code or
  configuration change after the audit triggers a documented delta review or re-audit;
- privacy, legal, support, abuse, and issuer-trust presentation have organization approval;
- dependency and wallet versions supporting native Credentials are pinned and monitored;
- a separate Mainnet registry ceremony, profile, database, and activation plan have two-person review;
- rollback and incident authority are named before activation.

Mainnet UIDs and state must be reconstructed under the new Mainnet profile. Testnet registry data,
activation values, projections, payload assumptions, and identifiers are never promoted or copied as
Mainnet truth.

## Execution order and ownership

Milestones 0 and 1 are sequential. Within a milestone, independent workstreams can proceed in
parallel, but their exit criteria are shared gates.

| Workstream           | Primary responsibility                                                     |
| -------------------- | -------------------------------------------------------------------------- |
| Protocol             | specification, profiles, conformance vectors, versioning decisions         |
| Data and operations  | database, indexer, API, deployment, replay, monitoring, backups            |
| Issuance experience  | SDK, CLI, web, wallet contracts, issuer and subject workflows              |
| Security and privacy | threat model, review, release controls, public-payload and trust messaging |
| Program leadership   | owners, pilot entities, evidence, release gates, Mainnet decision          |

The critical path is:

```text
baseline adopted
  → disposable private controlled-registry staging
  → immutable Testnet profile
  → real wallet and ledger journey
  → frozen v0.1 interoperability proof
  → operational readiness and pre-pilot review
  → public Explorer/Studio/Developers beta and issuer pilots
  → final frozen-artifact audit
  → Mainnet go/no-go
```

No milestone is closed from code completion alone. The issue closing it must link the exact test,
ledger, deployment, review, or pilot evidence that satisfies every exit criterion.
