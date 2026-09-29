# Issue #25: application data model

Status: model and helpers implemented and locally verified; maintainer review and API integration
remain pending. No live database or public route is changed.

## Goal and boundaries

Add a reviewed application model alongside the existing XRPL projections, following
[ADR 0004](adr/0005-role-based-application.md). Deliver an ERD and data dictionary in
`docs/database-app.md` linked from `docs/database.md`, Drizzle definitions under
`packages/db/src/schema/app/`, and centrally tested
private-claim visibility rules under `packages/db/src/app/visibility.ts`.

Do not change projection definitions or historical migrations. Issue #26 owns migration tooling
and rollout; issue #29 owns `docs/ux/` in another terminal. Authentication, live private hosting and
role-specific pages are subsequent implementation work, not delivered by a schema definition.

## Accepted ownership decision

Separate human accounts from organizations. An organization has one responsible user initially;
organization identity is stable independently of that user's identity. No team management or
responsibility-transfer workflow is included. This refines the original issue's organization-as-user-
profile proposal without creating a generic multi-tenant permissions framework.

Implemented domain split; exact columns and constraints are in the application dictionary:

- Accounts: identity-provider subjects, account state, verified contact information and wallet links.
- Organizations: stable identity, responsible user, issuer/verifier applications, profiles and
  approval evidence. Approval to issue does not automatically approve verifier access.
- Documents: object-storage references and review metadata, not document bytes or private claims.
- Issuance: invitations and organization-owned references to on-chain schemas and credential
  generations, with explicit network-profile identity.
- Sharing: recipient-authorized grants addressed to a verifier organization, without automatic
  expiry or issuer-specific allowlists; revocation and current approval remain enforced.

The ledger remains the lifecycle authority. An invitation is application state, not an on-chain
credential generation. Existing public hosted payloads must not be reused as private storage.

## Accepted invitation decision

Possession of a valid invitation authorizes an authenticated account to claim it without matching
the delivery email. Keep delivery email, claimant identity and proven wallet ownership separate.
Persist only the token hash, bind the claimant once through atomic redemption, and reject subsequent
claims by another account. Opening the invitation is read-only; claiming is an explicit action.
The issuer reviews the actual claimant and proven wallet before signing. A forwarded or leaked
link can be claimed by its holder first; this trade-off is explicit in ADR 0004.

## Decisions and dependencies still to resolve

- Invitation lifetime and retention remain separate from the no-expiry private-sharing policy.
- Credential visibility selection belongs to the parallel UX discussion; do not choose public versus
  private defaults or a decision-maker here without that outcome.
- Specify retention/deletion behavior for profiles, documents, invitations and account links before
  encoding cascades. Application deletion cannot delete public ledger history.
- Review application runtime grants before the authenticated API is connected. Existing `xcs_api`
  is projection-read-only; `xcs_payload_writer` is not a general application writer. The generated
  forward migration grants no new runtime access.

## Milestones

1. **Complete — settle ownership and invitation claim binding.** Accepted choices are in ADR 0004.
   Remaining product policies do not receive silent defaults: visibility is explicit, invitation
   expiry is required from the caller, and deletion remains restrictive pending retention decisions.
2. **Complete — ERD and dictionary.** Added `docs/database-app.md` with a link from `docs/database.md`,
   preserving the other terminal's #26 migration documentation. Maintainer acceptance remains an
   external review gate, not something inferred from an automated review.
3. **Complete — Drizzle model and helpers.** Ten application tables, atomic link redemption and
   current-state authorization/filtering implement the accepted decisions. The real PostgreSQL
   tests cover concurrency, replay, expiry, revocation, wrong audience/network/generation, suspended
   accounts, ownership and admin-only denial. A static review identified transaction-start expiry;
   a failing PostgreSQL regression reproduced it and now passes with `statement_timestamp()`.
4. **Complete — local verification and migration artifact.** Drizzle generated
   `0003_application_model.sql`; historical SQL/snapshots and projection definitions are unchanged.
   Fresh creation, upgrade retaining public payload bytes, repeated application and existing
   indexer/API integration suites pass. No live migration or deployment was run.

## Verification and rollout

Checks performed on 2026-09-23 in the shared worktree, including the concurrent issue #26
migration-tooling changes (which are committed separately):

- `pnpm --filter @xcs-protocol/db test` with an isolated PostgreSQL 18 URL: **89 passed**, including
  14 new claim-filter/token tests and 20 new application-model PostgreSQL tests.
- `pnpm test:postgres` on that isolated cluster: **50 passed** (32 DB, 13 indexer, 5 API). The first
  wider run rejected the disposable administrator password's length; rerun with a compliant test
  password passed without weakening validation.
- `pnpm typecheck` and `pnpm lint`: pass across all six packages (unchanged packages may use Turbo
  cache); `pnpm --filter @xcs-protocol/db build`: pass.
- `pnpm --filter @xcs-protocol/db db:generate`: no new migration; SQL, snapshot and journal bytes
  unchanged by regeneration. Focused Prettier checks and `git diff --check`: pass.
- Historical migration/snapshot and existing projection source diff: empty. A regression assertion
  also compares every existing table definition between snapshots 0002 and 0003.

No browser, live wallet or XRP Identity flow was tested: this work adds no UI/authentication route.
No new dependencies or deployment. The tests used only disposable synthetic records.

Before committing, the staged #25 tree was exported separately from the concurrent #26 work:
54 database unit tests passed, followed by all 20 application-model tests on disposable PostgreSQL 18. Database typecheck and build also passed against that isolated tree; staged file formatting
and whitespace checks passed.

The intended rollout is additive: provision application tables and least-privilege runtime grants
before deploying consumers. Existing projection reads must continue to work. Once application data
exists, prefer application rollback or a forward fix over dropping populated tables. No live
database operation was performed by this implementation. Application-role provisioning, private
object delivery, retention schedules and end-to-end authentication remain separate release gates.
