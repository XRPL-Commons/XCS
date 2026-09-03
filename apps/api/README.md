# XCS read API

The API exposes rebuildable, read-only XCS projections. Ledger-derived routes run in a read-only
repeatable-read snapshot and fail with `503` unless the indexer has a live writer lease, a fresh
checkpoint, and consistent dual-source evidence. Interactive OpenAPI documentation is served at
`/documentation`.

This REST API is the public integration contract for the accountless Testnet beta; GraphQL is not
part of the beta. XRPL Commons may operate a shared instance, but PostgreSQL remains a reconstructible
ledger projection rather than protocol truth. The API never accepts a signing seed or private key,
and it does not persist credential payload claims submitted for verification.

The server requires `XCS_INTERNAL_API_TOKEN` (32–256 URL-safe random characters). The private Nuxt
SSR hop presents this token with an opaque HMAC key deterministically derived from the visitor
network address; no browser-selected session identifier can mint or rotate a budget. The global
in-process limiter can then keep independent visitor budgets instead of treating the web container
as one client. The token is compared in constant time. Missing, malformed or incorrect internal
credentials fall back to the source-IP budget, and public browser calls always remain IP-limited.
Never expose this token in CORS configuration, browser runtime variables or logs.

When the public API is behind a reverse proxy, set `XCS_TRUSTED_PROXY_CIDRS` to the exact IP/CIDR of
that proxy only after configuring it to remove any client-supplied forwarding headers and write its
own canonical `X-Forwarded-For`. With the variable unset, Fastify deliberately ignores forwarded
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
`/health/ready`, which performs database reads. The Compose healthcheck uses `/health/live`, and the
web service waits for that container health signal before starting.

## Operational metrics

Set `XCS_METRICS_ENABLED=true` and a dedicated `XCS_METRICS_TOKEN` to expose
`GET /internal/metrics`. The token must contain 32–256 URL-safe characters, must differ from
`XCS_INTERNAL_API_TOKEN`, and is presented as `Authorization: Bearer <token>`. The route is absent
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
signal. See [`ADR 0002`](../../docs/adr/0002-public-product-and-discovery.md).

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

The discovery indexes are part of the generated current-schema baseline. Before production, reset
the disposable projection database and run `pnpm --filter @xcs-protocol/db db:bootstrap` after a
schema change; see the [deployment runbook](../../docs/runbooks/deployment.md).

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
