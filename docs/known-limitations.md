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
- Public Studio and verification remain accountless. Optional OIDC accounts, wallet linking,
  admin approval and issuer workspaces add server sessions and organization records; approval is
  not issuer endorsement. See [ADR 0005](adr/0005-role-based-application.md). Wallet operations and
  receipts still use browser-local recovery, lost on site-data clearing or a device change.
- Issuance is one Credential at a time through a supported wallet. Batch issuance, team membership,
  fine-grained team permissions, hosted automation and GraphQL remain outside this implementation.
  Recipient inbox, consented private acceptance, revocable presentations and verifier history are
  implemented. Real-user usability sessions and live wallet/OIDC qualification remain release gates.
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
- Discovery indexes are part of the committed baseline migration; this pre-production repository
  does not support applying them to an already populated deployment.
- PostgreSQL is a self-hostable, rebuildable reference projection, not a Commons authority and not a
  protocol requirement for third-party implementations. A MongoDB adapter would need to reproduce
  atomic checkpoints, single-writer fencing, snapshots, constraints, and deterministic replay.
- The reference bootstrap targets a dedicated cluster. It creates cluster-wide fixed roles,
  applies current-database grants and forces SCRAM-SHA-256 verifiers; it is not a shared-cluster
  bootstrapper or an upgrader for arbitrary database histories. The administrator and reviewed
  migration history remain trusted; transport security and an explicit SCRAM `pg_hba.conf` policy
  remain operator responsibilities.
- The shared `db/migrations/` history supports upgrades from the committed projection baseline
  through migrations 0000–0006, including hosted payload, application, authentication, admin and
  issuer storage. PostgreSQL integration tests exercise populated-baseline upgrades, preserving
  profiles and legacy payload bytes/locators, plus repeat migration runs. Use the standalone
  indexer's migration commands before enabling the corresponding web features; retain applied
  migration bytes and add forward migrations. This does not provide a migration from the former
  Nuxt MVP or arbitrary schema drift. A particular live deployment still needs its own backup and
  upgrade qualification. The projection is rebuildable from ledger data; application accounts,
  documents and private payloads are not and need backups.
- Signed PostgreSQL `integer` coordinate columns, including transaction and node indexes, still
  represent at most `2147483647`, not the full abstract uint32 range. The schema enforces their
  non-negative boundary but does not widen them.
- XRPL Commons intends to host the shared Testnet indexer, read API and PostgreSQL projection. That
  projection remains a reconstructible cache and contains neither issuer/subject signing keys nor
  credential claims. Optional application and payload services persist claims separately in the
  same deployment using restricted writer roles; the database as a whole is not claim-free.
- The `/v1` rate limiter is in-memory and suitable for the single-instance beta. Horizontal replicas
  require a shared edge/store limiter. The client address is resolved through
  `XCS_TRUSTED_PROXY_CIDRS`, which must be narrow and explicitly configured; catch-all `/0` trust
  ranges are rejected, and an undeclared proxy collapses its visitors into one shared budget.
- Operational counters are also process-local and reset whenever a web replica restarts. The
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
  Inline `style` attributes are allowed (`style-src-attr 'unsafe-inline'`) because the Nuxt UI
  component library positions menus, popovers and toasts through them; script execution remains
  nonce-based with `'strict-dynamic'`, but is not enforced while the policy is report-only.
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

### Repository restructure (ADR 0004)

- `apps/web` and `apps/indexer` are standalone deployables that import no workspace package. Each
  carries hand-maintained copies of the protocol and database code it needs, headed by a comment
  naming the source file and the commit it was copied at. CI's
  `ops/ci/check-vendored-copies.mjs` checks source/copy parity while allowing import rewrites;
  deliberate divergence pins a reviewed source digest. Changes still require manual mirroring
  and app validation under [CONTRIBUTING.md](../CONTRIBUTING.md); package tests alone do not
  exercise the deployed copies.
- A direct application-copy edit does not update `packages/core`, `packages/sdk` or the CLI.
  The parity gate rejects unreviewed differences; land protocol changes in the reference source
  and mirror them in the same change.
- The two applications pin their dependencies in separate lockfiles. `drizzle-orm` in particular must
  stay identical in both, because `db/schema/` is compiled by each application against its own copy;
  `ops/ci/check-drizzle-parity.mjs` enforces lockfile parity in CI.
- `--ignore-workspace` is mandatory on every per-app pnpm command that resolves dependencies
  (`install`, `audit`, `licenses list`). Without it pnpm silently operates on the root workspace and
  still exits 0, so an audit or licence report can appear to pass while covering the wrong lockfile.
- Dependency license qualification remains open. The standalone policy run reports `Unknown`
  for `@gemwallet/api@3.8.0`, `@walletconnect/types@2.25.0` and `vaul-vue@0.4.1`, plus
  `nodemailer@10.0.10` (`MIT-0`, outside the current allowlist). No exception or policy relaxation
  was added. The top-level SDK's MIT declaration does not replace review of bundled/transitive code.
- PostgreSQL is provisioned outside this repository. The Compose stack — including the `monitoring`
  and `demo-pinning` profiles — is local development only: it carries no secret-file mechanism and
  passes Grafana's admin password and the exporter's database password as plain container
  environment. A hosted deployment needs its own database provisioning, secret store and monitoring
  design; this repository provides the alert rules and dashboards, not the topology.
- The two applications are deployed and versioned independently, so a deployment can run mismatched
  revisions. They share only database rows; there is no version negotiation between them, and a
  schema change must be rolled out in a compatible order by the operator.

## Wallets

- The application pins `xrpl-connect@1.0.0-rc.2` and its official Vue bindings at the same version.
  Crossmark, GemWallet, Ledger, Xyra, Otsu and MetaMask Snap are registered without deployment
  identifiers. Xaman requires `NUXT_PUBLIC_XAMAN_API_KEY`; WalletConnect requires
  `NUXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`. These are browser-visible identifiers, never secrets.
  Xaman's SDK selects redirects; the former redirect environment variable is no longer consumed.
  Each deployment must register and qualify its actual origin and callback URLs.
- XCS uses sign-only operations, validates the returned artifact's signature and exact reviewed
  fields, journals it, then submits through its configured Testnet RPC. It never invokes
  `signAndSubmit`. GemWallet's explicitly consented Credential path uses its public hex-message
  signing API; it does not grant XCS custody or permission to sign without another approval.
- GemWallet 3.8.x's transaction codec cannot sign native `Credential*` types. The Testnet raw path
  validates and serializes the reviewed transaction, binds the master public key to the connected
  account and verifies the returned signature before persistence/submission. GemWallet displays
  hexadecimal data rather than decoded transaction fields, so explicit acknowledgement is required
  for each attempt. Regular keys and multisigning are not supported by that path. See the
  [recorded GemWallet qualification](runbooks/gemwallet-raw-signing.md).
- Otsu selection disconnects a previous origin permission before reconnecting, so a stale granted
  address cannot silently replace fresh approval. A locked signing account is reported separately
  from an absent extension and requires unlocking/reconnection, without automatic signing retries.
  Otsu and Crossmark must use separate local browser profiles: the inspected extensions collide
  on injected globals. See the [recorded Otsu qualification](runbooks/otsu-live-flow.md).
- The rc.2 ESM Crossmark adapter carries a narrow local patch for the approval/session network;
  a missing or malformed network fails closed without falling back to cached Testnet. The patch
  does not cover CommonJS/UMD consumers. Its tests emulate extension messages through the real SDK,
  not a user's actual approval. See [patch scope](../apps/web/patches/README.md).
- Real extension, popup, hardware and WalletConnect QR/deep-link qualification remains adapter
  specific. Historical live-wallet reports describe their recorded checkout; they do not qualify
  this new standalone integration automatically. WalletConnect discovery does not prove Testnet
  namespace or native Credential transaction support. Automated tests prove the application boundary.
- The release candidate declares `xrpl ^3 || ^4`, while the application uses xrpl.js 5. The peer
  mismatch and browser dependency/bundle size remain compatibility concerns until independently
  qualified. Consult a fresh standalone `pnpm --dir apps/web audit --ignore-workspace` and the license policy
  rather than assuming a prior lockfile's vulnerability or permission results apply.

## URI interoperability

The XRPL protocol permits 256 URI bytes. `xrpl.js` 5.0.0 incorrectly applies that limit to the
hexadecimal JSON string, making its effective limit 128 bytes. XCS builders retain the normative
256-byte rule, while the submission helpers fail early above 128 bytes. Prefer a raw IPFS CID or a
short HTTPS base URL until the upstream validator is fixed.

## Payload hosting and demo pinning

Public issuance supports external issuer-hosted HTTPS and optional signed-upload hosting. External
hosts must retain exact canonical bytes, serve a JSON media type, allow browser CORS and keep the
integrity-bound URL available. Hosted publication stores explicitly consented public claims separately
from the ledger projection and requires validated indexed transaction evidence. Its browser recovery
queue retains public bytes until verified publication or explicit removal; it is not a cross-device
backup. A transaction validated on XRPL does not itself prove the payload was published.

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
remains a browser-boundary risk. Private or sensitive claims must not enter this public acceptance flow.

## Application access, private payloads and recovery

- Authentication and issuer features are optional and disabled by default. Real OIDC client
  registration, production mail delivery and wallet message-format qualification are separate
  deployment gates; tests using a local identity provider or SMTP sink do not complete them.
- Admin approval gates portal access; it does not confer universal issuer trust, change protocol
  validity or automatically expose private Credential claims. The server rechecks ownership and
  current approval rather than trusting navigation or organization IDs from the browser.
- An invitation email is a delivery address, not identity evidence. Any authenticated bearer-link
  holder may claim it. Issuers must review the actual claimant and verified subject wallet before
  signing. Invitation delivery, claim, issuance and ledger acceptance remain separate statuses.
- Managed issuer payloads default to private and use authorization-aware `/q/:locator` reads.
  Authorized issuer/recipient sessions may receive complete canonical bytes; anonymous views of
  private records receive selected public claims only. This is server access control, not end-to-end
  encryption. The operator retains database access, while on-chain addresses, schema, opaque URI and
  full digest remain public. Public disclosure cannot recall downloaded copies.
- Public payload readers omit session credentials. Filtered responses carry
  `x-xcs-claim-scope: public` and produce `PAYLOAD_SCOPE_RESTRICTED`, not a false digest-tampering
  result or a claim of verified full integrity. Authenticated recipient acceptance uses the separate
  same-origin private reader and never submits private claims to the public verification endpoint.
- Private canonical claims never enter the public publication queue or browser recovery storage.
  Issuer recovery retains nonsecret references, transaction hashes and visibility selections only.
  Confirmed ledger operations reconcile application metadata without requesting another signature.
  Unknown or pending outcomes block retries; an explicit reset requires matching durable evidence
  of expiry or validated transaction failure.
- IndexedDB atomically excludes another managed issuance for the same invitation across tabs and
  wallet choices in one browser profile. It does not lock another browser or device. Backend metadata
  uniqueness rejects duplicate attachment but is not a distributed pre-signing reservation:
  simultaneous devices can create an extra ledger object the application does not attach.
- Notification failure cannot undo issuance or revocation. Ambiguous SMTP acknowledgements are
  recorded as uncertain and require review rather than automatic retry. Application records,
  document files and private payload storage need backups independently of the rebuildable indexer.

- Recipient sharing has no automatic expiry or single-use consumption. Revocation and verifier
  suspension prevent future disclosure, but cannot erase copies already downloaded. Each credential
  is limited to 200 active grants; recent workspace/history lists are bounded, not archival exports.
  Issuance/revocation emails use the existing issuer flow; external ledger revocations appear in the
  recipient's in-app notifications without triggering an additional email delivery service.
- The dependency license gate still requires maintainer decisions for GemWallet, WalletConnect and
  Nodemailer MIT-0. Vaul's missing MIT license file is restored from its exact published source;
  see [license evidence](runbooks/dependency-licenses.md).

- Recovery of an already signed `CredentialAccept` rechecks exact generation/lifecycle and indexer
  readiness, but does not re-run issuer-trust consent or portal session authorization. A pending
  signed transaction can therefore be retried after trust policy or session changes. It contains no
  claims; new private reads still require current authorization. Explicit failed post-signature
  validation clears the recoverable blob, but interrupted signing/revalidation remains a qualification
  case for wallet recovery.

- Presentation wallet proofs establish a dated master-key signature for the exact sharing intent.
  They do not prove current presence, identity of the link viewer, or current ledger authority after
  master-key disabling/regular-key changes. Legacy unsigned grants remain explicitly distinguishable.
  Issuer admission shown on the link is the current portal decision; historical approval at issuance
  is not inferred. Wallet creation/backup stays in the wallet provider, never the XCS application.
