# Production dependency license review

Reviewed on 2026-09-24 against the installed versions in the independent root, web and indexer
lockfiles. The production gate remains blocked by **three dependencies**. No license allowlist
change or approval of custom terms is included in this work.

| Package                       | Published evidence                                                                                                                                                                                                                                                                           | Result and remaining decision                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gemwallet/api@3.8.0`        | Its bundled `LICENSE` contains a custom dual license; the public/commercial/beta section requires permission from GemWallet. [Source at the npm gitHead](https://raw.githubusercontent.com/GemWallet/gemwallet-extension/73e7a31a4ddcd2afcce4228e17e45380e2178e07/LICENSE).                  | Blocked. Maintainers need to establish applicable permission and its policy treatment, or replace/remove this dependency. The personal-use section does not justify classifying the package as MIT.        |
| `@walletconnect/types@2.25.0` | The manifest refers to its bundled `LICENSE.md`, the WalletConnect Community License Agreement dated 20 August 2025. [Source at the npm gitHead](https://raw.githubusercontent.com/WalletConnect/walletconnect-monorepo/e4310ceae6c1408fa42caeeb2f350ee88813f5f9/packages/types/LICENSE.md). | Blocked. Maintainers must review the applicable custom terms and policy treatment, or replace/remove this dependency. The MIT declaration of the SDK importing it does not resolve this package's license. |
| `nodemailer@10.0.10`          | Its manifest and bundled `LICENSE` identify MIT-0. [Versioned source](https://github.com/nodemailer/nodemailer/blob/v10.0.10/LICENSE).                                                                                                                                                       | Blocked. MIT-0 is absent from the current approved list. A maintainer policy decision is required; it is not relabelled as MIT.                                                                            |
| `vaul-vue@0.4.1`              | The npm publication omits both an SPDX field and the license file. Its exact npm gitHead includes an MIT license. [Source](https://raw.githubusercontent.com/Elliot-Alexander/vaul-vue/1b1f6dfdba6a775410508884097443d35c9a8690/LICENSE).                                                    | Resolved for this version: the pnpm patch restores that file byte-for-byte, and the existing override mechanism verifies its installed SHA-256 before accepting MIT.                                       |

GemWallet and WalletConnect types enter through `xrpl-connect@1.0.0-rc.2`; Vaul enters through
`@nuxt/ui@4.11.2`; Nodemailer is a direct web dependency. Package version metadata and gitHead
were read from the npm registry, and license contents were checked against the installed package.

The Vaul fix changes no runtime code or manifest license claim. Its patch is
[`apps/web/patches/vaul-vue@0.4.1.patch`](../../apps/web/patches/vaul-vue@0.4.1.patch), applied by
the standalone web lockfile. The reviewed version, filename, digest and rationale are recorded in
[`ops/security/license-overrides.json`](../../ops/security/license-overrides.json). An upgrade
requires a fresh review: the gate rejects unused overrides and altered license digests.

| Exact file                       | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| GemWallet `LICENSE`              | `b29ff1e504a23d72e812dcce568f27a0ec7d470e4f1768088ee8ed1c0fe745ed` |
| WalletConnect types `LICENSE.md` | `1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc` |
| Nodemailer `LICENSE`             | `4f814dcacd2da618d62829ea1f6238701cf421f18a6b36c91c5d8212245e2c78` |
| Restored Vaul `LICENSE`          | `ba02930e278b4ed6b564150a261b50319b5cef2a965b7470ae13498ece835944` |

`uqr@0.1.3` is now a direct dependency for local QR rendering. It was already present in the web
lockfile through Nuxt; no package version changed. Its installed manifest and bundled `LICENSE`
declare MIT, and its distributed README documents `renderSVG(text, options)` and
`encode(text, options)`. Both APIs were smoke-tested after installation.

## Verification and reproduction

Run the same three reports and aggregate gate as
[`security.yml`](../../.github/workflows/security.yml). Every per-app license command must carry
`--ignore-workspace`; overrides are evaluated once over the union so version-specific overrides
are not incorrectly reported stale in another scope.

Observed results after `pnpm --dir apps/web install --ignore-workspace --offline`:

- The installed Vaul license matches the reviewed digest, and Vaul no longer appears in gate
  failures. The metadata still reports `Unknown`, so the version-specific override is exercised.
- The aggregate license gate exits 1 for exactly GemWallet, WalletConnect types and Nodemailer.
- The lockfile diff contains only the Vaul patch references and direct `uqr@0.1.3` importer entry.

To roll back the Vaul fix, remove its patch configuration and corresponding override together,
then regenerate the standalone web lockfile. The gate will again reject Vaul as unknown; no
database or runtime migration is involved.
