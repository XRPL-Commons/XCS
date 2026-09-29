# Third-party licences

This note records the dependencies whose licences are not plain permissive SPDX identifiers, and
why XCS may ship them. It is a record for maintainers, not an automated check: nothing in CI reads
this file. Re-read it before a release that changes wallet dependencies, and treat every SHA-256
below as the exact licence text that was reviewed. If a digest no longer matches what is installed,
the terms changed and the entry needs reviewing again.

Recompute a digest with:

```bash
shasum -a 256 apps/web/node_modules/<package>/<licence file>
```

## @gemwallet/api

Reaches the web app transitively through `xrpl-connect`, and is registered as a wallet adapter in
`apps/web/app/utils/walletAdapters.ts`.

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Version reviewed | 3.8.0                                                              |
| Licence file     | `LICENSE`                                                          |
| SHA-256          | `b29ff1e504a23d72e812dcce568f27a0ec7d470e4f1768088ee8ed1c0fe745ed` |

The package declares no SPDX licence. Its bundled `LICENSE` is a custom dual licence. One arm is
MIT-like but covers personal, educational and non-commercial research use only, explicitly excluding
public use. The other arm covers public, commercial and beta use and requires permission from
GemWallet.

XCS is a public deployment, so the second arm applies. **Florent Bouron granted XRPL Commons that
permission in January 2026.** The grant has no public URL; it is held in the Commons maintainers'
records. A durable pointer to it, an email archive link or an entry in an internal register, would
be worth adding here.

Do not record this dependency as MIT anywhere. The MIT-like text exists in the file, but not for
the use XCS makes of it.

## @walletconnect/types

Reaches the web app through `xrpl-connect`, alongside the other WalletConnect packages.

|                      |                                                                    |
| -------------------- | ------------------------------------------------------------------ |
| Version reviewed     | 2.25.0                                                             |
| Licence file         | `LICENSE.md`                                                       |
| SHA-256              | `1cb6f8cfe21f54ab1105105717eaa2ba08343037a2a9c41dfd5ab09e3ce270fc` |
| Licence release date | 20 August 2025                                                     |

The package declares `SEE LICENSE IN LICENSE.md`, which is the WalletConnect Community License
Agreement, licensed by Reown, Inc. It is not an SPDX licence and its terms cannot be restated as
one. It permits this use subject to two conditions.

**Attribution** is satisfied upstream. The notices shipped with the Commons `xrpl-connect` package
name the dependency under this agreement, carry the attribution "Portions © 2025 Reown, Inc. All
Rights Reserved" and include a copy of the licence text:
<https://github.com/XRPL-Commons/xrpl-connect/blob/develop/packages/xrpl-connect/THIRD_PARTY_NOTICES.md>

**Usage thresholds** are attested by Luc Bocahut, XCS maintainer, on 28 September 2026: XRPL Commons
is below the thresholds set out in the agreement. This is the condition most likely to stop holding
as the deployment grows, so re-check it before any significant increase in usage.

## vaul-vue

Arrives through Nuxt UI's header and drawer components. Unrelated to wallets.

|                             |                                                                    |
| --------------------------- | ------------------------------------------------------------------ |
| Version reviewed            | 0.4.1                                                              |
| Licence file                | `LICENSE`, added by `apps/web/patches/vaul-vue@0.4.1.patch`        |
| SHA-256 of the patched file | `ba02930e278b4ed6b564150a261b50319b5cef2a965b7470ae13498ece835944` |

The published package omits both its SPDX field and any licence file, which is an upstream packaging
mistake rather than a licensing question. Upstream `Elliot-Alexander/vaul-vue` is MIT, copyright
2025 unovue.

The patch restores that MIT text verbatim into the installed package. **Keep the patch even though
nothing now verifies it**, because distributing the component without its licence text would breach
the MIT notice condition. Drop it only when upstream publishes a version that ships its own licence.

## Nodemailer

Nodemailer is the direct SMTP client used by invitation and lifecycle delivery.

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Version reviewed | 10.0.10                                                            |
| Licence file     | `LICENSE`                                                          |
| Licence          | MIT-0                                                              |
| SHA-256          | `4f814dcacd2da618d62829ea1f6238701cf421f18a6b36c91c5d8212245e2c78` |

MIT-0 is a permissive licence and imposes no attribution condition. Commons accepts it for this
direct production dependency. Re-review the installed licence when the exact version changes.

## tosource

Declares no SPDX field. Its bundled `LICENSE` is the permissive zlib licence, SHA-256
`22cfaab2256435450e4375ef5593354cc3d53501f0ead3564336415b3909bae4`. No further action.

## History

An automated licence policy gate used to enforce all of the above, as `ops/ci/check-licenses.mjs`
with two JSON policy files under `ops/security/`. It was self-imposed rather than required by
anything outside the repository, and was removed once the questions it existed to surface had been
answered. The answers are this document.
