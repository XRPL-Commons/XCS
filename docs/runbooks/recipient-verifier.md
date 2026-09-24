# Recipient and verifier workspaces

These optional workspaces implement issues #32 and #33 under [ADR 0005](../adr/0005-role-based-application.md).
Enable the existing authentication and issuer services, with their separate restricted database
connections. No additional recipient/verifier pool or environment variable is required. Public Studio
and public verification remain accountless; portal approval does not establish issuer trust.

## Upgrade and recovery

Run the indexer's existing database migration/provisioning procedure before deploying the new web
image. Migration `0007_recipient_verifier` adds `app_verifier_history`; additive migration
`0008_presentation_wallet_proof` adds separate presentation challenges and signature proofs.
Migrations 0000–0007 remain unchanged. Reprovision `xcs_issuer` grants for challenges, proofs,
presentation creation/revocation, metadata history and readiness evidence. The projection reader, auth and admin roles gain no private-payload access.
See [application database](../database-app.md) and the [issuer runbook](issuer.md).

Rollback deploys the previous compatible web image and leaves the additive table and records intact.
Do not drop history or rewrite migration history. Payloads and application records require backups;
replaying XRPL cannot reconstruct off-chain claims or sharing grants.

## Everyday interface

With the authenticated portals enabled, the home page and main navigation offer Receive, Issue
and Verify. Technical exploration remains under More. Verification accepts the complete sharing
link, including when pasted into the verification page; it never fetches an arbitrary pasted URL.
Attestation names, organizations, readable fields and next actions are primary. Wallet addresses,
hashes, raw transactions and verification dimensions remain available in collapsed details.
Expired/revoked states, missing proofs and incomplete checks still appear before those details.
Wallet approval still requires explicit consent, including GemWallet’s coded-message limitation.
Recipient acceptance updates the available actions on the same page; removal is a secondary action.

## Issuer journey

Apply as an organization and wait for Commons' administrator decision. Issuance remains blocked
until current approval. Register/select an owned schema, send the invitation and review the actual
claimant. The workspace distinguishes invitation pending, wallet still required, ready to issue,
already issued and unavailable. Readiness is refreshed from active wallet links; it is not inferred
from possession of the invitation. The issuance review shows the delivery contact separately from
the claimant and the wallet's verification timestamp. The existing wallet engine signs issuance;
the recipient receives its notification after exact validated ledger evidence is recorded.

## Recipient journey

1. Open the invitation, sign in and explicitly claim it. The guided Account step offers only wallets
   with supported ownership signatures (GemWallet, MetaMask XRP Snap, Otsu), installation/setup
   guidance and Testnet fee information. Create/recover the wallet inside its own application; XCS
   never asks for its seed or private key. Sign the wallet-link message, then continue to the inbox.
2. Open `/recipient` for invitations, issued credentials and issuance/revocation notifications.
3. Review the exact credential. Private content requires explicit consent and an authenticated
   same-origin read. Local canonical-byte/digest/schema checks precede wallet approval; the server
   rechecks ownership, linked wallet, generation and current indexed state. Reject/remove reads no
   payload. Ledger confirmation is reconciled by exact transaction hash without another signature.
4. Choose a public link, or a currently approved verifier organization for full disclosure. Connect
   the same linked wallet and sign the explicit presentation-authorization message. This is separate
   from ledger acceptance, creates no payment and binds one exact credential, scope and audience.
   Copy the resulting link or locally generated QR code; raw tokens are returned only at creation.
5. Revoke a grant from that credential's presentation list. All active grants remain visible, up to
   200 per credential. Revoke an existing grant before creating another at the limit.

Notifications reflect indexed events, including revocations outside the portal. Email delivery
continues through the existing issuer issuance/revocation flow; an external ledger event does not
start a new mail service. Workspace lists are bounded to 200 and credential event lists to 100.
The unfiltered presentations API is a bounded recent view; the credential-specific list prioritizes
all active grants ahead of revoked history.

## Presentation and verifier journey

`/presentations#token` (also `/fr/presentations`) removes the fragment from the address bar. Reading
requires an explicit POST; merely navigating does not disclose claims. Login can carry the token in
a Secure, HttpOnly, SameSite=Lax cookie for ten minutes. The cookie is consumed after authentication;
the grant itself has no automatic expiration. Raw tokens are hashed in PostgreSQL and excluded from
history, CSV, console warnings, browser persistent storage and server URL paths/queries.

`/verifier/apply` submits an organization application through the existing document-review process.
An approved organization can open its designated full presentations and inspect `/verifier` history.
Reopening a history entry rechecks its grant, actor, organization and current approval. History and
CSV contain metadata and the four verification dimensions, never claims or tokens. CSV text cells
are protected against spreadsheet formula evaluation.

Private credentials' public views contain only issuer-selected public fields. A wrong audience or
anonymous viewer of a full link receives that public subset and an authorization hint. Already-public
credentials retain their public claims. Unknown/revoked tokens return the same unavailable response.
An administrator has no special private-view permission. Suspension blocks subsequent full access.

Opening a link requires no manually entered URI, address or schema identifier. Three factual cards
show the issuer organization's **current** portal admission, the credential's indexed lifecycle and
recipient address, and the dated recipient signature authorizing this presentation. Admission is
read from the application database; no historical approval at issuance is invented. A suspension
changes that admission result without rewriting the ledger or revoking the credential.

New presentation creation requires a separate five-minute, one-use challenge bound to the session,
site, exact credential, wallet, payload digest, public-field selection, scope and intended verifier.
The signature is checked before atomic challenge consumption and grant creation. The five-minute
challenge deadline is not a grant expiry. Legacy links remain readable with proof explicitly marked
as not provided; recreate a link to add a signature. A corrupted or mismatched stored proof makes
the link unavailable. Public keys, signed message and signature may be returned as verification
evidence; neither raw bearer tokens nor private keys are part of that proof.

The proof demonstrates control of the master key corresponding to the address at signing time.
It does not prove the viewer's identity or current presence, nor current XRPL key authority after
master-key disabling or regular-key changes. Regular-key and multisign proof schemes are not
supported. A verifier needing a new signature can ask the recipient for a newly created link.

The four dimensions remain separate: credential state, payload integrity, schema validity and issuer
trust. Configured trust policy and readiness freshness apply; approval is not trust. A public
projection cannot verify the complete payload digest and reports `not_checked` after successful
internal validation. Detected corruption still reports failure. Claims remain in browser memory;
private claims never travel through `/v1/verify`, receipt exports or the wallet recovery journal.

Revocation cannot recall copies already viewed. This is server authorization, not end-to-end
encryption: infrastructure operators and database backups remain within the trust boundary.

## Validation boundaries

See [testing](../TESTING.md) for unit, restricted-role PostgreSQL, browser and compiled HTTPS tests.
The connected runtime test submits applications and administrator approvals through real HTTP,
delivers invitations to local Mailpit and signs messages and transactions through the actual wallet
SDK with synthetic extension/RPC transports. Sessions, funded ledger accounts and indexed evidence
are local fixtures; this does not exercise live consensus or a real installed extension. A separate [live Testnet qualification](standalone-live-testnet.md) exercises actual Identity
registration, installed desktop GemWallet, live consensus and local SMTP with synthetic accounts.
Other wallets, mobile return flows, external mail delivery and representative production
user sessions still need operator qualification.
