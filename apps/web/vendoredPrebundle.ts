/**
 * Third-party specifiers imported by the vendored protocol code under
 * `app/lib/xcs`, listed for `vite.optimizeDeps.include` in `nuxt.config.ts`.
 *
 * That code is application source, not a dependency, so Vite does not discover
 * its bare imports until a page pulls them in. Left out of the pre-bundle, Vite
 * re-optimizes mid-run and answers the in-flight module requests with
 * `504 Outdated Optimize Dep` — a dev-server-only failure that reads like a
 * flaky browser test. The entries are the exact specifiers those modules
 * import, because that is the granularity Vite optimizes.
 *
 * `test/vendoredPrebundle.test.ts` re-derives this list from `app/lib/xcs/**`
 * and fails if the two disagree, so mirroring the vendored code from
 * `packages/` can no longer silently break the dev server.
 */
export const vendoredPrebundleDependencies = [
  '@noble/hashes/sha2.js',
  '@noble/hashes/utils.js',
  '@scure/base',
  'canonicalize',
  'jsonc-parser',
  'multiformats/bases/base32',
  'multiformats/cid',
  'multiformats/codecs/raw',
  'multiformats/hashes/digest',
  'tr46',
  'xrpl',
]
