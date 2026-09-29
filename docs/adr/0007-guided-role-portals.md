# ADR 0007: make role portals the only web mutation journeys

Status: accepted.

## Decision

The web application exposes three task-oriented entry points: `/issuer`, `/recipient`, and
`/presentations`. Each presenter derives one next business action from server-authorized state. The
derived state is guidance only; every server mutation continues to enforce the session, role,
organization, wallet, disclosure, audience, freshness, and anti-replay rules that existed before
this decision.

The browser no longer asks a business user to enter an XRPL address, UID, hash, URI, network
profile, generation identifier, or JSON. Internal DTOs and internal URLs may retain those values so
the change requires neither a protocol change nor a database migration. Public read-only Explorer
pages, `/v1`, the CLI, and developer documentation retain their exact technical interfaces.

The former mutation pages remain only as locale-preserving redirects which discard query strings
and fragments:

| Previous path       | Destination           |
| ------------------- | --------------------- |
| `/studio`           | `/`                   |
| `/schemas/register` | `/issuer/schemas/new` |
| `/issue`            | `/issuer/recipients`  |
| `/accept`           | `/recipient`          |
| `/revoke`           | `/issuer/credentials` |
| `/verify`           | `/presentations`      |
| `/operations`       | `/account`            |

Wallet signatures remain explicit. A readable summary precedes every signature, and the existing
transaction engine rechecks the session, selected organization, wallet, recipient, network,
credential generation, and current ledger evidence immediately before and after signing. XCS does
not create, recover, or retain private keys.

Invitation and presentation bearers stay in URL fragments. The browser removes the fragment before
an API call and uses the existing one-time, HttpOnly OIDC handoff when authentication is required.
Only bearer hashes persist in PostgreSQL. Presentation authorization proofs remain distinct from
account wallet-link proofs and each sharing grant requires a fresh recipient-wallet challenge.

## Structure

Application-facing DTOs and discriminated `nextAction` values live in `app/types/portal.ts`.
Pure presenters produce issuer, recipient, and invitation progress states. Shared portal utilities
own the route allowlists, mutation state, readable errors, wallet progression, and organization
application form. They never replace repository authorization.

Issuer and verifier applications share a neutral server application domain. The issuer,
recipient, presentation, verifier, and admin repositories otherwise keep their existing boundaries;
this decision does not introduce a workflow framework or a broad repository rewrite.

## Compatibility and rollback

There is no change to the XCS protocol, ledger formats, cryptographic proof formats, public `/v1`
contracts, or migrations `0000`–`0008`. Existing bookmarks reach the new portals through the fixed
redirects, but technical query inputs are intentionally ignored.

Rollback is the previous application image. No data restoration or down migration is needed.
Operators must keep managed private payload readers available at already-issued URLs during either
version, as required by the issuer runbook.
