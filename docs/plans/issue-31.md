# Issue 31 — issuer workspace

## Goal and baseline

Deliver the issuer journey I1–I6 using the existing wallet signing and ledger-confirmation engine:
application with private documents, own schemas, email invitations, derived recipient wallets,
public/private issuance, tracking and revocation. Keep the accountless Studio working.

Worktree `.data/xcs-issuer31`, branch `issue/31-issuer`, starts at admin commit `4e39747`.
Port the final #27 corrections from `2818ef2`; preserve both other worktrees and active services.
The admin commit contains the earlier auth snapshot, so its dependency version, account reactivity,
CSP assertion and missing auth documentation must be reconciled before validation.

Sources: [issue #31](https://github.com/XRPL-Commons/XCS/issues/31), issuer UX boards and ADR 0004.

## Decisions and boundaries

- New accounts may submit applications. Only the current responsible user of an active, approved
  issuer organization may publish its schemas, invite, issue or revoke through this workspace.
  Server transactions recheck the session, approval, ownership and exact ledger evidence.
- Add migration 0006 after admin 0005 and a dedicated restricted issuer pool. Existing public pools
  never acquire access to private application payload bytes.
- Managed payloads live in private PostgreSQL storage, bounded to 1 MiB, with full canonical bytes
  and their digest. The on-chain HTTPS URI resolves through authorization-aware application routes.
  Private full bytes never enter public hosting or browser persistence. Public subsets are claims
  projections, not full-payload digest proofs. Admin role alone grants no access.
- Review documents use the existing private document directory, opaque server filenames and
  bounded PDF/PNG/JPEG validation. Their upload requires a private writable volume.
- Reuse the admin SMTP transport, with separate issuer delivery records. Invitation tokens exist
  in memory during delivery and only their hashes persist. An explicit resend rotates the link;
  uncertain delivery is never retried automatically. No actual email is sent outside local fixtures.
- Invitation lifetime defaults to seven days, configurable; no alternative preference was received.
  This is distinct from recipient sharing, which has no automatic expiry under ADR 0004.
- Minimal invitation preview/explicit claim allows the email link to work; full recipient inbox,
  acceptance workspace and presentation management belong to #32. OIDC activation remains pending
  actual client registration; automated flows use isolated fixtures.

## Milestones

1. **Complete:** scope, dependency audit, isolated branch and API/storage contracts.
2. **Complete:** persistence, restricted grants, bounded document storage, mail and HTTP endpoints.
3. **Complete:** bilingual application/workspace and existing signing-engine integration.
4. **Complete:** PostgreSQL ownership/privacy/concurrency tests, mail failures, browser flows,
   regression/static/build checks and production images with Compose overlays.
5. **Complete:** deployment/retention documentation, actual evidence and residual limitations.

## Recovery and verification

Use dedicated disposable PostgreSQL, Mailpit and browser ports. Never migrate the running pilot.
Private payload preparation is separate from signing; metadata recovery after a validated ledger
transaction must reuse its transaction hash and not ask for a second issuance. Apply additive
migrations before enabling the workspace. Disabling it retains ledger state, payloads, application
records and existing public routes; use forward fixes rather than destructive rollback.

## Verification evidence

Validated on the isolated worktree and disposable services; no pilot migration or external mail.

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: passed; 1,024 unit tests.
- `pnpm test:postgres` with a dedicated cluster: 87 tests passed across DB, indexer and web.
- Compiled Nitro runtime: issuer HTTPS/SMTP journey, admin regression and two public API/SSR tests
  passed. Sessions, approval and indexed ledger events are synthetic; issuer HTTP calls are real.
- Browser suites: 58 tests passed (53 general, 2 auth and 3 production security), covering Studio,
  admin, issuer, native IndexedDB invitation concurrency, OIDC fixture login/wallet linking and CSP.
- Both production images built. Database bootstrap and Nuxt startup passed as UID1000 with
  mounted secret files, read-only root, writable private document directory, issuer authorization
  denial, payload lookup and public liveness checks. Compose overlay/profile checks passed.
- Global `pnpm format:check` reports only the unchanged baseline `docs/issue-25-plan.md`;
  changed-file formatting and `git diff --check` pass.

Review also corrected document cleanup after an ambiguous COMMIT (three regression tests),
invitation exclusion across browser tabs, and account actions exposed before hydration.

Release checks still require a registered Identity client, real extension-wallet consent and a
qualified external SMTP provider. Invitation signing exclusion is browser-profile-local; concurrent
devices require a future server-side reservation. Recipient inbox/acceptance and presentation
workspaces remain #32/#33. The user subsequently requested committing and pushing this work into the consolidated PR #35.
This publication does not deploy or enable a running service.

## PR #35 consolidation follow-up

Issuer commit `d8c5a2c` includes the completed issuer implementation, the restored auth testing
section/runbook, the admin handoff note and the existing Playwright locale instruction from #27/#30.
Merge `9a31c17` records both independent auth/admin histories without changing that validated tree.
Commit `cb6c3d8` fixes the inherited plan formatting and builds the SDK before PostgreSQL tests.

`pnpm verify` now passes in full, including global formatting and all 1,024 unit tests. A new checkout
with no SDK build output also passes all 87 PostgreSQL tests with local SMTP enabled. The first
repeat encountered cleanup dependencies left by our earlier Docker smoke database; removing only
that recorded disposable database restored the isolated test boundary, with no product change.

The 58 browser and four runtime results above still apply: consolidation changes only documentation,
Git ancestry and the PostgreSQL validation command. Immutable Actions pinning (33 references) and
actionlint v1.7.12 pass. The current license policy fails on three `Unknown` entries
(`@gemwallet/api@3.8.0`, `@walletconnect/types@2.24.0`, `vaul-vue@0.4.1`) and `nodemailer@10.0.10`
(`MIT-0`, not allowlisted). The policy is unchanged; keep the aggregate PR in draft for review.
