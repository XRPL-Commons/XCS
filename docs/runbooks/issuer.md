> Deployment update: applications install independently (`pnpm --dir apps/web install --ignore-workspace --frozen-lockfile`).
> Use the [standalone deployment runbook](deployment.md) and per-app environment contracts.
> Previous production secret-file Compose overlays are retired; the local application overlay is `docker-compose.application.yml`.

# Issuer workspace

The issuer portal provides onboarding, owned templates, invitations, managed payloads and issuance
tracking. It derives one next action at `/issuer`; the former public mutation pages now redirect to
the role portals. Real OIDC registration, external delivery and extension-wallet approvals remain
separate release checks.

## Provision and enable

Apply migration `0006_issuer_workspace` after auth 0004 and admin 0005. Create the managed
`xcs_issuer` user in DigitalOcean, store its generated URL as `NUXT_ISSUER_DATABASE_URL`, then run
the grants-only bootstrap. Supplying the complete issuer and auth contracts enables the workspace.
The restricted `xcs_issuer` pool cannot approve applications, grant admins or modify the projection.

| Variable                             | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `NUXT_ISSUER_DATABASE_URL` / `_FILE` | Private `xcs_issuer` connection                             |
| `XCS_DOCUMENT_STORAGE_DRIVER`        | `filesystem` locally; `s3` in production                    |
| `XCS_DOCUMENT_FILESYSTEM_DIRECTORY`  | Absolute local-only directory shared with admin review      |
| `XCS_DOCUMENT_S3_*`                  | Private bucket endpoint, region, prefix and object key      |
| `XCS_SMTP_*`                         | TLS mode, credentials and verified sender for external SMTP |
| `XCS_AUTH_ORIGIN`                    | Exact HTTPS origin for invitation and payload URLs          |

Never expose credentials in `NUXT_PUBLIC_*`. Browser navigation is derived from the validated server
contract. Payload URIs must fit XRPL's 128-byte limit including the digest; use a short HTTPS origin.

For local validation, supply the variables named by `docker-compose.application.yml`, then render:

```sh
docker compose -f docker-compose.yml -f docker-compose.application.yml config --quiet
```

Run the grants-only PRE_DEPLOY component after DigitalOcean has created all eight users. Production
uses managed PostgreSQL, a private S3-compatible bucket and an external
SMTP provider with `starttls` or `tls`; filesystem storage and Mailpit remain local-only. Use a bucket
key limited to Read/Write/Delete Objects, keep the bucket private and back up its objects together
with database metadata. Qualify the sender domain and provider delivery before inviting users. The
deployment operator must register the exact HTTPS origin with the OIDC provider.

## Application and approval

`/issuer/apply` accepts organization information and bounded PDF/PNG/JPEG documents. Opaque filenames,
restrictive modes and recorded MIME/length/digest support the existing verified admin reader.
Organizations start pending. `/issuer/application` shows the actual status and decision reason.
Approval grants portal permission, not endorsement; ordinary signup cannot grant admin.

Approved users navigate templates, recipients, credentials and settings. Template creation and
issuance first require a linked Testnet issuer wallet. The server derives the
organization owner from the session and checks current approval on mutations. Schema association
requires an accepted indexed registration and a linked publisher wallet. The public and issuer
pages reuse the same signing components; URL parameters are never treated as authorization.

## Invitations and delivery

Invitations select an owned schema and one delivery mailbox. Their random bearer is in a URL
fragment, absent from HTTP requests and referrers. Only its hash persists; email construction keeps
the bearer in memory. The claim page removes the fragment and does not persist it in browser
storage. Signed-out users sign in and reopen their email link. Preview does not claim: the explicit
authenticated button performs the atomic claim.

Any authenticated holder may claim an unclaimed link. The delivery email is not identity evidence
and is never marked verified. Review the actual claimant and linked wallet before signing. The
minimal claim page links to account wallet settings; the full recipient inbox/presentation flow is
issue #32. Invite expiration limits claiming, not an already claimed recipient or unlimited sharing.

Resend requires confirmation, rotates the token and renews the deadline. Only unclaimed, unrevoked
invitations may be resent or revoked. An already-issued invitation cannot issue again. Email
delivery, claiming, wallet readiness and ledger acceptance are separate states.

Invitation mail contains the organization, template, expiry, one action link and a wallet-safety
warning; it contains no protocol identifier. SMTP attempts are recorded before sending. Lost acknowledgement/timeout produces `uncertain`,
never automatic retry. Interrupted `sending` records are shown as uncertain after their bound.
Issuance/revocation notifications target the actual claimant's current verified email, not an
unverified delivery contact. A missing verified address blocks notification without undoing the
ledger operation. Do not log SMTP bodies, fragments or payload bytes.

## Private payloads and recovery

Private is the initial choice. Review the public-field and full-authorized previews before signing.
Public disclosure cannot recall downloaded copies. On-chain addresses, schema, opaque URI and full
digest remain public in both modes.

Canonical payload bytes are in private PostgreSQL application storage, bounded to 1 MiB. Drafts are
visible only to the currently authorized preparing issuer. Recording checks the exact indexed
generation, profile, schema, issuer, subject, URI and digest. `/q/:locator` then returns full bytes
to authorized issuer/recipient accounts, or only selected public claims for an anonymous private
credential view. Filtered responses carry `x-xcs-claim-scope: public`; they do not verify the complete
payload digest. Responses are `private, no-store`.

Admin alone grants no access. Verifier presentation routes remain #33 and must also require current
approval and the recipient's matching designated grant. Public API/hosting roles cannot read the
private tables. Database operators and backups can contain full claims: this is not end-to-end
encryption. Preserve private backup and retention controls.

Signing retains existing profile/account/network/freshness checks. Recording follows validated
ledger evidence. Recovery stores only user-scoped operation references, transaction hashes and
visibility selectors, never claims or bearer tokens. Retry reconciles the original transaction
instead of signing another one. Acceptance, expiry, deletion cause and unavailable projection
states remain separate; a missing row is never presented as accepted.

The durable browser journal also locks each managed invitation across tabs, even when different
linked recipient wallets are selected. It retains the lock after ledger success while metadata
recording is pending. A new attempt is allowed only after proven transaction expiry or a validated
failure. This lock is scoped to one browser profile: use one device/profile per in-flight invitation.
Different devices can still race before metadata recording; database uniqueness prevents duplicate
metadata, but does not reserve an invitation across devices before on-ledger signing.

## Disable and retain

Disable both issuer flags to hide navigation and reject workspace routes. This also makes managed
payload routes unavailable, so a rollback must retain a compatible authorized reader at existing
on-chain URLs. Keep payloads, application records and migration history; use forward fixes.
Unreferenced drafts and orphaned uploads require administrative retention cleanup, never deletion
of a payload referenced by issued metadata during deployment.
