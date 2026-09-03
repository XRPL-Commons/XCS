# Indexer runbook

## Before starting

1. Copy `.env.example` to `.env`, set PostgreSQL, and configure distinct
   `XCS_RPC_URL_PRIMARY`/`XCS_RPC_URL_SECONDARY` WSS endpoints operated independently.
   `XCS_INDEXER_DATABASE_URL` must authenticate as the least-privilege `xcs_indexer` role; keep
   `XCS_BOOTSTRAP_DATABASE_URL` confined to the bootstrap command.
2. Replace the example network profile with the audited profile for the current Testnet reset.
3. Confirm both `rippled` sources expose every validated ledger from the activation ledger. Clio is
   not yet a supported source for this alpha.
4. Bootstrap the fresh database, run the quorum preflight, then start the API and indexer:

```sh
pnpm --filter @xcs-protocol/db db:bootstrap
pnpm --filter @xcs-protocol/indexer preflight
pnpm --filter @xcs-protocol/api start
pnpm --filter @xcs-protocol/indexer start
```

The idempotent command applies the current generated baseline and then configures the three runtime
roles without printing database URLs or passwords. Run it only on a dedicated cluster: PostgreSQL
roles are cluster-wide even though the application grants are scoped to the selected database. This
pre-production baseline is not an upgrader. After a schema change, recreate the disposable
projection database and regenerate the baseline before bootstrapping it again.

The preflight checks network ID, contiguous retained history, the amendment, activation ledger and
selected registry policy on both sources. The default `blackholed` policy requires the complete
blackhole invariant. It prints no endpoint or credential.

### Disposable Commons controlled pilot

The private staging exception in
[`ADR 0003`](../adr/0003-disposable-controlled-testnet-registry.md) uses only profile
`commons-testnet-xcs-v0.1-controlled-pilot`, Testnet network ID `1`, and a new empty projection
database. It must set both exact values before `preflight` or `start`:

```sh
export XCS_REGISTRY_POLICY=controlled-testnet-pilot
export XCS_CONTROLLED_PILOT_ACK=DISPOSABLE_PROFILE_AND_DATABASE
```

In this mode the activation-bound `account_info` and every `account_objects` page must still be
validated and match the configured account, ledger index and ledger hash. `DepositAuth` or
`RequireDestTag` fails with `SOURCE_REGISTRY_NOT_RECEIVABLE`; master, regular-key, SignerList and
delegate authority are accepted only because this profile is controlled and disposable. The
normal policy remains fail-closed with `SOURCE_REGISTRY_NOT_BLACKHOLED`.

Use the Commons-operated complete-history source as primary and
`wss://s.altnet.rippletest.net:51233` as the Ripple-operated secondary. The latter is a public
service without an XCS availability or retention SLA; preflight must prove that it currently covers
the complete range from activation. Configure `wss://testnet.xrpl-labs.com/` only as the browser
submission endpoint, never as an indexer authority or quorum fallback.

Do not run this mode against a legacy, blackholed-profile or future-beta database. Captures and
digests from it remain labelled controlled-pilot evidence. Before beta, return to the default policy
with a different, independently audited blackholed registry, a different immutable profile ID and a
new empty database; never update this profile in place.

## Healthy state

Readiness requires matching normalized ledgers from both sources, a live fenced writer lease, the
configured amendment and activation hash, no ledger gap, and a fresh checkpoint whose index/hash
exactly matches the writer's agreed state and includes a transaction root.

Profile initialization uses a shared `SERIALIZABLE` helper that retries the complete transaction
after SQLSTATE `40001` or `40P01`
with bounded full jitter and a five-attempt default budget. Ledger persistence instead locks the
active lease row with `FOR UPDATE` and writes the projection, checkpoint and status in that same
transaction. Losing or expiring the lease therefore fails before a stale writer can persist the
next ledger.

Monitor checkpoint age, source RPC errors, invalid registrations, ingestion retries and projection failures. Payload retrieval is not part of indexing and cannot delay ledger progress.

## Recovery

- On process restart, resume from the persisted checkpoint and re-read that boundary ledger idempotently.
- On a gap, stop. Repair or switch to a complete-history source, verify the expected parent hash, then resume.
- On a projection bug, stop writes, deploy corrected deterministic code, truncate only rebuildable projections through an explicit maintenance procedure, and replay the append-only events.
- Never skip a missing ledger or replace an activation hash in place.

Every checkpoint in the current baseline has a transaction root. A projection created by an older
schema must be rebuilt into a fresh database before it can be served as authoritative.

Accepted schema events store the exact parsed JCS memo separately from the normalized schema used
for UID computation. A projection created by an older build that stored only the normalized
definition must be rebuilt from ledger evidence: an omitted `optional:false` marker cannot be
recovered from that old row, so its memo digest is not authoritative.

## Rebuild and deterministic comparison

`replay` is intentionally create-only: it refuses any profile that already has checkpoints, events,
schemas, or Credential projections. Point it at a bootstrapped empty database and supply
one immutable target boundary as both a ledger index and its 64-hex-character hash:

```sh
export XCS_REPLAY_TARGET_LEDGER_INDEX=123456
export XCS_REPLAY_TARGET_LEDGER_HASH=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
pnpm --filter @xcs-protocol/indexer replay
pnpm --filter @xcs-protocol/indexer projection:digest
```

Before projection advances, both configured sources must expose the target ledger and agree on its
normalized contents; its agreed hash must equal `XCS_REPLAY_TARGET_LEDGER_HASH`. An unavailable or
mismatched target fails closed. Once accepted, the target is fixed for the run: replay stops exactly
at `XCS_REPLAY_TARGET_LEDGER_INDEX` and releases its writer lease even when either source tip advances
during ingestion. A deliberately historical replay remains non-ready; it must not be presented as a
live effective-tip projection.

The digest covers immutable profile data, checkpoints, schema events/projections, and Credential
events/generations from a PostgreSQL repeatable-read snapshot. It excludes wall-clock timestamps,
writer status, pinning, and operational flags. Rebuild two independent empty databases against the
same target index and hash, then compare both the digest and row counts before accepting a profile
deployment. Comparing two runs that each selected their then-current moving tip is not reproducible
evidence.

CI applies this procedure to a deterministic synthetic bundle and pins its complete projection
digest, including all six Credential deletion causes. That proves the harness and persistence path;
release evidence must repeat it with the reviewed public Testnet bundle rather than treating the
synthetic digest as network evidence.

To replay a captured bundle without any RPC endpoint, supply its directory and the externally
recorded SHA-256 of its exact canonical manifest. The command derives the immutable target index/hash
from the bundle's last committed ledger and binds the evidence to the exact profile file bytes:

```sh
unset XCS_RPC_URL_PRIMARY XCS_RPC_URL_SECONDARY XCS_RPC_URL
export XCS_REPLAY_FIXTURE_BUNDLE=./fixtures/testnet-pilot
export XCS_REPLAY_FIXTURE_BUNDLE_SHA256='<bundleDigest printed by fixture:capture>'
pnpm --filter @xcs-protocol/indexer replay
```

`XCS_REPLAY_TARGET_LEDGER_INDEX` and `XCS_REPLAY_TARGET_LEDGER_HASH` may be omitted in fixture mode.
If either is supplied, both are required and must equal the bundle boundary. A profile byte-digest,
manifest digest, chunk, ledger, inventory or boundary mismatch stops before the first projection
write: fixture replay exhaustively validates the artifact before opening the empty projection. The
worker records the stable `FIXTURE_BUNDLE_*`/`REPLAY_TARGET_*` reason when it owns a lease.

## Capturing replay evidence

After both sources pass preflight, capture their agreed normalized ledgers from activation through
one explicit target. `fixture:capture` refuses a target beyond the effective quorum tip, an existing
output directory, non-distinct operator labels, a discontinuity or any source disagreement. It
writes through a temporary sibling directory and publishes the bundle path only after every ledger
and digest validates.

```sh
export XCS_FIXTURE_TARGET_LEDGER_INDEX=123456
export XCS_FIXTURE_OUTPUT=./fixtures/testnet-pilot
export XCS_FIXTURE_PRIMARY_OPERATOR='XRPL Commons'
export XCS_FIXTURE_SECONDARY_OPERATOR='Independent Operator'
pnpm --filter @xcs-protocol/indexer fixture:capture

export XCS_FIXTURE_BUNDLE=./fixtures/testnet-pilot
export XCS_FIXTURE_BUNDLE_SHA256='<bundleDigest printed by fixture:capture>'
pnpm --filter @xcs-protocol/indexer fixture:validate
```

Validation is offline and requires the exact `XCS_NETWORK_PROFILE`, bundle path and externally
recorded manifest digest. The compact manifest commits ordered, canonical index chunks; each chunk
commits a bounded group of ledger files, allowing long ranges without loading a monolithic index.
`fixture:validate` traverses all evidence, while `LedgerFixtureBundleSource` verifies the required
chunk and ledger lazily when integration tests feed the normal worker. Do not treat the self-declared
operator labels as proof that the two sources are independent. A bundle includes every public
transaction and metadata object in its range, including any on-ledger Memos, URIs, public keys,
signatures and identifiers; review it as public data before release. The strict inventory excludes
unrelated local files, and provider URLs, tokens or Testnet wallet seeds must never be added to the
bundle directory.

## Rollback

Application containers can roll back only to an image compatible with the current baseline. Before
production, a database-schema rollback means recreating and replaying the projection. After the
baseline freezes for production, forward migrations require an explicit tested rollback strategy.
On-ledger registrations cannot be removed; a normative error requires a new protocol
profile/version.
