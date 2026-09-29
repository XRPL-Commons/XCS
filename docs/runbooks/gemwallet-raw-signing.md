# GemWallet raw-signing qualification — 2026-09-21

GemWallet 3.8.2's native `signTransaction` rejects Credential transaction types. Its official
`signMessage(hex, true)` API signs XRPL signing bytes without that legacy transaction validator.
XCS uses this API only for `CredentialCreate`, `CredentialAccept` and `CredentialDelete` after
explicit consent. Schema registration still uses native Payment signing.

## Boundaries

- XRPL Connect rc.2 still owns connection, discovery and account/network refresh. Its exported
  `GemWalletAPI` supplies hex signing; the generic adapter message method loses the hex flag.
- The complete transaction is displayed before approval. GemWallet displays hexadecimal data and
  calls it a message, so XCS explicitly explains that approval authorizes a transaction and its fee.
- Consent binds the exact encoded preview and is consumed on each attempt. No silent fallback,
  automatic re-signing or extension/provider replacement is used.
- `xrpl.js` validates and serializes fields, derives the master address and assembles the signed
  blob. The existing SDK verifies its signature and exact reviewed fields before publication,
  journaling and submission. No application signing keys or custom cryptography were introduced.
- Testnet master-key accounts only. Regular-key and multisigned accounts are not supported by this
  raw path. The extension wait is bounded to 90 seconds; a late response is not submitted.

## Real extension evidence

The production Docker site at `https://localhost:3443` was exercised in isolated durable Brave
profiles with the actual installed GemWallet 3.8.2 extension and two newly created disposable
Testnet accounts. Browser TLS verification remained enabled. There were no simulated wallet,
ledger or API responses in this qualification.

Issuer: `r9ztbJ9n3XpNF4gja5pAnmy4Uxihsc5JGi`

Subject: `rpzdE7FHnr3DjkLKRxdDsDkJJShPLhiusE`
Schema: `06ad39d9a5ec1e55e9e3a15a95e1c2c3ffdd4337de63f8e213edabe6e6671459`

| Action                             | Transaction hash                                                   | Validated ledger |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------- |
| Schema Payment                     | `5A4AE1116EEF92AE94B06621385D6166417A211B5883A3E846844B830E65E5CE` | 20937631         |
| CredentialCreate                   | `4D6AC2B8BE67987990F5ABBA7BB815A3FE4B05033421C9BACB78B45EB092DD11` | 20937727         |
| CredentialAccept                   | `14D92F360E88C5B7FFCBE0F80F6D83A18B3EB2480911847F754DAA96C6C0D239` | 20937825         |
| CredentialDelete (subject removal) | `33835AF0EDC48C8E98BED9529AB56E9229258DD6F0CEB06261918A01281B6266` | 20937872         |

All four returned `validated: true` and `tesSUCCESS`, with matching indexed business evidence.
Their canonical blobs were fetched independently using `tx` with `binary: true`, and checked with
`xrpl.verifySignature`. Both live wallets used Ed25519; secp256k1 was exercised by unit tests only.

The 248-byte synthetic payload was published, fetched over HTTPS and verified. The recipient's
inbox discovered the pending credential; acceptance changed it to ACTIVE with VALID schema and
payload. Subject removal changed it to DELETED with `subject_removed`. A fresh page with no wallet
connection still verified the schema, payload and complete lifecycle. No existing credential was
removed. The disposable generation cannot be restored; issuing again creates another generation.

One acceptance attempt timed out with its browser window in the background. A late prompt was
rejected, and a fresh review succeeded after reconnecting with that test browser focused and the
other test browser closed. The precise extension scheduling cause was not established: do not
claim every popup attempt is reliable. Close a stale wallet request, reconnect if needed, and
prepare a fresh preview before retrying; do not approve an old hexadecimal prompt.

## Checks and local deployment

- `pnpm --filter @xcs-protocol/web test`: 249 tests passed. Unit wallet boundaries are simulated;
  the signatures themselves use XRPL libraries, including wrong-key/changed-field rejection.
- `pnpm --filter @xcs-protocol/web typecheck`: passed.
- `XCS_E2E_PORT=3198 pnpm --filter @xcs-protocol/web exec playwright test e2e/pilot.spec.ts --grep 'requires explicit GemWallet'`:
  passed; this isolated deterministic browser check proves consent gating, not extension support.
- Production Docker build from source with the frozen lockfile passed. The local web image is
  `xcs-web:gemwallet-raw-signing`; database, API, indexer and checkpoints were left unchanged.

Rollback: select `xcs-web:publication-recovery` in `.data/local-https/compose.yml` and recreate only
the web service. That image restores the old GemWallet credential restriction, not the live ledger
state. The prior image remains available; no database rollback is needed.
