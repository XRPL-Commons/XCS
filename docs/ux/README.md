# Role-based journeys — issue #29

Status: design draft for review. No participant sessions have taken place. These screens describe
proposed behavior for issues #30–33, not functionality implemented by this change.

On 2026-09-23 the user deferred the participant sessions and requested the next implementation
issue. Work may proceed; the research criterion remains unperformed, not passed.

Baseline: `6aa23f5` (issue #28, API served by Nuxt/Nitro). The application remains accountless today.
[ADR 0005](../adr/0006-nuxt-api-boundary.md) implements the transport boundary only; the role-based
ADR 0004 (`docs/adr/0005-role-based-application.md`), prepared concurrently for
[#24](https://github.com/XRPL-Commons/XCS/issues/24), records accepted product decisions in the local
checkout and will be committed separately with that work. This
draft follows that ADR, including where it supersedes the original issue text: designated verifier,
global approval, revocable sharing without automatic expiry, and no implicit admin access.

## Review the designs

Open [the local gallery](./index.html) in a browser: choose French or English, then a role. It is an
offline, static review artifact with fictional examples; buttons drawn inside screens do not perform
transactions. Each role has editable Excalidraw boards and one SVG per screen, in both languages.

| Role      | Journey, screen inventory and wireframes                            | Implementing issue                                   |
| --------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Admin     | [Review applications and manage access](./admin/README.md)          | [#30](https://github.com/XRPL-Commons/XCS/issues/30) |
| Issuer    | [Apply, publish, invite and issue](./issuer/README.md)              | [#31](https://github.com/XRPL-Commons/XCS/issues/31) |
| Recipient | [Claim, link, accept and present](./recipient/README.md)            | [#32](https://github.com/XRPL-Commons/XCS/issues/32) |
| Verifier  | [Read a result and request authorized detail](./verifier/README.md) | [#33](https://github.com/XRPL-Commons/XCS/issues/33) |

[Shared patterns](./shared/README.md) define states, bilingual copy and privacy rules.
[Usability sessions](./usability.md) contains the test script and the unfilled evidence register.
[Issue handoffs](./handoffs.md) contains screen lists and links ready for the four implementation
issues. Those GitHub issue bodies have not been edited.

## Scope and working assumptions

- Course completion is the first fictional example; diploma is the second schema template. Names,
  organizations and dates in screens are synthetic. No real identities, invitation tokens or claims.
- Users may hold multiple roles and switch workspace. XRP Identity sign-in and wallet connection
  are distinct: an identity session does not prove control of an XRPL address.
- Schema selection derives the schema UID. The claimed invite and verified wallet derive the
  recipient address. Technical evidence remains available in a secondary disclosure.
- Signing stays in the wallet. Submission is not success until validated ledger evidence exists.
  Unknown outcomes resume the original operation instead of prompting a duplicate signature.
- Private means restricted off-ledger fields, not an invisible XRPL transaction. Issuer, subject,
  schema reference and ledger lifecycle remain public. Nothing erases ledger history.
- An issuer selects public/private visibility and the public subset at issuance. A recipient can
  narrow a presentation's scope; they cannot make an already public payload private. For private
  sharing, the recipient chooses a globally approved verifier, bound to its stable application
  identity. Both that authenticated identity and the current recipient grant are checked per access.
- Default presentation scope is public. Sharing has no automatic expiry or renewal and remains
  revocable; credential expiry and session expiry still apply independently. No single-use control,
  implicit TTL or per-issuer verifier allowlist is introduced. A QR carries the same link, not extra
  authorization. No public subject feed or claim search is introduced.
- Private payload storage and application authorization are dependencies of #25/#27/#31/#33.
  Existing public payload hosting must never be used as a shortcut for private credentials.

## Plan and completion gates

| Milestone                                          | Status                 | Evidence / next step                                           |
| -------------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| Inventory current pages and protocol constraints   | Complete               | Baseline and route table below; per-role simplification tables |
| Draft four journeys, failures and EN/FR wireframes | Complete               | Role folders; shared screen catalog and renderer               |
| Verify exports, links, mobile layout and handoffs  | Complete               | Actual check results recorded below                            |
| Observe two people per role and revise             | Pending external input | Eight sessions in [usability.md](./usability.md)               |
| Maintainer reviews UX and links flow issues        | Pending review         | Follow accepted ADR 0004; publish [handoffs.md](./handoffs.md) |

Changes are confined to `docs/ux/`. No production routes, translations, schema, dependencies,
services or deployment files are changed. Rollback is removal of this new design directory only;
no application or persistent data rollback is involved.

## Existing pages: preserve or adapt

Paths below are existing Nuxt pages. Role paths in the journey documents are proposals, not routes
available in this checkout. Keep the accountless Studio until ADR 0004 explicitly retires it.

| Existing route               | Decision for this design                                           | Future role use                                                       |
| ---------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `/`                          | Keep public Explorer entry and aggregate overview                  | Add a separate signed-in workspace entry later                        |
| `/schemas`, `/schemas/:uid`  | Keep public permissionless discovery and exact schema detail       | Issuer workspace filters its own registered schemas                   |
| `/search`                    | Keep exact credential lookup and schema discovery; no subject feed | Role pickers use owned records, not public claim search               |
| `/activity`                  | Keep public schema registration activity                           | Never replace with a public recipient activity feed                   |
| `/transactions/:hash`        | Keep exact public ledger evidence                                  | Secondary technical details after an operation                        |
| `/credentials/:generationId` | Keep exact ledger metadata and consented public payload review     | Private payload bytes must remain behind application authorization    |
| `/verify`                    | Keep accountless exact verification and separate dimensions        | New `/p/:token` offers presentation-aware, authorized views           |
| `/status`                    | Keep public network readiness                                      | Shared degraded-state link; do not expose infrastructure internals    |
| `/learn`, `/developers`      | Keep public learning and REST documentation                        | Explain role features separately once implemented                     |
| `/studio`                    | Keep existing accountless action hub                               | Add separate role workspaces; do not require login here yet           |
| `/schemas/register`          | Keep accountless guided/advanced editor                            | Reuse templates inside issuer schema step I3                          |
| `/issue`                     | Keep current public-payload unit issuance                          | I5 derives recipient/schema and adds private-hosting prerequisites    |
| `/credentials`               | Keep current connected-wallet inbox of unaccepted credentials      | R3 proposes a session-owned inbox including accepted/history states   |
| `/accept`                    | Keep exact accept/reject and payload consent boundaries            | R4 embeds the same review and wallet-signing engine                   |
| `/revoke`                    | Keep wallet-authorized deletion                                    | I6 provides an owned-credential entry and confirmation                |
| `/operations`                | Keep local signed-operation recovery                               | Role views link to unresolved work; no claim of cross-device recovery |

Current sources: [pages](../../apps/web/app/pages),
[credential review](../../apps/web/app/utils/credentialReview.ts),
[status tones](../../apps/web/app/components/StatusPill.vue),
[API surfaces](../api-surfaces.md). Nothing here overrides frozen protocol semantics or the existing
exact-lookup privacy boundary.

## Edit and regenerate

The bilingual [screen catalog](./screens.json) is the editable source for all visual exports. Edit
copy there and behavior in the role README; regenerate rather than editing SVG/Excalidraw output.

```sh
node docs/ux/render-wireframes.mjs
pnpm exec prettier --write docs/ux
pnpm exec prettier --check docs/ux
node docs/ux/render-wireframes.mjs --check
```

The renderer uses only Node built-ins. Its `.excalidraw` files follow the
[Excalidraw scene format](https://docs.excalidraw.com/docs/codebase/json-schema). Import a board into
Excalidraw for collaborative review; port accepted edits back into the catalog to keep exports in
sync. SVG exports and the HTML gallery also work without an editor or external requests.

## Verification evidence

On 2026-09-23, for this design directory:

| Check                                 | Command or method                                                               | Result                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Formatting                            | `pnpm exec prettier --check docs/ux`                                            | Passed for Markdown, HTML, JSON and MJS; SVG and Excalidraw have no configured formatter                                 |
| Export synchronization                | `node docs/ux/render-wireframes.mjs --check`                                    | Passed: 22 bilingual screens, 44 SVGs, 10 native boards and one gallery                                                  |
| Renderer syntax                       | `node --check docs/ux/render-wireframes.mjs`                                    | Passed                                                                                                                   |
| References and native scene structure | Local Markdown/HTML link walk, JSON parsing, unique element IDs and dimensions  | Passed: 59 local Markdown links; 10 scene files                                                                          |
| Browser rendering                     | Installed Playwright/Chromium against local files, 390 × 844 and 1440 × 1000    | Passed: FR/EN toggle, image loading, all SVG text bounds, no horizontal overflow, JavaScript errors or external requests |
| Visual review                         | Gallery plus public-verifier, recipient-review and presentation SVG screenshots | Reviewed; headline and its qualification precede details on mobile                                                       |
| Product consistency                   | Read-only comparison of role docs and catalog with accepted ADR 0004            | No remaining audience/approval/duration/admin-access contradiction found                                                 |

Chromium's initial launch was blocked by the sandbox; the checks above ran successfully with
permission outside it. Excalidraw JSON structure was checked, but import into the Excalidraw editor
was not manually exercised. No application unit, integration, wallet or production build suite was
rerun for this documentation-only change. No real participants have tested these screens.

Automated artifact checks are not usability validation, real-wallet testing or evidence that
role-based product behavior has been implemented. The accepted ADR and adjacent documentation
appeared through concurrent work; they were read for alignment and not edited by this task.
