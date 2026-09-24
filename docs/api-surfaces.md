# XCS API surfaces in Nuxt

The API exposes rebuildable, read-only XCS projections. Ledger-derived routes run in a read-only
repeatable-read snapshot and fail with `503` unless the indexer has a live writer lease, a fresh
checkpoint, and consistent dual-source evidence. The API is served by native Nitro handlers in `apps/web/server/routes`; there is no separate API
service. `/documentation` lists routes; `/documentation/json` serves their OpenAPI contract.

This REST API is the public integration contract for the accountless Testnet beta; GraphQL is not
part of the beta. XRPL Commons may operate a shared instance, but PostgreSQL remains a reconstructible
ledger projection rather than protocol truth. The API never accepts a signing seed or private key,
and it does not persist credential payload claims submitted for verification.
The separately enabled Testnet publication service below stores explicitly published public
payloads; it is not enabled by verification requests.

Nuxt serves `/v1/*`, `/p/*`, health and protected metrics on the site origin. Server-side page
requests call the same handlers locally; there is no private HTTP hop or shared SSR token.
`XCS_DATABASE_URL` is the read-only projection connection (`xcs_api`). Optional publication
and demo pinning require a separate `XCS_PAYLOAD_DATABASE_URL` (`xcs_payload_writer`), whose
writes are restricted to hosting and pinning tables. Neither pool can alter indexed evidence.

When the public API is behind a reverse proxy, set `XCS_TRUSTED_PROXY_CIDRS` to the exact IP/CIDR of
that proxy only after configuring it to remove any client-supplied forwarding headers and write its
own canonical `X-Forwarded-For`. With the variable unset, the server deliberately ignores forwarded
addresses and rate-limits by the direct peer. Wildcards and named proxy presets are rejected.
Catch-all IPv4 or IPv6 `/0` ranges are also rejected; keep every allowed range as narrow as the
actual ingress network.

## Deployment probes

`GET /health/live` and its compatibility alias `GET /health` report only that the API process can
serve requests. `GET /health/ready` additionally checks PostgreSQL plus every configured network's
live writer lease, dual-source agreement, checkpoint root and freshness. Use liveness to decide
whether to restart the container; use readiness to decide whether the deployment may receive
authoritative traffic. A catching-up or halted indexer must make readiness return `503` without
restarting an otherwise healthy API process.

All three probes return `Cache-Control: no-store` and are intentionally outside the public request
rate-limit budget so monitoring cannot make its own next check fail. Restrict direct probe access to
the load balancer and monitoring network at the ingress; this is especially important for
`/health/ready`, which performs database reads. The Compose healthcheck uses `/health/live` without
requiring a second service.

## Operational metrics

Set `XCS_METRICS_ENABLED=true` and a dedicated `XCS_METRICS_TOKEN` to expose
`GET /internal/metrics`. The token must contain 32–256 URL-safe characters and is presented as
`Authorization: Bearer <token>`. The route is absent
when disabled, hidden from OpenAPI, non-cacheable, and outside public request budgets. Restrict it
to the monitoring network at the ingress even though the token is mandatory.

The versioned JSON snapshot reports each enabled profile's source tips, ledger lag, current
checkpoint hash/age, active continuity halt, and accepted/rejected schema-registration totals. It
also reports cluster client-connection count, configured PostgreSQL connection ceiling, logical
database size, process-local rate-limit totals, and server-side payload-resolution outcomes. It
never stores an IP, client key, URI, issuer, subject, payload, or error message. If PostgreSQL is
unavailable, the route deliberately remains `200`, marks the database unavailable, and preserves
the process counters; `/health/ready` remains the deployment availability signal. The stable
`database.errorCode` distinguishes `DATABASE_UNAVAILABLE` from `METRICS_EVIDENCE_INVALID`; the
latter means PostgreSQL answered but its projection evidence could not be represented safely.

The response's `coverage` object is part of the honesty boundary. Continuity covers only the
currently durable halt, payload counters cover only the optional server resolver, and browser-local
XRPL submission outcomes are not visible to the API. `logicalSizeBytes` is not physical free disk,
and cluster connection count is not postgres.js pool saturation. Those missing signals require
separate infrastructure exporters or a privacy-reviewed design rather than invented API metrics.

## Discovery boundary

All valid permissionless schemas and aggregate network statistics are public. Schema visibility is
not Commons endorsement, and the API returns no issuer badge, ranking or universal trust decision.
Credential reads remain exact: the caller supplies shared generation, transaction or complete
issuer/subject/schema coordinates. There is no subject feed, account-wide Credential enumeration or
claims search. A future browsable Credential catalog requires a separately designed explicit opt-in
signal. See [`ADR 0002`](./adr/0002-public-product-and-discovery.md).

The Commons-hosted instance must leave `XCS_TRUSTED_ISSUERS` and `XCS_UNTRUSTED_ISSUERS` empty, so
its `issuerTrust` result remains `unknown`. A self-hosted verifier may configure those lists as its
own local policy; that result is not a Commons or protocol-level assertion.

## Discovery routes

The implemented discovery reads are:

| Route                                                            | Public result                                                                                                    | Pagination and scope                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/networks/:network/stats`                                | Schema/publisher totals, Credential generation lifecycle counts and the authoritative checkpoint                 | Aggregate only; lifecycle state is evaluated at checkpoint close time                                              |
| `GET /v1/networks/:network/schemas`                              | Valid schema projections, optionally restricted by exact `publisher`                                             | Opaque `cursor`; `limit` defaults to 20 and is capped at 100                                                       |
| `GET /v1/networks/:network/search?q=...`                         | Schema text/publisher matches, or exact hash matches for a schema UID, generation ID and indexed XCS transaction | `q` must be trimmed, contain a letter/number and have 2–128 characters; `limit` defaults to 20 and is capped at 50 |
| `GET /v1/networks/:network/activity`                             | Accepted and rejected schema-registration events in reverse ledger order                                         | Schema registrations only; opaque `cursor`; `limit` defaults to 20 and is capped at 100                            |
| `GET /v1/networks/:network/credential-generations/:generationId` | One exact generation, its checkpoint-relative lifecycle state and validated event timeline                       | No subject or issuer listing                                                                                       |
| `GET /v1/networks/:network/transactions/:transactionHash`        | One exact indexed XCS transaction with an optional schema registration and Credential events                     | Credential events use a node-index cursor; `limit` defaults to 20 and is capped at 100                             |

Search deliberately changes behavior by input shape. A 64-digit hexadecimal value is treated only
as an exact UID/generation/transaction coordinate. A classic XRPL address returns schemas published
by that address, never Credentials where it is issuer or subject. Other text searches only schema
names and descriptions. Search is a bounded entry point: it returns `hasMore` but has no cursor; use
the schema list for paginated browsing. All routes above validate the same live checkpoint and
projection evidence as existing authoritative reads and return `503` rather than serve stale or
inconsistent data. They return ledger metadata only and never fetch or return payload claims.

## Signing readiness

`GET /v1/networks/:network/readiness` is the profile-bound authorization for starting a wallet
signing side effect. A `200 ready` response contains the authoritative checkpoint after validating
the live writer lease, dual-source quorum, checkpoint root and freshness. Invalid profile input
returns `400`, a missing profile returns `404`, exhausted request budget returns `429`, unavailable
authority returns `503`, and an unexpected server failure returns `500`.

Every outcome carries `Cache-Control: private, no-store`; the browser also requests `no-store`.
Ingresses and CDNs must preserve that response header and must never cache or synthesize readiness
responses. `/v1/networks/:network/status` remains diagnostic and may return `200` while the indexer
is starting, catching up, halted or no longer authoritative. `/health/ready` is a deployment-wide
load-balancer probe and is not a substitute for the per-profile decision.

Schema changes use reviewed migrations and an administrative bootstrap; never reset a running
projection merely to deploy Nuxt. See the [deployment runbook](./runbooks/deployment.md).

An organization can reconcile a schema registration transaction without receiving its full memo:

```text
GET /v1/networks/:network/schema-registrations/:transactionHash
```

The response contains `registration: null` until that transaction has been indexed. Accepted
registrations include the schema UID and the SHA-256 digest of the exact canonical registration-memo
JSON, before schema normalization; rejected registrations include only their protocol reason code.
`memoJson` is never exposed by this route.

Credential verification and demo pinning fail with `SCHEMA_PROJECTION_INVALID` and HTTP `503` when
an indexed schema definition, resolved field set, or inheritance lineage is inconsistent. They never
validate or pin a payload against a partial schema projection. Exact-schema, schema-list,
verification, and pinning reads load every claimed ancestor and its accepted registration event in
the same repeatable-read snapshot. The API recomputes every schema UID and every inherited field set
before trusting or exposing the stored projection.

## Payload verification outcomes

`POST /v1/verify` reports payload state independently as `valid`, `unavailable`, `tampered`,
`invalid`, or `not_checked`. A non-conforming native URI is `invalid`; DNS, timeout, transport,
redirect, and non-success HTTP failures are `unavailable`; more than 1 MiB of actually received
bytes is `invalid`; a digest mismatch is `tampered`; and digest-matching bytes still have to pass
UTF-8, strict JSON, JCS, envelope linkage, and resolved-claim validation before becoming `valid`.
Low-level network errors and payload contents are never copied into the report.

The resolver uses one five-second deadline across HTTPS DNS lookup, redirects, response headers and
body reading. It reads at most 1 MiB plus the byte needed to prove a size violation, preserves DNS
pinning and rejects private answers or unsafe redirects. `Content-Length` and `Content-Type` are not
used as normative evidence: either can be missing or inaccurate, while the received bytes and
on-ledger SHA-256 binding are authoritative. Issuers should still serve the JSON media type for
browser interoperability.

When the request supplies a parsed `payload` JSON value instead of `resolvePayload: true`, the API
recanonicalizes that value, then applies the same integrity-first classification and structural
validation as the retrieval path. This path cannot prove the caller's pre-parse byte order or detect
duplicate keys already discarded by an upstream JSON parser; use retrieval of the exact
issuer-hosted bytes when byte-level JCS evidence is required. Server-side retrieval remains disabled
by default and in the Commons-hosted beta configuration.

Demo pinning additionally requires a live indexer writer lease and a fresh, matching dual-source
checkpoint. Freshness is evaluated with PostgreSQL time, and every schema-ancestor ledger must fall
between network activation and that checkpoint. Authority failures return the same stable indexer
`503` errors as verification and occur before the challenge is consumed, quota is reserved, or
content is written.

Credential event history and exact-transaction responses expose the event's `ledgerHash`,
`transactionIndex`, and resulting `accepted` flag in addition to the transaction and credential
tuple. Transaction hashes supplied in uppercase are accepted and returned as lowercase hexadecimal.

## Optional hosted Testnet payloads

Disabled by default. Enable with `XCS_HOSTED_PAYLOADS_ENABLED=true`, a short HTTPS origin in
`XCS_PUBLIC_PAYLOAD_BASE_URL` (no path or trailing slash), comma-separated profile IDs in
`XCS_HOSTED_PAYLOAD_NETWORKS`, and a distinct `XCS_PAYLOAD_STORAGE_IP_HASH_SECRET` of at least
32 bytes. Docker uses the secret-file overlay described in the deployment runbook.
The origin must keep the complete credential URI within XRPL's 128-byte limit.

- `POST /v1/payloads/:locator` accepts `network`, `payloadBase64` and `signedTransactionBlob`.
  It verifies the signature, exact URI/digest, issuer, subject, resolved schema and indexed
  successful creation under fresh ledger evidence. Only Testnet network ID 1 is accepted.
- `GET /p/:locator` (and HEAD) serves the exact canonical bytes with an immutable cache header.
  Existing 20-hex locators remain readable; new publications use 18 hex characters.
- Maximum size is 64 KiB; publication is idempotent for the same transaction and content.
  Daily quotas are 50 publications per issuer and hashed requester IP. An existing locator
  cannot be overwritten with different bytes. Claims field names are not a privacy filter;
  publish only deliberately public, non-sensitive test data.

The payload and quota records persist in PostgreSQL. Include these tables in backups: replaying
XRPL cannot reconstruct off-chain payload bytes. Quota or availability failures can occur after
the ledger transaction succeeds; the browser's publication recovery retries the same signed
transaction without creating another credential. See [web recovery](../apps/web/README.md#hosted-https-payloads).

## Optional recipient and verifier APIs

These same-origin `/api` routes share the enabled issuer service and its restricted application pool.
They are private, `no-store` and `no-referrer`, with session authorization, bounded request bodies and
rate limits. Authenticated mutations require CSRF. They are separate from the public `/v1` contract.

| Route                                                     | Purpose                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/recipient/workspace`                            | Owned invitations, credentials and event notifications                       |
| `GET /api/recipient/verifiers`                            | Eligible approved verifier organizations                                     |
| `GET /api/recipient/credentials/:profileId/:generationId` | Owned exact credential and disclosure metadata                               |
| `GET …/payload`                                           | Explicit authenticated full payload review/report                            |
| `POST …/reconcile`                                        | Check exact indexed accept/reject/remove transaction                         |
| `GET /api/recipient/presentations`                        | Own grants, optionally filtered by profile/generation                        |
| `POST /api/recipient/presentation-challenges`             | Issue a five-minute, session-bound wallet challenge for exact sharing intent |
| `POST /api/recipient/presentations`                       | Create grant after fresh wallet proof; consume challenge atomically          |
| `POST /api/recipient/presentations/:id/revoke`            | Revoke own grant                                                             |
| `POST /api/presentations/resolve`                         | Explicit token resolution; full access rechecks audience and approval        |
| `GET /api/verifier/workspace`                             | Application status and metadata-only history                                 |
| `POST /api/verifier/applications`                         | Submit organization and review documents                                     |
| `GET /api/verifier/history.csv`                           | Approved actor's metadata export                                             |
| `POST /api/verifier/history/:id/presentation`             | Reauthorize and record reopening; empty JSON body                            |
| `POST /api/auth/link-handoff`                             | Same-origin invitation/presentation token cookie before login                |
| `POST /api/auth/link-handoff/consume`                     | Authenticated, CSRF-protected one-time cookie retrieval                      |

Bearer links use fragments, then explicit JSON POSTs, never token query parameters. Unknown/revoked
presentations are indistinguishable. Wrong-audience full grants disclose only the public projection.
See [recipient/verifier boundaries and limits](runbooks/recipient-verifier.md).

Presentation creation now requires `proof: { challengeId, signature, publicKey, scheme }` alongside
profile, generation, scope and optional designated organization. `scheme` is `ripple` or `otsu`, as in
wallet linking, but a wallet-link challenge cannot authorize sharing. Resolution adds `issuerAdmission`
(current portal status, organization and observation/review timestamps) and `holderProof` (dated
signature evidence, or `not_provided` for legacy links). These facts do not change issuer trust,
payload-integrity dimensions or private-field access. Corrupted stored proofs make a link unavailable.
Issuer workspace invitations additionally report recipient readiness and wallet verification time;
the issuance context distinguishes delivery email from the actual claimant's linked address.
