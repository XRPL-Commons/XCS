# Shared patterns and boundaries

Draft for all four journeys. The bilingual catalog supplies visible labels; the English and French
versions are reviewed together, not translated after implementation. Technical screen IDs are for
review and handoff only.

## One layout and state grammar

- One page title, one question answered, one primary action. Preserve entered non-sensitive data
  when moving back. Do not put private documents, invitation tokens or claims in browser storage.
- On mobile the result, its freshness/limitations and the next action precede expandable evidence.
  Touch targets are at least 44 CSS pixels; status always has text and never relies on color alone.
- Labels remain visible above inputs. Error summaries focus the first invalid field. Async status
  uses a live region; keyboard focus returns to the initiating control after closing a dialog.
- Loading: skeleton/list placeholder with “Loading…” / “Chargement…”, not an empty result. Prevent
  repeated submissions while work is pending. A timeout is not proof of failure on the ledger.
- Empty: bordered card, explanation and one useful next step, following the existing `EmptyState`.
  “No applications to review” / “Aucune demande à examiner” is a neutral success for an admin.
- Error: same card structure as `ExplorerError`/`StatusBox`: plain-language cause, retained context,
  safe next action. Do not show stack traces, raw payloads or internal service addresses.
- Technical detail: schema UID, addresses, transaction hash, digest, fees and preview are secondary,
  but the human-readable operation summary and fee must be visible before wallet approval.

## Status vocabulary

Reuse `StatusPill`'s success / warning / error / neutral tones. This is a proposed display mapping;
new application states need an explicit adapter, not a claim that the current component knows them.

| Meaning                             | English               | French                    | Tone / existing compatible value               |
| ----------------------------------- | --------------------- | ------------------------- | ---------------------------------------------- |
| Application awaiting review         | Awaiting review       | En attente d’examen       | warning / pending                              |
| Role grant approved                 | Access approved       | Accès autorisé            | success / accepted                             |
| Role grant refused                  | Application declined  | Demande refusée           | error / rejected                               |
| Invite awaiting claim               | Invitation sent       | Invitation envoyée        | neutral                                        |
| Invite bound to an identity         | Invitation claimed    | Invitation récupérée      | neutral                                        |
| Address ownership proven            | Wallet linked         | Portefeuille lié          | success / ready                                |
| Ledger operation unresolved         | Confirmation pending  | Confirmation en attente   | warning / pending                              |
| Credential ready for subject action | Ready to accept       | À accepter                | warning / pending                              |
| Subject acceptance validated        | Accepted              | Acceptée                  | success / accepted                             |
| Issuer revocation proved            | Revoked               | Révoquée                  | error / deleted, with deletion cause preserved |
| Time elapsed                        | Expired               | Expirée                   | warning / expired                              |
| Unable to obtain current evidence   | Cannot verify now     | Vérification indisponible | warning / unavailable                          |
| Bytes do not match                  | Content mismatch      | Contenu altéré            | error / tampered                               |
| Issuer trust not established        | Issuer not recognized | Émetteur non reconnu      | warning / unknown                              |

Do not translate every deletion to “revoked”: subject rejection/deletion and expiry are distinct.
Role approval grants access to the application; it is never a Commons endorsement or trust badge.

## Three shared failure wireframes

See [FR board](./wireframes.fr.excalidraw), [EN board](./wireframes.en.excalidraw) and the gallery.

| Screen | Trigger                                             | Message and recovery                                                            | Preserve / prohibit                                                                            |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| F1     | Wallet unavailable or unsupported                   | Explain installation/unlock, select a compatible wallet and retry detection     | Preserve form; no signature request until account/network/capability checks pass               |
| F2     | Invite expired, revoked, already claimed or invalid | Generic unusable-link result; use known issuer contact to request a replacement | Do not reveal who claimed it or whether an email has an account; never silently extend a token |
| F3     | Indexer stale/unavailable                           | Explain that current credential state cannot be checked; retry safely           | No success/valid label or new signature; retain unresolved operation and reconcile its hash    |

A revoked or invalid presentation uses the unavailable-link layout with presentation-specific copy
and “Ask the recipient to share again” / “Demander au destinataire de partager à nouveau”. It exposes
no credential details. Sharing does not expire automatically under ADR 0004; an expired credential
still shows its actual lifecycle to an authorized viewer. An expired identity session asks for
sign-in again without invalidating the recipient's grant.

## Privacy and presentation access

These are proposed constraints for the later application API. Filtering is server-side before
serialization, SSR/hydration, logs, exports and browser delivery; hiding a section in CSS is not
authorization. Recheck authenticated audience, global verifier approval, scope and revocation on
every resolution. A forwarded full-scope link never authorizes a different verifier.

| Viewer on a valid presentation                                              | Public scope  | Full scope                                     |
| --------------------------------------------------------------------------- | ------------- | ---------------------------------------------- |
| Anonymous or no current verifier approval                                   | Public fields | Public fields + sign-in/access explanation     |
| Approved verifier other than the intended audience                          | Public fields | Public fields only; no access to hidden claims |
| Designated, authenticated verifier with current global approval             | Public fields | Fields within the recipient-authorized scope   |
| Admin with no independent issuer/recipient/designated-verifier relationship | Public fields | Public fields only                             |

The recipient and issuer use their separately authorized owner detail views for full fields. Admin
status never substitutes for that relationship or for a designated verifier grant. There is no
issuer allowlist, no shared organization login and no implicit team membership authorization.

ADR 0004 now distinguishes the organization's stable identity from its responsible human account.
Private verifier access checks that the signed-in human can act for the designated organization,
that organization's current approval and the recipient grant. A personal login alone is not the
designated verifier. The initial model has one responsible user, without a team-management workflow.

For a public credential, its declared public fields are all claims; presenting it cannot undo
previous disclosure. For a private credential they are exactly the issuer-approved subset, possibly
empty. A revoked presentation URL is never revived by owner access; the owner detail view is separate.

No full payload may be downloaded to compute a public-only preview in the browser. A subset is not
independently hash-verifiable against the original full-payload digest: label payload integrity
“Not checked” if no authorized full-byte check occurred. A server-side check, if later implemented,
must identify its provenance and must not send hidden bytes. Issuer trust remains a separate
viewer decision. Approval for application access does not resolve it.

There is no automatic presentation expiry, renewal prompt, far-future sentinel expiry or single-use
control in this design. State “Until you revoke sharing” / “Jusqu’à révocation du partage” before
creation and in the active-grant list. Reopening must recheck authorization and current credential
evidence. Loss of verifier approval blocks private access immediately; restoring approval must not
revive a recipient-revoked grant. Revocation cannot erase information already retrieved.

Email is a notification and navigation aid: no private claims or documents in message subjects or
bodies. Resend/revoke invites explicitly; refreshing must not resend. Notifications and approvals
need an idempotent delivery design in #30/#31, not an optimistic “email delivered” toast.
