# Alpha limitations and release gates

XCS v0.1 is implemented as a Testnet alpha whose next product target is a public Testnet beta, not a
Mainnet release. Its normative semantics are frozen; product work may add non-normative REST reads
and user interfaces, but changing protocol validity or derived bytes requires a later version and a
new activation profile. The following constraints are intentional and must remain visible to
integrators.

## Public product and discovery

- EAS and EASScan are UX references only. XCS uses native XRPL Credentials and does not reproduce
  the EAS contracts or attestation model.
- Schema registration is permissionless. Every valid schema is public and discoverable, but neither
  publication nor visibility is Commons endorsement.
- Credential discovery is hybrid: verification uses an exact generation ID, transaction hash or
  complete issuer/subject/schema tuple. The reference product has no public subject feed,
  account-wide Credential enumeration or claims search. Public ledger identifiers are still public;
  this boundary limits their aggregation rather than making them private.
- Explorer text and address search returns schemas only; Credential metadata is returned only when
  the caller supplies a complete generation ID, transaction hash or tuple. The public activity page
  lists schema registrations, not Credential events.
- Commons publishes no issuer badges, rankings or universal trust result. Issuer trust remains an
  application policy separate from ledger state, schema validity and payload integrity.
- The beta has no XCS user or organization account. Wallet operations and receipts are local to one
  browser, so clearing site data or moving devices loses that local history.
- Issuance is one Credential at a time through a supported wallet. Batch issuance, teams, RBAC,
  hosted automation and GraphQL are outside the beta scope.
- `@xcs-protocol/core`, `@xcs-protocol/sdk`, and `@xcs-protocol/cli` have reproducible tarball and
  isolated-consumer gates, but they are not registry-installable until XRPL Commons completes the
  one-time npm scope bootstrap. Developers guidance therefore remains explicitly monorepo-local.
  Subsequent releases are staged through OIDC and still require human 2FA approval.

## Network and deployment

- The repository contains no live network profile. The example registry and activation boundary are
  invalid placeholders; a separately audited Testnet profile is required.
- There is no in-place database migration from the former `XRPL-Commons/xcs` Nuxt MVP. Its
  `schemas` and `credentials` tables are incompatible with this indexer's projection. Preserve a
  backup and deploy this alpha against a fresh database; legacy off-chain data needs a separately
  designed export/transform/import process.
- The indexer requires two independently operated WSS `rippled` sources with complete validated-ledger
  history from activation. Clio is not supported by the current preflight response contract, a pruned
  source is insufficient, and distinct URLs do not by themselves prove operator independence.
- `XCS_PUBLIC_RPC_URL` is deliberately exposed to every browser and must contain no secret. It is a
  transaction-submission convenience, not a third quorum source and not authoritative verification
  evidence; the two indexer source variables remain private server configuration. The web runtime
  rejects embedded username/password values and non-TLS public endpoints (`ws://` is loopback-only),
  but operators must also keep opaque credentials out of the URL path and query string.
- PostgreSQL, Kubo, Docker, and real Testnet services are separate integration tiers; pure unit tests
  do not prove those deployments.
- CI replays one deterministic synthetic ledger bundle through two PostgreSQL projections and pins
  their complete digest, but this proves the harness rather than Testnet history. A reviewed public
  Testnet capture from two demonstrably independent providers remains release evidence.
- Discovery indexes are part of the single generated baseline; this pre-production package does not
  support applying them to an already populated deployment.
- PostgreSQL is a self-hostable, rebuildable reference projection, not a Commons authority and not a
  protocol requirement for third-party implementations. A MongoDB adapter would need to reproduce
  atomic checkpoints, single-writer fencing, snapshots, constraints, and deterministic replay.
- The reference bootstrap supports only a fresh database on a dedicated cluster. It creates
  cluster-wide fixed roles, applies current-database grants and forces SCRAM-SHA-256 verifiers, but
  it is not a shared-cluster bootstrapper, forward-compatible upgrader or anti-administrator
  attestation. The administrator and reviewed baseline remain trusted; transport security and an
  explicit SCRAM `pg_hba.conf` policy remain operator responsibilities.
- There is intentionally no pre-production upgrade history. Every current constraint and index is
  created by `0000_baseline.sql`; a schema change requires regenerating the baseline and recreating
  the projection database. The baseline must freeze before production, after which changes require
  reviewed forward migrations.
- Signed PostgreSQL `integer` coordinate columns, including transaction and node indexes, still
  represent at most `2147483647`, not the full abstract uint32 range. The schema enforces their
  non-negative boundary but does not widen them.
- XRPL Commons intends to host the shared Testnet indexer, read API and PostgreSQL projection. That
  projection remains a reconstructible cache and contains neither issuer/subject signing keys nor
  credential claims.
- The built-in API rate limiter is in-memory and suitable for the single-instance beta. Horizontal
  replicas require a shared edge/store limiter. Nuxt SSR derives one opaque budget per safely
  resolved network address; reverse-proxy CIDRs must be narrow and explicitly configured, while
  catch-all `/0` trust ranges are rejected.
- Operational counters are also process-local and reset whenever an API replica restarts. The
  protected JSON snapshot exposes only the current durable indexer halt, not continuity incident
  history. It cannot observe browser-local XRPL submission outcomes, postgres.js pool queues, or
  physical PostgreSQL volume capacity; its database byte count is logical size only. Multi-replica
  aggregation, infrastructure exporters, retention, alerts and any client telemetry require later
  operational/privacy design.
- Browser signing readiness is a short, profile-bound point-in-time proof. It prevents the site from
  opening a wallet or submitting a returned blob against known stale or inconsistent state, but it
  cannot atomically bind a later XRPL transaction to that checkpoint. Exact post-validation indexer
  confirmation remains mandatory.
- Nitro emits the initial browser CSP in report-only mode. It records violations in local browser
  tooling but blocks nothing, so it is not yet an XSS or signed-blob exfiltration control. Enforcement
  remains gated on the real XRPL Connect wallet matrix, including qualification of WalletConnect
  modal styles and images; the ingress must preserve one policy instead of appending its own.
- The policy's `connect-src https:` allowance is intentional: permissionless issuer-hosted payload
  domains cannot be known at deployment time. Host display, explicit consent, exact-generation
  revalidation and payload integrity checks remain the application boundary. Narrowing this to a
  Commons allowlist would change the accepted product model.
- CSP violation collection is disabled. There is no `report-uri`, Reporting API endpoint or
  third-party collector because reports can contain exact Credential URLs, issuer hosts and browsing
  context. Operators must use local DevTools during rollout unless a later privacy review approves a
  collector and retention policy.
- HSTS covers only the deployed host. It deliberately omits `includeSubDomains` and `preload`, so it
  does not assert HTTPS readiness for unrelated organizational subdomains.

## Wallets

- The Nuxt alpha pins the release candidate `xrpl-connect@1.0.0-rc.0`. Its factory covers the eight
  official adapters—Xaman, Crossmark, GemWallet, WalletConnect, Ledger, Xyra, Otsu and MetaMask
  Snap—but only the six self-configuring adapters are registered by default. Xaman requires the
  public `NUXT_PUBLIC_XAMAN_API_KEY`; WalletConnect requires the public
  `NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`. Their Compose inputs are
  `XCS_PUBLIC_XAMAN_API_KEY` and `XCS_PUBLIC_WALLET_CONNECT_PROJECT_ID`. These identifiers are not
  secrets, and their absence removes the corresponding adapter.
- The public deployment and dependency-policy gates must remain closed until Commons records
  permission from GemWallet for public/beta use and explicitly reviews the WalletConnect Community
  License, including its attribution, network and usage-threshold conditions. The RC bundles both
  integrations; downgrading to `0.8.2`, removing only their lockfile entries or reclassifying their
  licenses as MIT would conceal rather than remove them. The upstream per-adapter packages are not
  currently published on npm, so retaining all eight adapters without these approvals has no
  compliant package-level workaround.
- XCS invokes only adapter `sign()`. It normalizes a returned `tx_blob` or signed `tx_json`, checks
  the derived hash, XRPL signature, optional `signerAddress` and exact equality with the reviewed
  transaction, then persists and submits the blob itself. Calling or falling back to
  `signAndSubmit` would bypass the recovery and pre-submission controls and is forbidden.
- Eight adapters do not mean every wallet is compatible. WalletConnect can discover more wallets,
  but each one still needs the XRPL Testnet namespace and native `CredentialCreate`,
  `CredentialAccept` and `CredentialDelete` support. Real browser extensions, Xaman popup,
  WalletConnect QR/deep links and Ledger hardware access remain an adapter-by-adapter manual gate.
- GemWallet 3.8.x is a known transaction-specific exception: its embedded XRPL validator predates
  XLS-70 and rejects every native `Credential*` type before signing. XCS leaves GemWallet enabled for
  schema-registration `Payment` transactions, labels its Credential limitation in the chooser and
  rejects Credential preparation before a wallet popup or operation journal entry. Removing this
  guard requires a newly released GemWallet version plus real Testnet evidence for create, accept
  and delete; updating only `xrpl-connect` in XCS cannot replace the extension's embedded codec.
- Xaman's current source includes native Credential handling, so XCS labels it as supported when the
  public application identifier enables the adapter. This label is a capability indication, not
  release qualification: the popup flow and all returned signed artifacts still need the manual
  Testnet matrix gate.
- The release candidate declares the peer range `xrpl ^3 || ^4`, while XCS uses `xrpl` 5. This
  combination passes only repository-side compatibility checks until upstream declares or a stable
  release proves support; it remains a release risk. The RC also adds a substantial browser
  dependency tree and bundle cost that must be measured before the public beta.
- The published RC reports Otsu available without checking the injected provider marker. XCS keeps
  a narrow local availability override equivalent to the adapter's connect-time marker check. Drop
  that workaround only after upgrading to a release containing the upstream correction.
- The same RC asks Otsu for `read`, `sign`, `submit` and `switchNetwork` scopes even though XCS never
  invokes wallet submission. It also proposes extra WalletConnect methods that some otherwise
  sign-capable XRPL wallets may reject. Both permission surfaces need an upstream least-privilege
  fix and real-wallet evidence before those adapters can be promoted beyond the controlled pilot.

## URI interoperability

The XRPL protocol permits 256 URI bytes. `xrpl.js` 5.0.0 incorrectly applies that limit to the
hexadecimal JSON string, making its effective limit 128 bytes. XCS builders retain the normative
256-byte rule, while the submission helpers fail early above 128 bytes. Prefer a raw IPFS CID or a
short HTTPS base URL until the upstream validator is fixed.

## Payload hosting and demo pinning

The Commons Testnet beta uses issuer-hosted HTTPS payloads. The issuer must retain the exact
canonical bytes, serve a JSON media type, enable CORS for the site, and keep the integrity-bound URL
available. Commons does not store or index payload claims.

The JSON media type is an interoperability recommendation for browsers, not normative verification
evidence. The optional server resolver classifies the observed, integrity-bound bytes even when
`Content-Type` is absent or different and does not trust `Content-Length` to prove the 1 MiB limit.

The optional pinning API is disabled by default, limited to configured Testnet profiles, and not a
private storage service or part of the Commons-hosted beta product. Its person-specific field-name
filter is only a guardrail, not a classifier; context-neutral labels such as `name` remain valid.
There is no promise that public IPFS content disappears after the
local 90-day pin expires.

The separate `XCS_LOCAL_PAYLOAD_STORE=1` development aid keeps at most 20 canonical payloads for 24
hours in one loopback browser and anchors their normative raw IPFS CIDs. It is deliberately
unavailable in production and does not publish or pin those bytes to IPFS. Credentials issued with
this mode are therefore resolvable only by the same browser while its entry remains present; the
on-ledger Testnet object outlives local expiry or purge. Person-shaped field identifiers require the
issuer's explicit confirmation that their test values are fictitious; that confirmation is persisted
with the local record so the same browser can later review it. This remains only a guardrail and does
not make personal data safe. Browser storage remains exposed to the same-origin/XSS boundary.

The browser acceptance pilot reads issuer-hosted HTTPS payloads directly only after consent. This
reveals IP address and timing to that host; local/IP-literal hostnames are rejected, but DNS rebinding
remains a browser-boundary risk. Private or sensitive claims are outside this pilot.
