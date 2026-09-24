# ADR 0002: Public Testnet product and discovery boundaries

Status: Accepted for the public discovery and accountless Studio boundary. Optional application
accounts and managed payloads extend the original baseline under [ADR 0005](0005-role-based-application.md).

Date: 2026-08-25

## Context

XCS v0.1 is a frozen protocol profile for native XRPL Credentials. Product work may improve how
people discover schemas, prepare transactions and inspect ledger evidence, but it must not change
v0.1 schema validity, UID derivation, payload interpretation or lifecycle projection. Any such
normative change requires a later protocol version and a separately activated network profile.

The public product should be as approachable as EAS and EASScan without copying their protocol or
turning XRPL Commons into a credential authority. XRPL Credential metadata is public, but indexing
it into account-wide feeds would amplify subject activity beyond the exact lookup needed to verify a
shared credential. Public payload claims create an additional privacy boundary because they live
outside the ledger.

## Decision

The first public product is an XRPL Testnet beta with one web application organized into three
surfaces:

- **Explorer** discovers permissionless public schemas, aggregate network statistics and exact
  credential evidence;
- **Studio** registers schemas and performs low-volume, one-at-a-time issuance and lifecycle actions
  through an external wallet;
- **Developers** explains the protocol and exposes REST, SDK and CLI integration material.

EAS and EASScan are UX references only. XCS continues to use native XRPL Credentials and its frozen
v0.1 schema, payload and verification rules.

Discovery is deliberately hybrid:

- every valid schema registration is public and discoverable, regardless of publisher;
- aggregate statistics may count public ledger-derived records;
- a Credential is resolved exactly by a shared generation ID, transaction hash or complete
  issuer/subject/schema tuple;
- there is no public subject feed, account-wide Credential enumeration or search index over claims;
- any future browsable Credential catalog requires a separately designed, explicit opt-in signal;
  the existence of a public ledger object alone is not interpreted as that opt-in.

Commons remains neutral. The product displays addresses and the four independent verification
dimensions, but provides no issuer badge, ranking, reputation score or universal trust decision.
Schema registration remains permissionless; visibility does not mean endorsement.

The original public baseline uses issuer-hosted HTTPS payloads. The browser fetches an exact public
payload only after displaying its host and obtaining consent, checks integrity locally and sends
the parsed object for schema verification. Optional signed-upload hosting now stores explicitly
consented public payloads; the issuer workspace separately stores managed public/private payloads
under the access rules in ADR 0005. Public discovery still neither enumerates nor searches claims.

Public Studio and verification require no application account. Optional account, admin and issuer
workspaces add server sessions and organization records without a custodial signing service. Signing keys
remain in the issuer- or subject-controlled wallet behind the pinned XRPL Connect sign-only
boundary, and the browser journal remains local to the device. The factory covers Xaman, Crossmark,
GemWallet, WalletConnect, Ledger, Xyra, Otsu and MetaMask Snap, with Xaman and WalletConnect enabled
only when their public application identifiers are configured. XCS never delegates submission
through `signAndSubmit`: it verifies, persists and submits the signed transaction itself. Issuance is
unitary; batch issuance, team membership and hosted automation remain outside this implementation.
The optional issuer portal requires current approval; this does not restrict permissionless protocol
transactions or the accountless public Studio.

This surface does not promise that every wallet is compatible. WalletConnect discovery is useful
only when the selected wallet supports the XRPL Testnet namespace and native `Credential*`
transactions, and every enabled adapter still needs real Testnet certification.

The public integration contract is REST-first. GraphQL may be reconsidered only after real REST
usage demonstrates a need. The initial end-to-end pilot covers course participation/completion and
diploma-style credentials.

XRPL Commons operates the shared web application, dual-source indexer, read API and PostgreSQL
projection for convenience. PostgreSQL is a reconstructible cache of validated ledger history, not
protocol truth. The projection holds neither signing keys nor credential claims, and independent
operators may rebuild and compare it. Optional application/payload storage is separate, contains
claims and cannot be reconstructed from ledger history; it requires its own access controls and backups.

## Consequences

- Public schema exploration can be rich without creating a centralized issuer directory.
- Exact Credential permalinks are shareable and independently verifiable, while subject-wide
  browsing remains unavailable.
- The Explorer cannot offer a global attestation feed identical to EASScan. This is an intentional
  privacy/product boundary, not an indexing limitation.
- External payload hosts must support browser CORS and retain exact canonical bytes. Optional hosted
  storage adds deployment and retention responsibilities without changing protocol integrity rules.
- Accountless public routes remain available alongside optional authenticated workspaces. Browser-local
  operation recovery does not automatically follow an issuer across browsers or devices.
- Xaman and WalletConnect application identifiers are public browser configuration, not signing
  secrets. Removing them or restricting the adapter factory is a wallet-only rollback with no
  protocol or database-schema migration.
- Permissionless schemas require clear non-endorsement messaging and abuse-resistant presentation;
  moderation must never rewrite protocol validity.
- Product and API additions remain non-normative and backward-compatible with frozen v0.1 data.

## Alternatives rejected for the original public baseline

The payload-hosting and account exclusions below describe the initial decision. ADR 0005 and the
implemented optional hosting/portal flows now extend those two boundaries; the other exclusions remain.

- cloning the EAS protocol or storing attestations in an EVM contract;
- a public feed or subject-address directory of every indexed Credential;
- Commons-hosted payload claims or default public IPFS pinning;
- Commons-issued trust badges or a canonical issuer ranking;
- custodial keys, XCS accounts, batch issuance or multi-tenant administration;
- GraphQL before a stable REST contract and measured consumer demand.
