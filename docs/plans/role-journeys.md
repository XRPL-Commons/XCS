# Complete issuer → recipient → verifier journeys

Base: PR #35, e2404ec. Goal: an approved issuer invites a recipient, the recipient proves control of
a wallet, the issuer issues to that wallet, the recipient signs acceptance, and a verifier opens a
single link showing issuer admission, exact ledger issuance/acceptance and recipient wallet proof.
No manual URI or tuple entry is required. Existing private-field audience restrictions remain intact.

## Milestones

1. Complete — audit the actual routes, wallet signatures, approval/issuance bindings and browser
   tests. Resolve whether each presentation requires a new wallet signature and whether minimal
   public verification remains accountless. After offering the choices, proceed with a fresh signature for each new presentation and
   accountless minimal evidence, retaining designated-verifier access to private fields. These
   defaults strengthen the requested proof and preserve the existing disclosure policy.
2. Complete — complete onboarding handoffs and issuer readiness visibility; present factual issuer
   admission and recipient-address evidence without treating Commons approval as universal trust.
   Implement the selected wallet-ownership proof and presentation behavior, using existing
   message-signature support and atomic server authorization. Use additive migrations if needed;
   preserve deployed 0000–0007, independent apps, restricted pools and no-secret signing boundary.
3. Complete — exercise a connected multi-actor journey and denial paths, then run appropriate unit,
   PostgreSQL, compiled runtime/browser and static/build checks. Documentation synchronized;
   delivery continues through the existing draft PR #35.

Closed gaps: wallet linking now has a guided return; recipient waiting and issuer claim states
distinguish an unlinked wallet; presentations expose current issuer admission and a dated recipient
signature. Tuple-free links and server-side scope enforcement are preserved. A connected runtime
test drives approvals, invitation delivery, wallet linkage, issuance, acceptance and signed sharing.
It exposed string-valued PostgreSQL network IDs in issuance DTOs; both wallet lists now normalize
them to the numeric API contract, with regression coverage.

Owners: root integration, issuer-admission evidence and contracts; UI agent onboarding/presentation
screens; backend agent scoped wallet proof after the product answer; test agent connected multi-actor
validation. Shared-file edits require explicit handoff. Root schedules PostgreSQL and Nuxt builds.

Security: a connected wallet is not proof. Reuse verified text signatures, never collect seed/private
keys or sign disguised transactions. Proof must bind the exact recipient, credential, scope, audience
and site and reject replay/session changes. Admission status is checked server-side and does not
rewrite ledger verification or issuer trust. Public links must not gain private claims. Master-key
proof limitations and already-issued proof timestamps must be explicit.

Non-goals: real production deployment, automatic Commons approval, live external email, custody or
wallet creation inside XCS. Wallet installation/account creation stays in the wallet application.
Roll back with the prior app image, keeping additive schema and records; test only isolated local
PostgreSQL, SMTP and synthetic wallets/ledger evidence.

## Validation evidence

- Standalone web/indexer `pnpm verify`: format, lint, types, 851 + 287 unit tests and both builds pass.
  Shared-package Turbo checks pass (59 unchanged unit tests, cached). Final web lint/typecheck and
  build also pass after the issuance DTO correction and test-fixture fixes.
- Sequential PostgreSQL suites: indexer 57, web 56; three readiness/admission tests rerun after the
  numeric-network DTO fix. SMTP-only coverage uses the separate compiled runtime tier.
- Browser suites: 70 standard, three production-security and two authentication scenarios pass.
- Compiled HTTPS runtime: all six scenarios pass. The connected journey uses the real wallet SDK
  with synthetic transports and verifies signed issuance/acceptance before fixture projection, then
  fresh sharing signatures, the three public facts, private audience filtering and revocation.
- Both Docker images build; the final web image includes the DTO fix. Isolated Compose applies
  migration 0008, checks narrow grants, separate pools, UID 1000, document writes and Mailpit delivery.
  Thirty-two overlay configurations pass. Validation containers are stopped with volumes retained.
- Root formatting, vendored-copy and Drizzle parity pass; migration generation creates no changes.
  All 16 deployed migration/snapshot files for versions 0000–0007 are byte-for-byte unchanged.
- Runtime testing found a pre-hydration admin click race in the test; the fixture now waits for the
  application's client-ready marker before interacting. No production authorization was weakened.

Real Identity registration, installed extension/mobile flows and live Testnet consensus are not
qualified by these fixtures. The pre-existing dependency-license gate remains unresolved; keep the
PR draft. No production deployment or external invitation delivery was performed.
