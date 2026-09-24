> Deployment update: applications install independently (`pnpm --dir apps/web install --ignore-workspace --frozen-lockfile`).
> Use the [standalone deployment runbook](deployment.md) and per-app environment contracts.
> Previous production secret-file Compose overlays are retired; the local application overlay is `docker-compose.application.yml`.

# XRP Identity authentication

Issue #27 adds optional sign-in, PostgreSQL sessions, current role guards and wallet linking to the
Nuxt application. Authentication is disabled by default. Public discovery, verification, Studio and
existing wallet transaction flows remain available without an account. Role-specific issuance,
invitation, approval and private-delivery workflows are available through the optional role
workspaces; see the [recipient/verifier journey](recipient-verifier.md).

## Register the client

The canonical issuer is `https://account.xrpl.in`, confirmed by its
[discovery document](https://account.xrpl.in/.well-known/openid-configuration) and the
[XRP Identity repository](https://github.com/XRPL-Commons/xrp-identity). The older
`identity.xrpl.in` host in #27 did not resolve during implementation.

An Identity administrator must register the XCS development and production clients. Registration
has **not** been performed by this change. Configure each environment with:

- Confidential web client; `client_secret_basic` at the token endpoint.
- Grant `authorization_code`, response `code`, PKCE S256 required.
- Scopes `openid profile email`. No provider admin scopes or offline access are needed.
- Exact callback: `https://YOUR-XCS-ORIGIN/api/auth/callback` (no locale prefix).
- Separate development and production secrets. Use local HTTPS for manual development; do not
  disable cookie security or TLS verification. The automated loopback provider is test-only.

The provider integration follows Commons' `starter.2026.04/modules/1.auth` and its `openid-client`
pattern, adapted to issuer/subject account identity and PostgreSQL opaque sessions. Its ID-token
signature, issuer, audience, nonce and time bounds are validated. Provider roles are never imported.
Provider access/refresh/ID tokens are not persisted or returned to the browser.

## Provision and enable

Back up and follow [Migrate](deployment.md#migrate). Apply the new `0004_auth_sessions` migration,
then rerun bootstrap with the existing four runtime passwords plus a fifth, distinct
`XCS_APP_DATABASE_PASSWORD` (32–256 URL-safe characters), or its `_FILE` counterpart.
The optional `xcs_app` role has only the table/column access needed for authentication. It cannot
write approvals, insert an admin role, move wallet ownership, read private payloads or modify the
projection. Its connection must never replace `xcs_api` or `xcs_payload_writer`.

Omitting the application password from a subsequent bootstrap **disables** `xcs_app`, clears its
password and revokes its privileges. Preserve the configured application password for routine
bootstrap operations while auth remains enabled. Schema-only `db:migrate` does not rotate passwords.

Nuxt private runtime configuration:

| Variable                     | Meaning                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `XCS_AUTH_ENABLED=1`         | Enable auth only once client and database provisioning are ready          |
| `XCS_AUTH_ORIGIN`            | Exact HTTPS site origin, without a path; defines callback and CSRF origin |
| `XCS_IDENTITY_ISSUER`        | Defaults to `https://account.xrpl.in`                                     |
| `XCS_IDENTITY_CLIENT_ID`     | Private client identifier; `_FILE` supported                              |
| `XCS_IDENTITY_CLIENT_SECRET` | Private client secret; `_FILE` supported                                  |
| `NUXT_APP_DATABASE_URL`      | Private `xcs_app` PostgreSQL URL; `_FILE` supported                       |
| `XCS_AUTH_IDLE_SECONDS`      | Default 1800, bounded to 60–86400 seconds                                 |
| `XCS_AUTH_MAX_SECONDS`       | Default 28800, bounded to 60–604800 seconds; at least idle duration       |

Use the provider's verified database TLS connection configuration. Never put these values in
`NUXT_PUBLIC_*`, source files or logs. Direct values and matching `_FILE` values are mutually
exclusive. Secret files must contain one line, at most 16 KiB.

For local Compose with an HTTPS gateway, use the combined application overlay. Populate its
four additional role passwords, OIDC client configuration and document signing key privately:

```sh
export COMPOSE_FILE=docker-compose.yml:docker-compose.application.yml
docker compose config --quiet
docker compose run --rm db-bootstrap
docker compose up -d web mailpit admin-notifier
```

This overlay enables authentication, administration and the issuer workspace together. It builds
restricted connection URLs from the separate passwords; only web receives the OIDC configuration.
For an auth-only deployment, configure the standalone web image with the variables above and
provision only the application role required by that deployment. Production uses external PostgreSQL
and the hosting platform's private environment configuration; Compose is for local validation.

## Sessions and authorization

The `__Host-xcs-session` cookie is Secure, httpOnly, SameSite=Lax and host-only. PostgreSQL stores
only its SHA-256 hash. Login state also requires an independent httpOnly browser cookie and is
consumed once; the PKCE verifier and nonce exist only in the short-lived server transaction.

A first sign-in creates a user by `(identity_issuer, identity_subject)` and a recipient grant. Email
is neither a unique account key nor a reason to merge users. `email_verified` must be exactly true
before recording verification. Admin is an operator-managed personal grant; issuer/verifier grants
belong to approved, active organizations whose responsible user is the authenticated account.
Current account, personal grants and organization approvals are checked on requests, not copied
into an indefinitely trusted cookie. Admin does not imply private-claim access.

`/account` shows profile, approved organizations, linked wallets and session controls. `/issuer`
provides a guarded organization overview. Middleware `auth` and `role` with `requiredRole` metadata
protect navigation; API handlers enforce their own server authorization. Future organization
mutations must also scope the exact organization ID and recheck authorization in their transaction.
The public Studio has not been retired or made approval-gated by this change.

`POST /api/auth/refresh` rotates the bearer and CSRF value without extending the eight-hour absolute
limit. The account page offers an explicit extension action. `POST /api/auth/logout` revokes the
stable session ID, including a concurrent rotation. It does not log out other XCS sessions or the
Identity provider, and does not disconnect the wallet. Mutations require the exact site Origin and
session-bound `x-xcs-csrf` header. Auth responses and personalized SSR HTML are `private, no-store`.
Request bodies are bounded while streaming. IP and account quotas apply within each Nuxt process;
multi-replica/global abuse control also requires ingress controls.

Expired rows cannot authorize requests. Login cleans expired login transactions and sessions;
logout removes its challenges through the session FK. For deployments without new logins, include
expired `app_auth_transactions`, `app_sessions` and `app_wallet_challenges` in administrative retention
cleanup. Do not log callback query strings, cookies, CSRF values or signature bodies at ingress.

## Wallet proof boundary

Linking uses a server-issued five-minute, single-use message bound to origin, user, session,
Testnet network ID, address and random nonce. The wallet signs a message, never a submittable
transaction. Signature verification precedes atomic challenge consumption. A revoked link can be
renewed by the same account; another account cannot take the address through unlink/relink.
Unlinking revokes this profile association, not an XRPL credential or wallet transaction.

Supported message formats:

- GemWallet: UTF-8 message signed through `ripple-keypairs`.
- MetaMask XRP Snap: the same message encoded as hex for its `signMessage` API.
- Otsu: compact secp256k1 signature over its current double-SHA256 message format (its SHA256
  preprocessing plus noble v2 default prehash), checked with Node crypto.

Only keys that derive the claimed master address are accepted. Regular-key and multisign accounts
are not supported. Linking proves that key's ownership; it is not a fresh ledger authorization or
network-readiness check for issuance. Existing transaction flows still perform their separate
network and signing checks. Crossmark, Xaman, Ledger, WalletConnect and unverified message formats
are explicitly unsupported for linking by this implementation; their existing transaction features
are preserved. A live extension round-trip for each supported format remains a release check.

Source contracts: [GemWallet](https://github.com/GemWallet/gemwallet-extension/blob/master/packages/extension/src/contexts/LedgerContext/LedgerContext.tsx),
[MetaMask XRP Snap](https://github.com/Peersyst/xrpl-snap/blob/main/packages/snap/src/core/Wallet.ts),
and the inspected Otsu `packages/core/src/keyring/keyring.ts` at `ee4d823fa4d3f6e472ab61f15313490e45dfa69c`.

## Test and recover

```sh
pnpm --dir apps/web exec vitest run test/auth-config.test.ts test/auth-oidc.test.ts test/auth-http.test.ts test/walletLinkProof.test.ts
# Set XCS_TEST_DATABASE_URL to a disposable PostgreSQL 18 cluster first.
pnpm test:postgres
pnpm --dir apps/web test:e2e:auth
```

The browser harness requires both `XCS_BROWSER_E2E=1` and `XCS_AUTH_BROWSER_E2E=1` in development.
It uses a real loopback OIDC code/token/JWKS exchange and synthetic in-memory application storage;
separate integration tests exercise PostgreSQL with the restricted role. Production rejects the
harness flag and excludes its runtime branch. Stubs are not evidence of real Identity registration,
real wallet consent or successful production login.

Disable `XCS_AUTH_ENABLED` to remove account navigation and reject auth endpoints while keeping
public routes available. Retain the additive tables and use forward fixes. Do not roll back by
removing populated users, wallet links or the migration journal.

The guided Account wallet picker offers only the three supported message-proof adapters. Its
installation links come from those adapters; setup, backup and private keys stay inside the wallet.
An invitation supplies an allowlisted return to the recipient workspace, exposed after successful
linking. Connected alone, wrong-network, unsupported-message and unlinked states never qualify as
verified ownership. New credential presentations use a distinct, purpose-bound five-minute challenge
and a fresh signature; the wallet-link signature itself cannot create a presentation.
