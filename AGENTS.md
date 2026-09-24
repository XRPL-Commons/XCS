# Repository Codex Instructions

- The Compose stack is local development only. Before pushing changes to it, render the exact overlays with every referenced profile and, when a Docker engine is available, build `apps/web/Dockerfile` and `apps/indexer/Dockerfile` with the repository root as build context and start the stack under the `node` runtime user; configuration rendering alone does not validate the build context or the shared `db/` and `config/` copies the images depend on.
- Every per-app pnpm command that resolves dependencies — `install`, `audit`, `licenses list` — must carry `--ignore-workspace`. Without it, `pnpm --dir apps/web install` silently operates on the root workspace and still exits 0.
- When cryptographically checking an XRPL transaction returned by `tx`, request `binary: true` and verify the canonical `tx_blob`; API v2 `tx_json` can rename serialized fields (for example, `Amount` is exposed as `DeliverMax`) and is not the canonical object to re-encode for signature verification.
- For Playwright smoke assertions, inspect the rendered semantics and use a unique role, test ID, or explicitly scoped locator; do not assume localized headings or repeated public identifiers resolve to exactly one element in strict mode.
- When running a second Nuxt dev or Playwright web-server instance from another worktree, set `NUXT_IGNORE_LOCK=1` and use a distinct port; Nuxt's development lock is shared across worktrees.
- After editing Prettier-managed files, format the touched files before running format checks; do not use the check command as the formatter.
- For one-off Node scripts, resolve dependencies from the owning workspace package; running from the monorepo root can silently select an incompatible ancestor `node_modules` package.
- The two apps do not import `@xcs-protocol/*`. Protocol behaviour changes land in `packages/core` first and are mirrored by hand into `apps/web/app/lib/xcs/` and `apps/indexer/src/lib/xcs/` in the same pull request; rebuild the owning app, not the package, to validate an app change.
- Quote shell paths that contain route brackets or other glob metacharacters before passing them to commands such as `sed` or `rg`.
