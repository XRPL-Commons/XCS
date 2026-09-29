# Application data model — issue #25

This is the implemented database model and server-side helper boundary.
[ADR 0005](adr/0005-role-based-application.md) records the accepted policy. Optional authentication
is implemented in #27, admin review in #30, issuer mutations/private delivery in #31, and recipient
presentations/verifier history in #32–#33; see the
[issuer runbook](runbooks/issuer.md) for deployment and remaining release checks.

## Ownership and authority

The original ten `app_*` tables are defined under `db/schema/app/` and exported from
the app-local database modules. Migration `0003_application_model.sql` adds them; migrations 0000–0002 and the
projection definitions are unchanged. Drizzle generation includes both the existing projection
entry point and the separate application entry point.

Migrations 0004–0006 extend that model with sessions, review/audit and issuer delivery storage.
`0006_issuer_workspace.sql` adds `app_issuer_payloads` (canonical payloads bounded to 1 MiB,
unique opaque locator, invite/creator/subject, digest, URI and disclosure selectors) and
`app_invite_deliveries` (attempt kind, destination, status and sanitized error code). Only token
hashes persist in invitations; delivery rows contain no raw invitation bearer. Issuance and
revocation delivery records are unique per invitation and event kind to prevent automatic resend.
The dedicated `xcs_issuer` role cannot approve organizations, grant admins or write projection rows.

`0007_recipient_verifier.sql` adds only `app_verifier_history`. Existing presentation rows retain
their unlimited, revocable authorization; there are no expiry or consumption columns. Migrations
0000–0006 remain unchanged. The recipient and verifier handlers reuse the restricted portal pool:
`xcs_issuer` additionally reads ledger checkpoints/integrity status, creates presentations, updates
only their `revoked_at` column, and reads/appends verifier history. Authentication, public API and
administrator roles receive no new private-payload or verifier-history grants.

`0008_presentation_wallet_proof.sql` adds `app_presentation_challenges` and
`app_presentation_proofs`, preserving deployed migrations 0000–0007 and existing grants. Challenges
are session-bound, single-use and limited to five minutes. This lifetime applies only to signing;
presentation links still have no automatic expiration. The portal role may select/insert both tables
and delete challenges to consume them. It cannot update or delete persisted signature evidence.
No new privileges are granted to authentication, public API or administrator roles.

An organization has one responsible human account, not a shared login. Issuer and verifier
applications are independent. Personal roles are `admin` and `recipient`; organization roles are
`issuer` and `verifier`. Application approval never proves the validity of a ledger transaction or
the truth of a claim.

Ledger references are `(profile_id, schema_uid)` and `(profile_id, generation_id)`. They deliberately
have no foreign key into the disposable ledger projection: rebuilding it must not destroy accounts,
invitations or sharing grants. Issuance handlers validate indexed ledger evidence, schema
publisher ownership and wallet control before recording metadata. Database references and hashes
alone are not cryptographic evidence. No mutable `accepted`/`revoked` lifecycle mirror is stored in
the application model; current state is read from validated ledger evidence. Invitations exist
before a credential generation, in their own table.

```mermaid
erDiagram
    app_users ||--o{ app_user_roles : holds
    app_users ||--o{ app_wallets : proves_control
    app_users ||--o{ app_organizations : responsible_for
    app_organizations ||--o{ app_organization_applications : applies
    app_organization_applications ||--o{ app_documents : documents
    app_organizations ||--o{ app_schema_metadata : owns
    app_schema_metadata ||--o{ app_invites : invites
    app_users o|--o{ app_invites : claims
    app_schema_metadata ||--o{ app_credential_metadata : describes
    app_users ||--o{ app_credential_metadata : recipient
    app_invites o|--o| app_credential_metadata : leads_to
    app_credential_metadata ||--o{ app_presentations : shared_as
    app_organizations o|--o{ app_presentations : designated_verifier
    app_sessions ||--o{ app_presentation_challenges : requests_signature
    app_presentations ||--o| app_presentation_proofs : carries_signature
    app_presentations ||--o{ app_verifier_history : checked_as
    app_users ||--o{ app_verifier_history : consulted
    app_organizations ||--o{ app_verifier_history : verifier
```

The diagram omits reviewer/uploader/creator references for readability. Durable history uses
`ON DELETE RESTRICT`; transient wallet/presentation challenges cascade when their session is deleted.
No account deletion cascades into credential or ledger history.

## Data dictionary

`uuid` primary keys default to PostgreSQL `gen_random_uuid()`. All timestamps are `timestamptz`.
Columns are **not nullable** unless marked `?`. `now` denotes the database time default. Text hashes
are lowercase 64-character hexadecimal strings checked in SQL. Enum-like text columns have SQL
`CHECK` constraints, not just TypeScript annotations. Source and generated SQL contain exact names.

### `app_users`

| Columns                                 | Type / default | Meaning                                               |
| --------------------------------------- | -------------- | ----------------------------------------------------- |
| `id`                                    | uuid PK        | Stable human account identity                         |
| `identity_issuer?`, `identity_subject?` | text           | Identity-provider issuer and subject; unique together |
| `email?`                                | text           | Contact address; not the account identifier           |
| `email_verified_at?`                    | timestamp      | Independent email-verification evidence               |
| `display_name?`                         | text           | Recipient/personal display profile                    |
| `status`                                | text, `active` | `active`, `suspended`, `deleted`                      |
| `created_at`                            | timestamp, now | Account creation                                      |
| `deleted_at?`                           | timestamp      | Anonymized tombstone time                             |

Active/suspended accounts require nonempty issuer and subject, with no deletion timestamp. A deleted
account requires the deletion timestamp and null identity, email, email-verification and name fields.
Email verification requires an email. The unique `(identity_issuer, identity_subject)` index prevents
cross-provider subject collisions without making email a unique or trusted identity key.

### `app_user_roles`

| Columns           | Type / default              | Meaning                                     |
| ----------------- | --------------------------- | ------------------------------------------- |
| `user_id`, `role` | uuid FK, text; composite PK | Personal `admin` or `recipient` role        |
| `granted_by?`     | uuid FK → users             | Reviewer, nullable for initial provisioning |
| `granted_at`      | timestamp, now              | Grant time                                  |
| `revoked_at?`     | timestamp                   | Role withdrawn                              |

No personal admin role grants private-claim access. Role provisioning remains a future authenticated
administrative operation; inserting a row is not itself proof of authorization.

### `app_wallets`

| Columns       | Type / default         | Meaning                                  |
| ------------- | ---------------------- | ---------------------------------------- |
| `id`          | uuid PK                | Link identity                            |
| `user_id`     | uuid FK → users        | Account that proved control              |
| `network_id`  | bigint, safe JS number | XRPL uint32 network identifier           |
| `address`     | text                   | Classic XRPL address                     |
| `verified_at` | timestamp              | Successful signed-challenge verification |
| `revoked_at?` | timestamp              | Link no longer usable                    |

Unique `(network_id, address)` prevents a wallet being linked to multiple accounts on the same
network; `user_id` is indexed. Network range, address shape and timestamp ordering are checked.
The authentication implementation must verify the signature, nonce and network; this table does not
perform signature verification or store a private key, seed or reusable challenge secret. There is
no automatic wallet reassignment or organization wallet-control transfer.

### `app_organizations`

| Columns               | Type / default  | Meaning                                         |
| --------------------- | --------------- | ----------------------------------------------- |
| `id`                  | uuid PK         | Stable issuer/verifier organization identity    |
| `responsible_user_id` | uuid FK → users | Single responsible account; indexed             |
| `name`                | nonblank text   | Display name, never an authorization identifier |
| `status`              | text, `active`  | `active`, `suspended`, `closed`                 |
| `created_at`          | timestamp, now  | Creation                                        |

One account may be referenced by several organizations; each organization has exactly one responsible
account. Team membership and responsibility-transfer workflows are not implemented.

### `app_organization_applications`

| Columns                                                             | Type / default              | Meaning                                        |
| ------------------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| `organization_id`, `role`                                           | uuid FK, text; composite PK | `issuer` or `verifier` application             |
| `status`                                                            | text, `pending`             | `pending`, `approved`, `rejected`, `suspended` |
| `website?`, `contact?`, `jurisdiction?`, `description?`, `purpose?` | text                        | Deletable application profile details          |
| `submitted_at`                                                      | timestamp, now              | Submission time                                |
| `reviewed_by?`                                                      | uuid FK → users             | Reviewing administrator                        |
| `reviewed_at?`                                                      | timestamp                   | Decision time                                  |
| `review_reason?`                                                    | text                        | Required and nonblank for rejection/suspension |

Pending applications have no decision fields. Other statuses require reviewer/time, not preceding
submission. Queue index: `(status, submitted_at)`. The admin API must check reviewer authority and
provide audit history when implemented; the row stores the current decision, not a full audit log.
Profile fields can be cleared without inventing a new identity or discarding approval references.

### `app_documents`

| Columns                               | Type / default                          | Meaning                                                     |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `id`                                  | uuid PK                                 | Review document identity                                    |
| `organization_id`, `application_role` | uuid, text; composite FK → applications | Owning application; indexed together                        |
| `storage_key`                         | nonblank text, unique                   | Private object-storage reference, not a public download URL |
| `mime_type`                           | text                                    | Declared media type; upload handler must validate content   |
| `byte_length`                         | positive integer                        | Size                                                        |
| `sha256`                              | text hash                               | Content digest                                              |
| `uploaded_by`                         | uuid FK → users                         | Uploader                                                    |
| `review_status`                       | text, `pending`                         | `pending`, `approved`, `rejected`                           |
| `created_at`                          | timestamp, now                          | Upload metadata creation                                    |

Bytes live in private object storage, never in this table. Deleting a row does not remove its object;
the future deletion workflow must coordinate both and handle storage failures.

### `app_schema_metadata`

| Columns                         | Type / default                         | Meaning                            |
| ------------------------------- | -------------------------------------- | ---------------------------------- |
| `profile_id`, `schema_uid`      | nonempty text, text hash; composite PK | Exact ledger schema reference      |
| `organization_id`               | uuid FK → organizations                | Application owner; indexed         |
| `display_name?`, `category?`    | text                                   | Presentation metadata              |
| `registration_transaction_hash` | text hash                              | Reference to registration evidence |
| `created_at`                    | timestamp, now                         | Metadata creation                  |

Unique `(profile_id, schema_uid, organization_id)` supports ownership-consistent invitation and
credential foreign keys. Only registered-schema metadata belongs here: no fake UID for drafts and no
separate mutable `published` flag overriding ledger evidence.

### `app_invites`

| Columns                                       | Type / default                                        | Meaning                                                     |
| --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| `id`                                          | uuid PK                                               | Invitation identity                                         |
| `organization_id`, `profile_id`, `schema_uid` | uuid, text, text hash; composite FK → schema metadata | Issuer-owned schema                                         |
| `delivery_email?`                             | text                                                  | Removable delivery contact, not proof of claimant identity  |
| `token_hash?`                                 | text hash, unique                                     | Hash of bearer token; may be cleared after claim/revocation |
| `created_by`                                  | uuid FK → users                                       | Creating account                                            |
| `created_at`                                  | timestamp, now                                        | Creation time                                               |
| `expires_at`                                  | timestamp, **no default**                             | Caller must supply invitation expiry, after creation        |
| `claimed_by?`, `claimed_at?`                  | uuid FK → users, timestamp                            | Both absent or both present; claim must predate expiry      |
| `revoked_at?`                                 | timestamp                                             | Claim disabled                                              |

An unclaimed, unrevoked invitation requires a token hash. Indexes: `(organization_id, created_at)` and
`claimed_by`. Unique `(id, organization_id, profile_id, schema_uid, claimed_by)` allows a credential
to reference only the actual claimant for the exact invitation and schema. A link is claimable once,
with no matching-email requirement. Delivery contact is not disclosed by the claim helper.

`claimInvitation(db, { token, userId })` uses one conditional UPDATE against an active account,
unclaimed/unrevoked token hash and database-clock expiry. Concurrent claimants cannot both win.
Invalid/unavailable claims return null; an authenticated POST handler must provide `userId` from the
session and enforce CSRF/rate limits. Opening a link must never invoke the mutation. The helper does
not link a wallet, verify email, sign, issue or accept a credential.

### `app_credential_metadata`

| Columns                                              | Type / default                | Meaning                                                             |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `profile_id`, `generation_id`                        | text, text hash; composite PK | Exact credential generation                                         |
| `schema_uid`, `issuer_organization_id`               | text hash, uuid               | Composite FK with profile → issuer-owned schema                     |
| `recipient_user_id`                                  | uuid FK → users               | Owning recipient                                                    |
| `invite_id?`                                         | uuid, unique                  | Optional composite FK to matching invitation claimant/schema/issuer |
| `issuer_address`, `subject_address`                  | text                          | Issuance-time XRPL identities                                       |
| `visibility`                                         | text, **no default**          | Explicit `public` or `private`                                      |
| `public_fields`                                      | JSONB string array, `[]`      | Claim-relative JSON pointers allowed publicly                       |
| `payload_storage_key?`                               | nonblank text                 | Object reference; nullable for deletion/unavailability              |
| `payload_digest`                                     | text hash                     | Commitment to canonical payload bytes                               |
| `creation_transaction_hash`, `creation_ledger_index` | text hash, bigint uint32 > 0  | Creation evidence reference                                         |
| `created_at`                                         | timestamp, now                | Metadata creation                                                   |

Unique `(profile_id, generation_id, recipient_user_id)` binds presentations to the actual recipient.
Indexes cover `(recipient_user_id, created_at)` and `(issuer_organization_id, created_at)`. SQL checks
visibility, public-field array/string shape, addresses, hashes and ledger range. No private claim
bytes or authoritative lifecycle state are duplicated here. No visibility default is chosen on
behalf of the parallel UX discussion.

### `app_presentations`

| Columns                                            | Type / default                                            | Meaning                           |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------- |
| `id`                                               | uuid PK                                                   | Sharing authorization             |
| `profile_id`, `generation_id`, `recipient_user_id` | text, text hash, uuid; composite FK → credential metadata | Owner-authorized exact generation |
| `verifier_organization_id?`                        | uuid FK → organizations                                   | Mandatory for `full` scope        |
| `scope`                                            | text                                                      | `public` or `full`                |
| `token_hash`                                       | text hash, unique                                         | Link token hash                   |
| `created_at`                                       | timestamp, now                                            | Creation time                     |
| `revoked_at?`                                      | timestamp                                                 | Revocation, not before creation   |

Indexes: `(recipient_user_id, created_at)`, `verifier_organization_id`. There is deliberately no expiry,
consumption timestamp or per-issuer allowlist. Public-scope presentations do not require a verifier;
full private access always does. Invite expiry, session expiry and credential expiry are independent.

The recipient API permits at most 200 active presentations per credential. Creation takes a
transaction advisory lock for the recipient and exact credential, then rechecks ownership,
current session, ledger state and the quota under `READ COMMITTED` isolation. A full quota returns
`409` with `error: RECIPIENT_PRESENTATION_LIMIT`; revoking an active presentation frees a slot.
Per-credential lists place active grants before revoked history so all active grants remain
reachable for revocation. The unfiltered list is a bounded view of 200 entries, also prioritizing
active grants; use the credential filter for complete active-grant management.

### `app_presentation_challenges` and `app_presentation_proofs`

| Table      | Fields                                                                                                           | Retention and authority                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Challenges | `id`, `session_id`, reserved `presentation_id`, JSON `request`, canonical `message`, `created_at`, `expires_at`  | Session/expiry indexes; expiry at most five minutes; atomic delete on successful creation; expired challenges are removed on the session's next challenge request |
| Proofs     | `presentation_id` PK/FK, JSON `request`, canonical `message`, `signature`, `public_key`, `scheme`, `verified_at` | Immutable to the portal role; no private key, seed, session identifier or raw presentation bearer in the public proof                                             |

The signed message has an explicit presentation-authorization purpose, origin, random nonce,
challenge/presentation identifiers, issue/expiry times, profile/network, exact credential generation,
issuer/subject addresses, schema UID, payload digest, visibility, sorted public-field selectors,
scope and designated verifier organization. It explicitly excludes payments, transactions, wallet
linking and ownership transfer. Challenges use a separate table so a signature cannot be consumed
by the wallet-link endpoint. The public message contains neither user IDs nor session IDs.

`POST /api/recipient/presentation-challenges` accepts the presentation reference/scope/audience and
requires authentication and CSRF. The client signs the returned text with a supported wallet.
`POST /api/recipient/presentations` requires the same input plus
`proof: { challengeId, signature, publicKey, scheme }`. The server rechecks current session,
recipient ownership, linked subject wallet, active credential and audience approval, verifies the
signature over its stored message, then consumes the challenge and inserts the grant/proof in the
same transaction as the serialized quota decision. Failed validation rolls the consumption back.
No payload bytes or private claim values are required to authorize this operation.

Resolution revalidates stored signature and exact disclosure bindings. `holderProof` is `verified`
for intact signed records and `not_provided` for legacy links; corrupt/mismatched evidence produces
a generic unavailable link. Signature evidence proves authorization at creation, not the holder's
presence at consultation. It proves a master-key address only; regular keys, multisign and current
ledger key-authority checks, including disabled master keys, are unsupported. Current Commons
issuer admission is separate from signature evidence, ledger validity and issuer trust.

### `app_verifier_history`

| Columns                       | Type / default          | Meaning                                                        |
| ----------------------------- | ----------------------- | -------------------------------------------------------------- |
| `id`                          | uuid PK                 | One explicit verification consultation                         |
| `verifier_organization_id`    | uuid FK → organizations | Approved organization acting as verifier                       |
| `verifier_user_id`            | uuid FK → users         | Responsible account at consultation time                       |
| `presentation_id`             | uuid FK → presentations | Exact sharing grant consulted                                  |
| `profile_id`, `generation_id` | text, text hash         | Exact credential generation; no projection FK                  |
| `scope`                       | text                    | Actual `public` or `full` disclosure                           |
| `on_chain`                    | text                    | `not_found`, `pending`, `active`, `expired` or `deleted`       |
| `schema_status`               | text                    | `valid` or `unknown`                                           |
| `payload_status`              | text                    | `valid`, `unavailable`, `tampered`, `invalid` or `not_checked` |
| `issuer_trust`                | text                    | `trusted`, `untrusted` or `unknown`                            |
| `checked_at`                  | timestamp, now          | Evidence observation time, not a durable access grant          |

Indexes cover `(verifier_user_id, checked_at, id)` and `(verifier_organization_id, checked_at, id)`.
There are no claim values, raw presentation tokens, email addresses or payload bytes in these rows.
History insertion rechecks the current session, responsible organization, approval and presentation
inside the disclosure transaction. Anonymous visitors and callers lacking the full presentation's
authorization do not create history. Reads and CSV exports require the same responsible account's
current approval; they return at most 500 evidence summaries. Reopening a history entry resolves
the presentation again, including revocation and current approval checks, rather than reading
cached private claims.

## Server-side visibility boundary

`getCredentialAccess(db, { profileId, generationId, viewerUserId, presentationToken? })` reads the
credential, current account/organization state, sharing grant and verifier approval in one SQL
statement. `viewerUserId` must come from verified server authentication, never from a public body.

| Caller                                                                                                                                         | Public credential | Private credential |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------ |
| Anonymous, unrelated account, admin role alone                                                                                                 | All claims        | Public fields only |
| Active recipient                                                                                                                               | All claims        | All claims         |
| Active account responsible for the active issuer organization                                                                                  | All claims        | All claims         |
| Active account responsible for the designated, active and currently approved verifier, with a non-revoked full grant for this exact generation | All claims        | All claims         |
| Approved verifier without its grant, wrong audience, suspended verifier, or revoked/public-scope grant                                         | All claims        | Public fields only |

No credential metadata means null, not access. Approval and grant revocation are rechecked per call;
do not cache this result as a durable permission or evaluate it only at sign-in. A caller may have
several relationships: an owner does not lose their ownership access because an unrelated grant
is invalid. This helper is not a presentation-link resolver: presentation routes separately reject
invalid/revoked links and verify current ledger state. Neither an access result nor stored metadata
means the credential itself is valid or accepted.

`filterCredentialClaims(claims, access)` copies only the allowed claims. Do not spread the original
private payload envelope into a public DTO. Object-field paths use RFC 6901, relative to `claims`:
`/course/title`, with `~0` and `~1` escapes. Missing paths disclose nothing. Arrays are atomic: an
explicit `/modules` shares the whole array; `/modules/0/name` is not supported and discloses nothing.
Selecting an object explicitly shares its subtree; the issuer UI previews that fact. Invalid,
overlong, overly deep or prototype-sensitive selectors fail closed. The empty root pointer cannot
mean “all private claims.” No cryptographic selective-disclosure proof is implied by a filtered view.

`validatePublicFields` must run when saving public selectors. The filter validates them again before
public output; SQL also rejects non-array/non-string shapes. Limits: 256 selectors, 1024 characters
per pointer, 32 path segments. Unknown access scopes throw rather than returning the full payload.

Tokens use Node's standard `randomBytes(32)` and SHA-256, with no custom cryptography. A created
presentation returns its raw token once in `/presentations#TOKEN`; lists contain no token or hash.
The fragment is exchanged only by explicit same-origin JSON `POST /api/presentations/resolve`.
Signed-in consultations additionally require CSRF. An optional login handoff uses a ten-minute
Secure/HttpOnly cookie, consumed through an authenticated CSRF-protected POST. Raw tokens never
enter application database columns, query strings, logs or analytics.

Presentation resolution takes a share lock on the grant to serialize disclosure with revocation.
It revalidates account/organization approval and reads canonical stored bytes, exact-generation
ledger state, schema evidence and the configured ledger freshness/trust policy in one transaction.
It performs no external payload fetch or public `/v1/verify` request. A valid full link opened by an
anonymous or unauthorized caller returns only public claims with `requiresAuthorization: true`.
Recipient/issuer ownership and administrator status do not widen the presentation's scope. For a
private credential, public scope uses `public_fields`; for an already-public credential, all claims
are public. Responses contain claims, not a private payload envelope. A filtered public result
reports payload `not_checked` after internal canonical validation because the projection cannot
prove the full payload digest; tampered/invalid bytes instead produce their actual failure status
and no claims. Approval remains separate from the configured issuer trust decision.

Recipient workspace/detail responses contain metadata and ledger events, never private claims.
Private claims require the separate explicit owner-authorized payload request. Accept, reject and
remove reconciliation validate the exact indexed transaction and a currently linked subject wallet;
rejection/removal never loads payload bytes. In-app issuance/revocation notifications derive from
durable credential events, including issuer revocations outside the portal. Email delivery remains
the issuer workflow's separate delivery record. Lists are bounded to 200 credentials/invitations/
notifications and 100 detail events; unavailable/stale ledger evidence yields an unknown inbox
state and blocks authoritative private disclosure.

## PII, deletion and deployment

Identity subjects, names, email/contact fields, profile details, document references/content, wallet
links and invitation ownership can identify people. Treat them as application PII even if some
wallet addresses are already public. Grant and review history are also sensitive relationship data.
Public ledger records cannot be erased; an internal tombstone is not a promise of anonymizing XRPL.

The model supports clearing account PII into a disabled tombstone, clearing application profile
fields, removing review-document metadata, clearing invitation delivery contacts and removing
payload references without cascading deletion into issuance history. Future deletion processing
must revoke affected grants/wallet links, remove object bytes where permitted, and coordinate
backups. Restrictive FKs require deliberate handling of references; deleting a parent is not a
shortcut. The lifetime of residual identifiers and backups, operational purge schedules and legally
required retention are **not decided or implemented by this issue**. Do not claim complete account
erasure merely because fields can be nulled.

The forward SQL migration itself grants no runtime privileges. Existing projection readers/indexer and
public-payload writers must not be reused as unrestricted application writers. Issue #27 now provisions an optional, restricted `xcs_app` role and server-only connection for authentication;
see the [authentication runbook](runbooks/authentication.md). Nothing here
enables production private hosting or converts a public payload into a private one.

For 0007/0008, apply the additive migrations, reprovision the restricted portal grants, then deploy
the updated application. Older app instances can still create unsigned links until replaced; such
links remain explicitly marked as lacking a presentation proof. There is no data backfill or destructive DDL. An application rollback can
leave the new tables, signature evidence and history intact; do not drop relationship history as a rollback shortcut.
Grant provisioning remains separate from migration application. Existing deployments may continue
using the previous application against the expanded schema during this sequence.

## Verification

Visibility tests: `apps/indexer/test/db/app-visibility.test.ts`. Actual SQL, invitation concurrency,
access decisions and constraints: `apps/indexer/test/db/app-model.integration.test.ts`.
`apps/indexer/test/db/migrations.integration.test.ts` covers fresh creation and the 0006→0007 and 0007→0008 upgrades,
including unchanged accounts, presentation columns and applied migration history.
`apps/web/test/recipient-http.test.ts`, `recipient-postgres.integration.test.ts` and the verifier tests
cover CSRF, ownership, current approval, private/public projection, freshness, trust, quota races,
rejection without payload reads, signed challenge scope/session binding, concurrent replay, expired
challenges, wallet removal, legacy unsigned links, corrupted proofs and restricted SQL grants.

```sh
pnpm --dir apps/indexer typecheck
pnpm --dir apps/indexer test
# Use a disposable PostgreSQL cluster, never the active Testnet database.
XCS_TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/postgres pnpm --dir apps/indexer test:postgres
pnpm --dir apps/indexer build
pnpm --dir apps/indexer db:generate
```

Generation after the checked-in artifacts must produce no new migration. Independent maintainer
review and real identity/wallet flows remain release gates beyond synthetic authorization tests.
