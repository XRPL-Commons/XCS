# Simple attestation journeys

Goal: let issuers, recipients and verifiers complete their work without entering or interpreting
hashes, schema identifiers, JSON or ledger terminology. The existing technical tools remain
available through explicit secondary controls. Base: 7080dce; its functional CI jobs passed,
with the existing dependency-license policy failure unchanged.

## Milestones

1. Complete — inspect the role pages, signature review, results and navigation. Confirm that
   admission, trust, ownership, consent and private-field authorization remain distinct.
2. Complete — simplify the main navigation and link entry, make presentation results readable,
   provide plain-language signature/finality summaries, and guide issuer/recipient actions.
   Reuse the existing data and security boundaries; no database/API changes or new dependencies.
3. Complete — exercise the relevant English/French browser journeys and failure states, run web
   unit/static/build checks, inspect the real local site and document actual validation.

Acceptance: the ordinary route shows names, content, next actions and understandable statuses.
Technical references are collapsed by default and remain inspectable. A verifier can paste the
received link, or open it directly, without entering technical identifiers. Before signing, the
action, recipient context, network and cost remain clear; GemWallet's opaque-message limitation
requires explicit consent. Unknown trust, missing holder proof, revoked/expired attestations and
unavailable checks must never become a misleading success message. Private claims/tokens remain
excluded from URLs, persistence and diagnostics according to the existing rules.

Ownership: root handles shared transaction/result components, presentation display/link entry,
navigation, translation integration and validation. Independent agents handle issuer and recipient
page improvements in disjoint files. Translation changes are handed to root to prevent conflicts.

Rollback: restore the preceding web image; no migration or persistent-data conversion is needed.
This is a presentation change, not wallet custody, automatic approvals or production deployment.

## Delivered behavior

The portal home page has three entrances: Receive, Issue and Verify. Technical tools move to More;
protocol-only deployments retain their existing navigation. Issuers select named attestation
templates, keep that selection when inviting, and review readable public/private fields before
signing. Recipients see their next action, can continue immediately when a wallet is already linked,
and get the correct available actions after acceptance without reloading the page. Removal remains
available as a secondary action. Shared components render nested claims and translated lifecycle
states without JSON or protocol codes in the main view.

Wallet approval displays the action, test network, fee and payment amount, where applicable.
The full transaction remains inspectable, and GemWallet's coded-message consent is still mandatory.
Transaction success, application confirmation, pending work and failures remain distinct. Sharing
starts with audience and fields, then requests its separate wallet signature. Verification accepts
only this portal's complete sharing links and keeps tokens out of navigation and persistent storage.
The result prioritizes attestation name, issuer admission, acceptance and dated sharing proof;
technical identifiers and detailed verification dimensions are collapsed, not removed.

Review caught and corrected two simplification regressions: a successful invitation API response
can contain failed/uncertain mail delivery, so only actual `sent` status announces success; schema
errors retain their exact code/path/message behind their plain-language explanation. Regression
coverage includes failed, uncertain and confirmed delivery, unsupported schema versions, invalid
descriptions, and the same-page transition from pending to accepted.

The real issuer browser retained an older public-content recovery record. Its global recovery
panel now keeps retry, download and removal actions visible while collapsing URLs, transaction
references and raw failure diagnostics. The existing journal and saved content are preserved.

## Validation — 2026-09-25

- `pnpm --dir apps/web exec vitest run`: 864 unit tests passed; 63 database/runtime tests skipped
  because these invocations do not provide their isolated integration environments.
- `pnpm --dir apps/web exec eslint .`, `pnpm --dir apps/web typecheck`, touched-file Prettier,
  `pnpm check:repo` and `git diff --check`: passed.
- Standard Playwright suite with `NUXT_PUBLIC_ISSUER_ENABLED=0`: 85 passed; four portal navigation
  cases intentionally require the other configuration. With `NUXT_PUBLIC_ISSUER_ENABLED=1`, all
  four portal navigation cases passed. Auth configuration: two passed. Production security
  configuration: three passed. A final issuer-only run passed all eight tests, including the new
  publication-recovery failure/download regression; the three delivery cases passed again after
  correcting their fixture to the API’s actual `invited` state. These automated suites use their
  documented synthetic fixtures.
- Host production build and Docker build passed. Isolated live site `https://localhost:3445`
  uses image `sha256:e42cb5ad8701cb18a6cd68d93defae0172fdcd20f5ad174b5ec6fdeabc32fa97`.
  PostgreSQL, indexer, Identity and the previous port-3443 deployment were preserved.
- A real anonymous Brave browser followed the French home page, pasted the existing signed
  Testnet sharing link and retrieved live evidence. The public course was visible; private fields
  were absent in both HTTP and DOM. Addresses/references were hidden until opening details.
  Desktop and 390-pixel mobile screenshots were inspected; no horizontal overflow was observed.
  This manual check used no network/provider/session mocks and submitted no new ledger transaction.
- On the final image, the real issuer retained both existing recovery copies and their actions;
  references were available only after opening details. Selecting a named template carried it into
  the invitation form. No mutation was sent.
- A real recipient reconnected through Identity OIDC, opened the French accepted-attestation inbox,
  inspected the accepted attestation, then reviewed public and targeted full sharing. Audience and
  exact selected fields appeared before signing; creation remained disabled without a connected
  wallet. No new link or signature was created; the prior sharing tab was preserved.
  These issuer/recipient checks used actual accounts and stored Testnet evidence without mocks.
- CI exposed obsolete selectors in the compiled issuer and connected-journey tests after the
  wording and disclosure changes. The tests now use current locale keys and explicitly open the
  technical controls, preserving signature, recipient-address, disclosure and revocation assertions.
  All six compiled runtime scenarios then passed locally against fresh, isolated PostgreSQL18 and
  Mailpit services; nine unrelated cases were excluded by the runtime script’s test-name filter.
  Real database/SMTP/HTTP boundaries are exercised here with synthetic sessions and XRPL transports,
  separately from the manual live Testnet qualification. The isolated test services were stopped.
  CI web, package and Docker jobs passed on the preceding UI commit; the existing license-policy
  failure was confirmed unchanged.
- A subsequent CI attempt timed out in an unchanged indexer migration test. An isolated replay
  reproduced concurrent PostgreSQL role provisioning (`pg_authid_rolname_index`). Indexer test
  files now run sequentially whenever a database URL is supplied, matching `test:postgres`;
  unit-only parallelism and explicit concurrency tests remain unchanged. All 357 indexer tests
  passed against a fresh PostgreSQL18 cluster, followed by 300 unit tests with 57 expected database
  skips without a database URL. No timeout or assertion was relaxed. The final configuration and
  test corrections are revalidated by the next CI run.

Other wallet compatibility and external email delivery were not requalified by this UI change.
The optional Crossmark live configuration's selectors were updated but that separate wallet-specific
configuration was not run. Development auth tests emitted a Vite module-reload warning while still
passing; compiled production security and the live browser check passed independently. The existing
license-policy failure still keeps PR35 draft; approval and trust semantics remain unchanged.
