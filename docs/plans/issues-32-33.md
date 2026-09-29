# Recipient and verifier workspaces (#32 / #33)

Base: PR #35 standalone integration, 9b22913. Preserve both independently installed apps,
public Studio and public payload routes, protocol invariants and migrations 0000–0006.

Goal: authenticated recipients can discover their issued credentials, accept/reject through their
own wallet, and grant/revoke public or named-verifier presentations; verifier applicants can be
reviewed by the existing admin flow and approved verifiers can inspect authorized presentations
with separate verification dimensions and metadata-only history/CSV.

Accepted decisions from ADR 0005 override older issue wording: no automatic sharing expiry or
implicit single-use consumption, no issuer allowlist, no administrator private-claim override,
full sharing bound to one currently approved verifier organization. `/p` remains public payload
hosting; presentation tokens travel in a fragment and explicit POST, never a URL query or log.

1. Complete: froze API/UI contracts and implemented recipient inbox, exact ledger reconciliation,
   private consented payload review and presentation authorization. Reuse existing portal pool with
   narrowly extended grants and existing wallet signing/verification checks.
2. Complete: verifier application/status, resolution and metadata-only history/CSV; additive migration
   only where persisted history requires it. Maintain source-copy provenance and SQL grants tests.
3. Complete: EN/FR screens and QR links; focused unit/HTTP/SQL/browser/runtime coverage, full repository
   checks, architecture/operations docs and independent privacy review.
4. Complete: final review and commit preparation with actual evidence and remaining release gates.
   Publication and remote check results are tracked in PR #35.

Ownership: root integrates wallet acceptance, auth return/session handoff, navigation, contracts and
validation; frontend agent owns new recipient/verifier/presentation screens and locale sections;
backend agent owns recipient/presentation API and shared schema/provision changes; license agent
first investigates exact package evidence and then owns separate verifier backend implementation.
No concurrent writes to shared files without explicit handoff. Root owns test environment scheduling.

Security checks: owner isolation, exact generation/subject binding, no payload fetch on reject,
consent before private bytes, no credential cookies to external payload hosts, current session and
verifier approval on each disclosure, revoked grants rejected, no tokens/claims in lists/history,
rate/body limits and CSRF for mutations, no secrets in logs or committed artifacts.

Non-goals: production deployment, real identity registration, wallet approval, unsolicited email,
new verifier trust score, protocol changes or broad dependency upgrades. UX sessions with real users
remain a human validation gate. License policy is not relaxed: correct only provable packaging defects.

Recovery: disable optional portal configuration and deploy previous compatible image; retain existing
application data and forward migration history. Tests use isolated local PostgreSQL/SMTP only.

## Review and verification record

Independent reviews found and corrected a missing active-link quota (concurrent creation now
serializes at 200 per credential), a history GET with a write side effect (now POST + CSRF),
a router console warning exposing fragments, and same-component navigation retaining the previous
presentation. Browser visibility hides claims without invalidating consent during an external wallet
signature; identity and generation checks remain in force.

Initial broad verification passed format/provenance, lint/types and 835 web + 59 package unit tests.
Indexer migration fixtures needed their catalog, truncation list and table count updated for 0007;
after correction all 287 indexer unit tests passed. Full PostgreSQL validation passed 56 indexer and
49 web tests. Migration generation produced no changes. Original migrations 0000–0006 are unchanged.

The first browser pass completed 60 standard, two auth and three production-security tests. Two
additional presentation navigation regressions subsequently passed with the focused nine-test suite.
The first compiled HTTPS run passed the four existing scenarios and caught the same-tab presentation
bug; the final rebuilt scenario remains to be recorded below.

Both Docker images built with production dependencies. The local isolated Compose upgrade ran
migration/bootstrap, web and notifier as UID 1000, restricted SQL grants, private document volume
writes and actual delivery to local Mailpit. No public XRPL writer/indexer was started for this check.

Vaul's missing MIT file was restored with an exact-version/digest override. The unchanged license
policy still rejects three entries: GemWallet custom terms, WalletConnect custom terms and Nodemailer
MIT-0. Maintainer decisions remain necessary. Real OIDC/wallet/mobile/user qualification remains
separate; already-signed transaction recovery's existing trust-recheck limitation is documented.

## Final source validation

`pnpm verify` passes end to end on the frozen implementation: **1,183 unit tests** (59 shared
packages, 837 web, 287 indexer), format, copy provenance, Drizzle parity, lint, types and all builds.
The final full browser run passes **65 standard scenarios**; two authentication and three production
security scenarios also pass (**70 total**). Final private-link tests additionally inspect router
history state on arrival, exit and back navigation. The web image was rebuilt after those fixes and
the local Compose bootstrap/grants/UID/private-volume/SMTP smoke passed again. Indexer production
code is unchanged since its successful image build. Migration generation remains clean.

All **five compiled-runtime scenarios pass** against the final build, including synthetic-session
HTTPS/Chromium tests with real restricted pools. The new test covers successive anonymous links,
wrong audience, authorized full view, CSRF denial, read-only unsupported GET, metadata CSV/history,
reopening, revocation and approval suspension. Fixture identity changes navigate through the app
before opening a link; they do not bypass the UI's intentional session-change invalidation.
The isolated Compose validation services are stopped; durable volumes and other worktrees are kept.
