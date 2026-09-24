# ADR 0005: role-based application boundary

Status: accepted. Optional authentication, admin approval, issuer, recipient/presentation and
verifier workspaces are implemented.

Date: 2026-09-23

Tracks [issue #24](https://github.com/XRPL-Commons/XCS/issues/24).

## Context

[ADR 0002](0002-public-product-and-discovery.md) defines the public discovery and accountless Studio
boundary. Optional accounts and operator-approved roles now coexist with those public routes.
This record distinguishes accepted access decisions from their implementation: authentication,
admin review, issuer onboarding/issuance, recipient acceptance/sharing and verifier history are
implemented alongside the accountless public routes.

## Accepted decision: portal approval, not protocol permission

Option A was selected: an organization must apply and receive an administrator's approval before
publishing schemas or issuing credentials through the optional issuer portal. Verifiers
also apply for an approved role; access to private details additionally requires the recipient's
authorization as defined below.

Recipients claim an issuer's invitation, link their own wallet and accept the credential through
that wallet. Public schema discovery and exact public credential verification remain available
without an application account. An approved verifier role is not required to check public evidence.

Approval means permission to use the relevant portal features, not Commons endorsement of an
organization, its claims or the trustworthiness of a credential.

These restrictions belong to the Commons application, not the XCS protocol. Independent operators
can deploy their own instance and choose their admission policy without Commons approval.
Permissionless XRPL schema registration and credential transactions remain possible outside the
portal. The indexer must not reject otherwise valid protocol records because their issuer lacks a
Commons account or approval.

## Invariants

- Validated XRPL ledgers remain authoritative for schemas and credential lifecycle.
- Application accounts, invitations and approvals do not redefine protocol validity.
- Signing keys remain in user wallets through the XRPL Connect sign-only boundary.
- Public discovery does not become a subject-wide credential directory or a claims search engine.
- Private claims must not be exposed by public APIs, search or ledger projections. Public on-chain
  metadata cannot become private through an application visibility setting.

## Accepted decision: organizations are distinct from user accounts

For issue #25, option A was selected: an organization has its own stable application identity,
separate from the human account that manages it. The first version has one responsible user per
organization, without team invitations, shared logins or a general membership/permissions system.

Application ownership of an organization's schemas and its identity as the designated verifier
must reference the organization, not be conflated with its responsible user's personal identity.
Private access requires an authenticated user authorized to act for that specific organization,
its current verifier approval and the recipient's matching sharing grant.

This application ownership does not replace the XRPL publisher or issuer address and does not
prove control of an organization's signing wallet. Linking a wallet still requires proof of control.
Changing the responsible user must not silently transfer wallet control or rewrite ledger history;
an ownership-transfer workflow is outside this initial scope.

## Accepted decision: invitation possession authorizes claiming

For issue #25, option B was selected: any authenticated account holding a valid, unclaimed
invitation link may claim it. The account does not need to prove ownership of the invited email
address. That address is a delivery contact, not evidence of the claimant's identity or ownership
of their account. Claiming an invitation must not mark an email as verified.

Claiming requires an explicit authenticated action, not opening the link or following an email
scanner's request. Bind the invitation atomically to the first successful claimant; replay or a
concurrent claim cannot assign it to a second account. Store only the token hash, generate tokens
with a standard cryptographically secure random source, and exclude raw tokens from logs and
analytics. Revoked or expired invitations cannot be claimed. The exact invitation lifetime remains
a separate decision from unlimited private sharing.

The claimant must still prove control of a linked wallet before issuance. Claiming does not emit
or accept a credential: those remain separate wallet-authorized actions. The issuer must see the
actual claimant and verified wallet before signing, rather than treating the delivery email as
proof that the intended person claimed the link.

Forwarding or leaking an unclaimed invitation can therefore let another account claim it. This is
the accepted trade-off of the link-based policy; single-use redemption does not prevent a stolen
link from being used first. It never changes the separate requirement that private presentations
be bound to a designated, approved verifier.

## Accepted decision: recipient-authorized verifier access

Option B was selected: an approved verifier must also have a recipient-authorized presentation
to access a credential's private details. Approval alone, knowledge of an exact credential reference,
or the credential's on-chain acceptance is not consent to disclose private claims.

This deliberately narrows issue #24's proposed approved-verifier access. The grant must be limited
to the credential and disclosure scope authorized by its recipient, and revocable.
The server must check both the verifier's current approval and the presentation's current validity
before returning private data. Revocation prevents further access; it cannot erase copies
already retrieved. Revoking a presentation does not revoke the on-chain credential.

## Accepted decision: bind sharing to a specific verifier

Option A was selected: the recipient chooses the verifier organization when authorizing a private
presentation. Access is bound to that verifier's application identity and requires authentication;
another approved verifier cannot use a forwarded link to read the private details. Possession of
the link is not an access grant by itself.

The server must match the authenticated verifier identity to the presentation's intended audience
as well as checking approval, disclosure scope and revocation. The audience must be bound
to a stable application identifier, not merely a display name or a client-supplied organization.
This decision does not introduce shared logins or an organization-wide team membership model.

## Accepted decision: no automatic sharing expiry

The recipient's sharing authorization has no automatic time limit or renewal requirement. It
remains revocable by the recipient, and access still requires the designated verifier's authenticated
identity and current approval on every request. Loss of approval blocks access even when the
recipient has not revoked the grant.

This replaces the earlier time-bounded sharing proposal. Do not implement an implicit presentation
TTL or use a distant sentinel date to represent unlimited duration. Authentication sessions may
still expire and require sign-in again; that is independent of the sharing authorization.

Unlimited sharing does not extend a credential's validity, undo its on-chain revocation or guarantee
permanent payload availability. Verification must continue to report the actual credential state.

## Accepted decision: no automatic administrator access

Option A was selected: the application administrator role grants no automatic access to private
credential claims. Managing accounts and approvals must not bypass the private-data authorization
checks or expose claims through administrative views, exports or support tooling.

An administrator seeking access as a verifier must hold an approved verifier role and receive a
recipient-authorized presentation addressed to that verifier identity, under the same rules as
other verifiers. An administrator who is independently the credential's issuer or recipient relies
on that relationship, not on an administrator override.

This is an application authorization boundary, not a claim of end-to-end encryption or protection
against privileged infrastructure operators. Access to application-review documents is a separate
administrative function and must not be confused with access to private credential claims.

## Accepted decision: global verifier approval, no issuer allowlist

Option A was selected: global portal approval is sufficient for a verifier to be eligible for a
recipient's sharing grant. Access still requires authentication as the designated verifier and a
non-revoked grant covering the credential and requested disclosure scope. Global approval alone
never grants access to private claims.

There is no additional per-issuer verifier allowlist. Do not introduce an issuer-verifier approval
table, issuer-specific access gate or allowlist management screen for this flow. This changes the
per-issuer allowlist proposal in issues #25 and #30; implementation must follow this decision.

## Implementation status

### Managed issuer payload storage (#31)

The issuer workspace stores canonical payload bytes in private PostgreSQL application tables through
a separate restricted `xcs_issuer` connection. The on-chain HTTPS URI uses an opaque `/q/` locator
and the digest of the full canonical bytes. Publication records are bound to an exact validated
credential generation, schema, issuer wallet and recipient wallet before disclosure begins.

For private credentials, the issuer's current responsible account and the recipient may retrieve
full bytes. Anonymous requests receive only the issuer-selected public claim fields after validated
issuance; full payload digests cannot be verified from this projection. Administrator status confers
no extra access. Verifier presentation endpoints use the same authorization boundary, including
the recipient's designated audience, current approval and revocation.

Private bytes are never written to the accountless public hosting endpoint or browser recovery
storage. This is application authorization, not end-to-end encryption: database administrators and
backups can contain full payloads. Public disclosure is irreversible in practice; a later setting
cannot recall copies. Keep private backups and document their retention with the deployment.

The recipient workspace reviews private bytes only after explicit consent, using same-origin
authenticated reads and local digest/schema checks. Private claims never pass through `/v1/verify`.
Existing accountless Studio routes and previously public payloads retain their public behavior.

Issue #25 implements the [application data model and server-side helpers](../database-app.md).
Issue #27 adds optional authentication, sessions and wallet linking; see the [authentication runbook](../runbooks/authentication.md).
Issues #30 and #31 add admin approval and the issuer workspace, including authorization-aware
private payload reads and role-protected mutations; see the [issuer runbook](../runbooks/issuer.md).
Issues #32 and #33 add recipient presentations and verifier application/history; see the
[recipient/verifier runbook](../runbooks/recipient-verifier.md).

## Presentation boundary (#32 / #33)

Recipients create public projections or full presentations for a designated verifier organization.
A private credential's public presentation always contains only issuer-selected public fields, even
for its owner. Already-public credentials retain their public claims. Anonymous or wrong-audience
viewers of a full grant receive the public projection and an authorization hint. Revoked or unknown
grants return the same unavailable response. Successful authorized resolution holds the grant lock
through disclosure and metadata-history insertion, serializing revocation against that disclosure.

The recipient sees all active links for each credential and can revoke them. Creation is limited to
200 active links per credential under a transaction lock; revoked history is bounded. Tokens are
returned once and stored only as hashes. `/presentations#token` removes the fragment before an
explicit POST. Login handoff uses a ten-minute Secure, HttpOnly, SameSite=Lax cookie; its expiry
is independent of the unlimited sharing grant. No token or private claim enters browser recovery.

Verifier history and CSV contain metadata and verification dimensions, never claims or bearer tokens.
Reopening history is an authenticated CSRF-protected POST that rechecks current grant and approval.
Portal approval remains distinct from issuer trust. Projected public claims cannot prove full-payload
integrity: successful internal validation is exposed as `not_checked` for that partial view.

## Dated holder proof and visible portal admission

The completed issuer/recipient/verifier journey shows current portal admission as a factual
application status, separate from issuer trust and ledger verification. It does not infer approval
at issuance from the current organization row or endorse the truth of claims. The presentation link
resolves all technical references; the viewer does not enter an address, URI or schema manually.

Each new presentation requires a fresh text signature from the credential subject's currently linked
wallet. Its server-generated challenge is purpose-separated from wallet linking and binds the exact
credential, site, scope, audience and public disclosure. Atomic consumption prevents replay or a
second grant from the same signature. The challenge expires after five minutes, independently of
the existing unlimited, revocable grant. Signature evidence is stored separately from metadata-only
verification history and is checked again on resolution. Legacy unsigned links are explicitly marked
as lacking this evidence; they do not inherit a proof from the account's earlier wallet-link event.

This is a dated master-key signature, not proof of the current visitor's identity, current wallet
presence or current ledger authorization after master-key disabling. Existing private-field audience
checks remain mandatory even with a valid signature. Anonymous minimal verification remains available.
