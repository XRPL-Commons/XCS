# Real Otsu Testnet flow — 2026-09-20

## Scope

Tested the production XCS website at `https://localhost:3443` in Brave, using an
isolated persistent profile and the actual unpacked Otsu extension. Otsu source:
`ee4d823fa4d3f6e472ab61f15313490e45dfa69c`, manifest version `1.0.0`.
XRPL Connect Vue and XRPL Connect: `1.0.0-rc.2`, official `OtsuAdapter`.

Playwright operated the real extension's creation, approval and signing screens.
No provider injection, wallet-response substitution, fixture ledger, disabled TLS
validation or external signing key was used for this live run. Otsu generated
the disposable accounts; both received 100 Testnet XRP through its faucet UI.
Recovery material and passwords are not part of this report.

The web image was rebuilt from this worktree as `xcs-web:live-flow-review`.
The previous deployed web image was older. A new disposable projection started
at validated ledger `20910186`; older databases were preserved. The existing API
image was retained because its recovered source is incomplete.

## Public accounts and ledger evidence

- Account A: `rsRW5YzPHe4DRoxh96dHsQ938RZbRwTtsp`
- Account B: `rLyYcvM1fKFDQERzUUZzuiZiNqQJ9CEa2r`

Every transaction below was independently queried using `xrpl.Client` against
`wss://testnet.xrpl-labs.com`: `validated: true`, `tesSUCCESS`. XCS also confirmed
its indexed evidence.

| Run                         | Action              | Ledger   | Transaction hash                                                   |
| --------------------------- | ------------------- | -------- | ------------------------------------------------------------------ |
| A issues to B               | Schema registration | 20910418 | `11B6C799401148B79A4A276F1BC8A6AB6F4ADEA71FCABE015957949AFA33D513` |
| A issues to B               | CredentialCreate    | 20910485 | `45290EFB2A2E3D65C72B31D202D06D92F88E29D705674D0CAD059619F60B5617` |
| A issues to B               | CredentialAccept    | 20910519 | `BB3C7F0F5BEA3C9C30D0AC5E66ECCA56D44C4F74C53C7B9DC4B78AD9A819B6DC` |
| B issues to A, after UI fix | Schema registration | 20910624 | `62FF415D6016046107335CE4177EE155349CD729A2CD8A99DB3BCF051147738B` |
| B issues to A, after UI fix | CredentialCreate    | 20910639 | `08605AADCCD7C8AC6D0AB8BB586FDAAB587DBF93DEE10CA1E8FB1B3FE9B69144` |
| B issues to A, after UI fix | CredentialAccept    | 20910649 | `A8BFF1AD9F05F4857790D9FCF841E945EC2249304153246B670B4D9F1C015271` |

Both generation pages returned `ACTIVE / VALID / VALID / UNKNOWN` for on-ledger
state, schema, payload and issuer trust. Unknown trust is intentional: these are
not authenticated organizational identities. The first credential's accepted
flag was additionally read directly through `account_objects` (`Flags: 65536`).

## Repeat the UI checks

1. Use a Testnet-only Otsu profile, with normal trusted HTTPS. Create/fund two
   accounts through Otsu. Do not export their keys into XCS or a test script.
2. Connect A through XCS; approve in Otsu. Check the displayed address and Testnet.
3. Create a course-completion schema with synthetic fields. Prepare, sign in
   Otsu, and wait for both ledger validation and XCS indexing.
4. Open the confirmed schema and issue to B. Enter synthetic claims, prepare,
   approve the exact hosted payload, sign and wait for publication verification.
5. Disconnect XCS, select B in Otsu, wait for its account switch to finish, then
   reconnect and approve. Check B's full address before proceeding.
6. Open **My credentials**. The pending item must appear without entering its
   identifier. Review it, allow payload loading, recognize the test issuer,
   then accept in Otsu.
7. Once validated, the pre-signing review and acceptance controls must disappear;
   the transaction result and exact-generation evidence link remain. The old
   `PENDING` snapshot must not appear to describe the post-acceptance state.
8. Follow the evidence link and fetch the payload. Check `ACTIVE / VALID / VALID`.
   The accepted credential must no longer appear in the pending inbox.
9. Disconnect the wallet. Use **Verify** with the issuance transaction hash to
   open and verify the same generation without authentication.
10. Separately reject a schema signing request in Otsu. XCS must show the
    rejection, show no ledger-success result, and release the form for retry.

Steps 1–8 were completed twice, with account roles reversed. Step 9 and the
rejection/retry path were also exercised against the real site and extension.
Opening the first generation's acceptance link while connected as A (its issuer,
not its subject) returned `CREDENTIAL_LINK_SUBJECT_WALLET_MISMATCH` and exposed no
accept-signing control.

## Fix and validation

`accept.vue` kept displaying the pre-signing review after successful acceptance.
It now hides that snapshot when ledger validation supplies a result; finality
and the exact-generation page remain the authoritative post-submission UI.
Post-validation errors remain visible outside the hidden review card.

Additional automated checks (separate from live-wallet evidence):

```sh
pnpm --filter @xcs-protocol/web test
pnpm --filter @xcs-protocol/web typecheck
XCS_E2E_PORT=3114 pnpm --filter @xcs-protocol/web exec playwright test e2e/pilot.spec.ts --grep 'issues, reconfirms, then accepts a credential with exact indexed evidence'
```

The existing deterministic browser fixture guards the stale-review regression;
it does not establish wallet compatibility. The second live acceptance above
also verified the corrected production UI.

Results: 223 web unit tests passed, web typecheck passed, the focused regression
above passed, and the existing `issues, accepts and reviews a public HTTPS payload
without browser storage` scenario passed. The production Docker web build and
`git diff --check` passed. The initial fixture launch found port 3100 occupied;
it was rerun on 3114 without stopping that existing service. The first added
assertion incorrectly expected uppercase text instead of CSS-transformed
`pending`; the case-independent status assertion passed on rerun.

## Limits

- This validates Otsu in an isolated profile, not Crossmark, Xaman, mobile wallets
  or multiple simultaneously installed providers.
- Select the intended Otsu account before reconnecting XCS. Do not treat an
  account switch inside the extension as proof the dApp permission changed.
- Payloads are served over trusted local HTTPS and stored by the running API,
  not in browser storage. `localhost` is not public hosting and is inaccessible
  to a recipient on another machine. Use a stable public HTTPS origin before
  issuing credentials intended for remote verification.
- The fresh projection is for disposable testing, not a complete historical
  production index. No mainnet or real funds were used.
- This run does not prove every external-service failure, expiration or
  revocation path. Keep the API image until its missing source is recovered.
