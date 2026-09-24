# XCS Protocol

XCS is an open schema and verification layer for native [XRP Ledger Credentials](https://xrpl.org/docs/concepts/decentralized-storage/credentials). It defines how an issuer publishes a schema, binds canonical off-ledger JSON to a Credential, and lets anyone verify the resulting ledger evidence.

This repository is alpha software for XRPL Testnet. Do not use personal data or real funds.

## Layout

Two deployable applications:

- `apps/indexer`: validated-ledger ingestion and rebuildable projections. It owns the database
  tooling (`db:generate`, `db:migrate`, `db:bootstrap`).
- `apps/web`: the Nuxt Testnet explorer and issuer/subject workflows **and** the read/verification
  API it serves from the same origin at `/v1`, with `/health/*`, `/internal/metrics*` and
  `/documentation`.

Each application is standalone: its own `package.json`, `pnpm-lock.yaml`, `.npmrc`, tsconfig,
Prettier config, `Dockerfile` and `.env.example`. Neither imports a workspace package; each carries
hand-maintained copies of the protocol and database code it needs, every copied file headed with the
file it came from. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and
[ADR 0004](./docs/adr/0004-two-standalone-apps.md).

One shared folder:

- `db/`: the Drizzle table definitions (`db/schema/`) and generated SQL migrations
  (`db/migrations/`). It is **not** a package — both applications compile these files as their own
  sources through the `#db/*` path alias.

The library and CLI, which are the root pnpm workspace (`packages/*`):

- `packages/core`: browser-safe schema, payload, URI, UID, lifecycle, and network-profile logic.
- `packages/sdk`: XRPL transaction builders, validation, and submission primitives.
- `packages/cli`: local schema, payload, Credential, verification, and submission commands.

There is one protocol implementation: TypeScript core. Cryptography, canonicalization, address validation, time conversion, CID handling, and JSON tokenization use maintained dependencies instead of local implementations.

## Data flow

1. An issuer publishes a schema in an XRPL Payment memo.
2. The indexer reads validated ledgers and projects schemas and Credential lifecycle events into PostgreSQL.
3. The issuer creates canonical payload bytes and hosts those exact bytes at an HTTPS or IPFS URI bound to their SHA-256 digest.
4. The issuer signs `CredentialCreate` in its wallet. The subject may later sign `CredentialAccept`.
5. A verifier loads ledger evidence from the web app's `/v1` API — served by the same Nitro server
   that renders the site, on the same origin — fetches the payload, checks its digest and schema, and
   reports each verification dimension separately.

XRPL validated ledgers are the source of truth. PostgreSQL is a disposable query projection, not a credential authority or issuer data store. Signing keys stay in wallets.

## Development

Requirements: Node.js 24 or 26, pnpm 10, and PostgreSQL 18 for database integration tests.

The root workspace contains `packages/*` only, so the applications install from their own lockfiles.
`--ignore-workspace` is mandatory on any per-app command that resolves dependencies — `install`,
`audit`, `licenses list`. Without it pnpm silently operates on the root workspace and still exits 0.

```bash
pnpm install        # packages/core, packages/sdk, packages/cli
pnpm install:apps   # both apps from their own lockfiles, with --ignore-workspace
```

Run one application at a time from its own directory:

```bash
pnpm --dir apps/web dev        # http://localhost:3000 — UI and /v1 on one origin
pnpm --dir apps/indexer dev
```

Verify everything from the root, or one target at a time:

```bash
pnpm verify                    # format, lint, typecheck, test and build across all three units
pnpm --dir apps/web verify
pnpm --dir apps/indexer verify
```

### Pointing the applications at a database

PostgreSQL is provisioned outside this repository. The indexer owns the tooling; run it once against
a fresh database, then give each application its least-privilege connection string:

```bash
XCS_BOOTSTRAP_DATABASE_URL=postgres://xcs_admin:…@host:5432/xcs \
  XCS_DATABASE_CLUSTER_SCOPE=dedicated \
  XCS_INDEXER_DATABASE_PASSWORD=… XCS_API_DATABASE_PASSWORD=… XCS_MONITOR_DATABASE_PASSWORD=… \
  pnpm --dir apps/indexer db:bootstrap
```

The indexer then reads `XCS_INDEXER_DATABASE_URL` (role `xcs_indexer`) and the web app reads
`XCS_DATABASE_URL` (role `xcs_api`). The complete contracts are
[`apps/indexer/.env.example`](./apps/indexer/.env.example) and
[`apps/web/.env.example`](./apps/web/.env.example).

For a disposable local database, `docker-compose.yml` runs PostgreSQL, the one-shot bootstrap and
both applications. It is a **local-development stack only**; it is not a deployment template. Copy
`.env.compose.example` to `.env` first.

Running a real stack additionally requires an audited network profile and two complete-history
`rippled` WebSocket sources. The committed example profile is a placeholder and the indexer refuses
it with `SOURCE_REGISTRY_NOT_BLACKHOLED`. See [deployment](./docs/runbooks/deployment.md) and
[indexer operations](./docs/runbooks/indexer.md).

For a browser-only Testnet demo, `XCS_LOCAL_PAYLOAD_STORE=1` enables a temporary local payload store. It is not public hosting and cannot be used for durable verification.

## Security and privacy

- Never commit seeds, private keys, `.env` files, production secrets, or personal payloads.
- Schemas and native Credentials are public ledger data.
- The reference API supports exact Credential lookup; it does not expose account-wide subject feeds.
- Public schema publication is permissionless and is not Commons endorsement.

See [the specification](./spec/XCS-0001.md), [architecture](./docs/architecture.md), and [testing](./docs/TESTING.md).

## License

MIT
