# Standalone live Testnet qualification — 2026-09-24

The standalone application was exercised through real browser controls, the installed
GemWallet 3.8.2 extension, two newly created and faucet-funded Testnet wallets, live XRPL
transactions, PostgreSQL, local SMTP and the actual XRP Identity application. No browser
provider, HTTP handler, OIDC session, RPC response or ledger projection was mocked or
injected in this manual qualification. Automated suites have their own fixture boundaries.

## Environment and scope

The isolated site runs at `https://localhost:3445`; the previous deployment on port 3443
was preserved. Identity authentication and account applications run on ports 3446 and
3447, using a real confidential client, password login, email verification and OIDC consent.
Identity's development email output supplied actual verification codes; external email
delivery was not qualified. XCS invitations and notifications used actual local Mailpit SMTP.
The first administrator was established using the application's bootstrap procedure after
real login. Other accounts and approvals were created through their respective interfaces.

All identities, application documents, claims and organization names are synthetic.
Approval of **Synthetic Testnet Academy** and **Synthetic Testnet Verifier** is a decision
in this isolated portal, not an endorsement by Commons in production. Wallets, browser
profiles, data volumes and extension files use durable local directories. No wallet seeds,
passwords, client secrets, presentation tokens or invitation tokens belong in this report.
Browser and service TLS checks remained enabled with the existing local CA.

The tested source is `9158eea` plus the binary-ledger and signature-expiry fixes committed
with this report. Immutable image IDs identify the tested binaries:

- Web: `sha256:47300ed5b16d5dd76c5f517e43a98e7e3c41ac78a2ac9c5d02a97e34746fee1c`.
- Indexer: `sha256:9178dd88b95c771d7c2da87e0bf93e5a653c054a3f30d826f983ba4e5a467bf0`.

## Observed journeys

1. The issuer signed its wallet-link challenge, submitted an organization application and
   uploaded a synthetic PDF. Managed schema registration was denied before approval.
   A separate administrator reviewed the document and approved the application through
   the UI; the audit trail and SMTP notification recorded the decision.
2. The issuer registered a schema, sent an invitation and reviewed the actual claimant's
   verified wallet. The recipient signed up, proved wallet control and claimed the invitation
   opened from the actual received email. The issuer then saw that recipient as ready.
3. The issuer reviewed public/private fields and signed a real `CredentialCreate`. The
   recipient saw the issuance notification, explicitly reviewed the private payload and
   signed `CredentialAccept`. Both transactions reached validated `tesSUCCESS` and the
   application's indexed state became active.
4. The recipient signed a separate presentation authorization. An anonymous browser opened
   the resulting public link without entering a URI, address or schema. It displayed the
   issuer's current portal approval, accepted recipient address and verified dated wallet
   signature. `course = Synthetic managed course` was visible; the private `internalNote`
   field and value were absent. The URL fragment was removed. Schema was valid, ledger
   state active, issuer trust unknown and full-payload integrity correctly `not_checked`
   for this public subset.

5. A second, separately signed link targeted the approved verifier organization. Its
   authenticated responsible user saw both fields and valid complete-payload integrity.
   An anonymous browser and an authenticated administrator opening the same link received
   only the public field and an explanation that full access requires the designated approved
   organization. Their actual HTTP responses also contained no private field or value.
   The verifier history recorded the check and successfully reopened the authorized content.

The separate protocol-only journey also completed schema registration, issuance,
acceptance and anonymous public-payload verification. Its full hosted payload passed
digest/schema checks, while issuer trust correctly remained unknown. Portal admission,
configured issuer trust and truth of claims remain separate concepts.

## Public ledger evidence

Issuer: `rwf6aeT1Lg7uBsToqged1HzGTP39j7esmc`.
Recipient: `raWE6BHACp52NevUpFCErkQ2rj1D9xqHUV`.
Both wallets received Testnet faucet funds through GemWallet; validated `account_info`
confirmed their balances before the journey.

| Journey         | Transaction      | Validated ledger | Hash                                                               |
| --------------- | ---------------- | ---------------- | ------------------------------------------------------------------ |
| Public protocol | Schema Payment   | 21021272         | `C0E43270C3DF9FD18B55AD455A05F3E7836094B4E3F6B46DD1531E90709E8B33` |
| Public protocol | CredentialCreate | 21021295         | `1ADF50A886B9100DCCA3BABA1FF306018C4550FCA08889A43847CF5E963BD5DD` |
| Public protocol | CredentialAccept | 21021498         | `DA1749FD86B2E5F1227B623E046E2722888195D934E6550DA5540C9D87309347` |
| Managed issuer  | Schema Payment   | 21021715         | `49C61726499099D1C5ECCF3576B883B415506092D4B08DD9CA2987907E2C2D7B` |
| Managed issuer  | CredentialCreate | 21021840         | `114A0A4E538D97161459701543B99215DA3952C5E61BBD5D4D0E9FC58E5A171A` |
| Managed issuer  | CredentialAccept | 21022025         | `6E32B8BB65320A31EEC41A2E0EEFDE0F535ED9743830D1E838948E0B16BB2D6A` |

Public protocol schema: `aa44ac6900b47a2187a68ab1a2b99aef1309a54a644d8850fb31b7f73d59bf41`.
Managed schema: `d565a37adb1c511b7f7140dfbfd6da7c9ed3df8a871ce57e2e32bc57f7e92779`.

The six transactions were independently fetched from live RPC with `tx` and `binary: true`.
Each canonical blob passed signature verification and hash recomputation; each response was
validated with decoded metadata `tesSUCCESS`. The managed Create/Accept issuer, subject and
credential type matched.

## Defects and operating lessons

- The old indexer stalled on ledger 20987719: its 7,120 expanded transactions exceeded
  what the secondary server reliably returned. Binary transport reduced the response from
  approximately 10.7 MB to 6.85 MB. Canonical decoding, header/transaction hashes, transaction
  ordering and full two-source quorum remain enforced. Archived live JSON/binary equivalence passed
  for all transactions from the primary source. The initially observed two-source success
  was not retained in an execution log; later archived attempts record disconnections.
  The secondary endpoint can still
  disconnect on repeated large requests; this fix does not guarantee upstream availability.
- A delayed wallet approval exposed submission after `LastLedgerSequence`. The SDK now
  checks expiry after signing, before publishing a newly signed transaction to recovery,
  and again after asynchronous pre-submit guards. An already exposed transaction remains
  conservatively recoverable. The earlier ambiguous journal entry was preserved; the
  application does not infer definitive non-submission from an unvalidated cached response.
- One full-presentation creation returned HTTP 503. Its exact service error was not
  captured. After readiness returned 200, a new challenge and wallet signature succeeded;
  the failed signature was not replayed.
- An off-screen browser caused GemWallet's window creation to fail with a bounds error,
  surfaced by the extension as user rejection. Moving the test window onto the screen
  restored connection. A subsequent refresh timeout was an actual locked extension popup,
  despite an old wallet tab still showing its balance. Unlocking the real popup restored
  signing; no timeout, permission or review guard was weakened.

## Verification boundaries

After the production changes, 855 web unit tests, 300 indexer unit tests and 39 SDK tests
passed. Database-dependent tests were explicitly skipped in those unit invocations;
previous PostgreSQL/browser/runtime qualification remains separately documented. Relevant
types, lint, vendor parity, formatting, builds and both production Docker builds passed.

This qualification covers desktop GemWallet with the two generated Ed25519 wallets.
Other extensions, mobile return paths, production Identity hosting and external email
delivery remain unqualified. A presentation signature proves address control when the
link was authorized, not the current identity or presence of whoever opens it. Copies of
already disclosed claims cannot be recalled. See the [recipient/verifier runbook](recipient-verifier.md)
for authorization and proof limits. The dependency license gate remains unresolved;
the PR stays draft and no production deployment was performed.
