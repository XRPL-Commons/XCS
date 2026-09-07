# Repository Codex Instructions

- Before pushing Compose changes, render the exact overlays with every referenced profile and, when a Docker engine is available, run the production image build plus secret-file startup under the configured unprivileged users; configuration rendering alone does not validate build context or bind-mounted secret readability.
- When cryptographically checking an XRPL transaction returned by `tx`, request `binary: true` and verify the canonical `tx_blob`; API v2 `tx_json` can rename serialized fields (for example, `Amount` is exposed as `DeliverMax`) and is not the canonical object to re-encode for signature verification.
- For Playwright smoke assertions, inspect the rendered semantics and use a unique role, test ID, or explicitly scoped locator; do not assume localized headings or repeated public identifiers resolve to exactly one element in strict mode.
- When running a second Nuxt dev or Playwright web-server instance from another worktree, set `NUXT_IGNORE_LOCK=1` and use a distinct port; Nuxt's development lock is shared across worktrees.
- After editing Prettier-managed files, format the touched files before running format checks; do not use the check command as the formatter.
- For one-off Node scripts, resolve dependencies from the owning workspace package; running from the monorepo root can silently select an incompatible ancestor `node_modules` package.
- Before validating web changes that depend on `@xcs-protocol/core` or `@xcs-protocol/sdk`, rebuild the changed workspace package and keep Nuxt/Vite's forced fresh pre-bundle enabled so cached code cannot mask the current `dist` output.
- Quote shell paths that contain route brackets or other glob metacharacters before passing them to commands such as `sed` or `rg`.
