# Guided role portal

Goal: make `/issuer`, `/recipient`, and `/presentations` the three task-oriented entry points.
People choose business objects and explicit wallet actions; they never enter or copy XRPL addresses,
UIDs, hashes, URIs, generation/profile identifiers, or JSON in a portal journey. Public `/v1`, CLI,
and read-only explorer contracts remain unchanged.

## Constraints and non-goals

- Preserve Commons authorization, wallet-ownership and presentation proofs, current-audience checks,
  idempotency, optimistic review revisions, and pre/post-signature context validation.
- Keep fragments ephemeral and hashed server-side; do not add token storage or database migrations.
- Keep protocol DTO identifiers for internal URLs and requests, but do not label or expose them as
  user tasks.
- Do not introduce a workflow framework, new production dependency, repository-wide refactor, or
  protocol/ledger-format change.
- Work in the clean `integration/current-flow` worktree. The historical `main` worktree contains
  unrelated user changes and must remain untouched.

## Milestones

1. **Complete — portal contracts and compatibility routing.** Add application-owned view models,
   discriminated next actions, pure presenters, allowlisted portal destinations, typed problems and
   mutation state. Convert retired technical pages to locale-preserving, query-dropping redirects.
2. **Complete — role journeys.** Add the issuer next-action dashboard and wallet gates; make invitation,
   acceptance, sharing and presentation resolution continuous and business-readable; remove protocol
   panels from role journeys while retaining explicit wallet consent and context validation.
3. **Complete — applications and administration.** Share the issuer/verifier application form and
   server application domain; present admin review as a checklist and make decision notifications
   actionable without exposing protocol data.
4. **Complete — accessibility, localization and documentation.** Keep EN/FR catalogs structurally
   identical, set language/focus/live states, document the durable portal boundary in an ADR and
   synchronize user/runbook documentation.
5. **In progress — verification and closeout.** Run focused unit tests first, then web lint/typecheck/test/
   build and repository checks. Run PostgreSQL/runtime/Playwright/Docker tiers where the required
   isolated services are available; report blocked external Testnet and wallet checks precisely.

Rollback is the previous web image. No persistent data conversion or restoration is required.
