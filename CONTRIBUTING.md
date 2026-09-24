# Contributing

Keep changes small, testable, and owned by one layer.

1. Put deterministic protocol behavior in `packages/core`.
2. Use `xrpl.js` for XRPL primitives and vetted libraries for cryptography, encoding, canonicalization, and parsing. Do not implement those primitives locally.
3. Keep signing outside XCS; builders return unsigned transactions and wallets own keys.
4. Add tests for observable behavior and important rejection paths.
5. Run the affected package checks, then `pnpm verify` when the whole workspace is stable.
6. Include rollout and recovery notes for persistent-data changes.

Changes to schema validity, UID derivation, canonical payload bytes, URI integrity, or lifecycle projection are protocol changes. Document them in an ADR and update the specification before shipping them.

## The mirroring rule

`apps/web` and `apps/indexer` are standalone deployables. Neither imports `@xcs-protocol/core`,
`@xcs-protocol/sdk` or any other workspace package: each carries hand-maintained copies of exactly
the protocol and database code it needs. See
[ADR 0004](./docs/adr/0004-two-standalone-apps.md).

The rule is therefore:

1. **Protocol behaviour changes land in `packages/core` (or `packages/sdk`) first.** That package,
   with its tests, remains the reference implementation and the source of truth for the change.
2. **The same pull request mirrors the change by hand into every app copy that contains the affected
   file.** A pull request that changes `packages/core` without updating the corresponding copies is
   incomplete, even when CI is green — the apps do not compile against the package, so nothing fails.
3. **Every copied file keeps its header comment**, which names the file it was copied from and the
   commit it was copied at:

   ```ts
   // Copied from packages/core/src/schema-uid.ts at <short sha>; keep in sync by hand (see CONTRIBUTING.md).
   ```

   Update the short sha when you re-copy the file, so the next mirroring pass can diff against a
   known point.

The copy locations are:

| Copy                         | Source                                            |
| ---------------------------- | ------------------------------------------------- |
| `apps/web/app/lib/xcs/core/` | `packages/core/src/**`                            |
| `apps/web/app/lib/xcs/sdk/`  | `packages/sdk/src/**`                             |
| `apps/web/server/lib/db/`    | the former `packages/db` client and transactions  |
| `apps/indexer/src/lib/xcs/`  | the `packages/core` modules the indexer reaches   |
| `apps/indexer/src/lib/db/`   | client, fencing, transactions, provision, migrate |

The one exception is the database **schema**: `db/schema/` and `db/migrations/` are shared source,
compiled by both apps through the `#db/*` path alias. They are edited once, never mirrored. After
editing `db/schema/`, regenerate the migration with the indexer's tooling and commit the result:

```sh
pnpm --dir apps/indexer db:generate
```

CI regenerates it too and fails on any diff.

## Running the checks

The root workspace holds `packages/*` only. Each app installs and verifies from its own lockfile,
and `--ignore-workspace` is mandatory on any per-app command that resolves dependencies (`install`,
`audit`, `licenses list`) — without it pnpm silently operates on the root workspace and still
exits 0.

```sh
pnpm install                                                   # packages/*
pnpm install:apps                                              # both apps, --ignore-workspace
pnpm --dir apps/web verify
pnpm --dir apps/indexer verify
pnpm verify                                                    # everything, from the root
```
