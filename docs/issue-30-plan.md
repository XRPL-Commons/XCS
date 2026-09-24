# Issue 30 — organization access administration

Status: archived preparation notes. Implementation and current validation are recorded in
[the completed admin plan](plans/issue-30.md). The reconciliation with #27 is included in the
consolidated PR #35; the notes below preserve the earlier handoff context.

## Sources and prerequisites

The local [admin journey](ux/admin/README.md) and [ADR 0004](adr/0005-role-based-application.md)
define the intended boundary. The live issue was retrieved on 2026-09-23 after transient GitHub
API failures. It requires admin bootstrapping, A1–A4, expiring document links, exactly one email per
decision and non-admin rejection. ADR 0004 supersedes its per-issuer allowlist requirement.

Issue #27 supplies sessions, current personal admin grants, role middleware and CSRF protection.
Its changes are committed and pushed as `2818ef2` on `issue/28-nuxt-api`. Real OIDC registration
remains an activation prerequisite, not a prerequisite for isolated implementation tests.

The existing `.data/xcs-admin30` worktree on `issue/30-admin` contains uncommitted admin
implementation and its own `docs/plans/issue-30.md`. It started from `ee39ba5` with a copied #27
snapshot. Preserve that work; reconcile it with committed #27 before integration. The milestones
below describe this preparatory plan, not the status of that other worktree. No admin implementation
or tests from that worktree were changed or rerun here.

## Goal and non-goals

Provide bilingual A1–A4 screens: oldest-first application queue, application review, global verifier
approval management and metadata-only audit history. Admin authorization must be enforced by the
server on every request, including document access and concurrent mutations.

No issuer-specific verifier allowlist, private-claim override, ledger permission change, automatic
admin enrollment or organization ownership transfer. Public routes remain available.

## Repository evidence

- `packages/db/src/schema/app/organizations.ts` already stores organization profiles, per-role
  applications, current review decisions and private document metadata.
- Application identity is `(organization_id, role)`, not a standalone application UUID. Routes must
  preserve that identity rather than assuming the draft `:id` represents an existing primary key.
- The schema requires a reason for rejection/suspension and records the reviewer and review time.
  It does not provide a decision history, notification outbox or document-access token table.
- `xcs_app` currently has only authentication grants; it cannot write application decisions.
- No email delivery adapter or private review-document object storage was found in the inspected
  server, database and Compose configuration. Choose and document these integration boundaries
  before promising sent notifications or usable document links.

## Milestones

1. **In progress — scope:** reconcile the live issue, confirm the notification and document-storage
   contracts, and inventory the exact grants needed. Preserve the accepted ADR decisions.
2. **Pending — persistence:** add a forward migration for decision history and any required delivery
   state. Implement atomic conditional transitions with audit and delivery intent in one transaction.
   Concurrent reviewers must not overwrite an already-recorded decision or duplicate notifications.
3. **Pending — server:** add admin-only bounded list/detail/mutation endpoints. Recheck the actor's
   current admin role inside mutations; use exact-origin CSRF and explicit allowed transitions.
   Document access must expire, remain authorized and expose neither storage keys nor private claims.
4. **Pending — interface:** implement FR/EN A1–A4, reason validation, empty/error states, concurrent
   decision feedback, access revocation and notification retry without repeating the decision.
5. **Pending — verification:** test non-admin rejection, revoked/expired sessions, audit integrity,
   concurrent decisions, notification failure/retry, expiring document access and unchanged public
   flows. Run PostgreSQL, browser, static and affected production-image checks.

## Rollout and recovery

Apply additive migrations and provision only the required privileges before enabling the admin
screens. Seed the first administrator through an explicit operator procedure, never provider roles
or public signup. Configure private storage and notification delivery before advertising them as
available. Disabling the feature must preserve recorded decisions and audit history; recover through
forward fixes rather than deleting populated application tables.
