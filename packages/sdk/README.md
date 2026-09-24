# `@xcs-protocol/sdk`

XRPL transaction builders and submission helpers for XCS v0.1.

The package has three responsibilities:

- build schema-registration `Payment` transactions and native XRPL
  `CredentialCreate`, `CredentialAccept`, and `CredentialDelete` transactions;
- validate that a transaction has XCS semantics for a network profile;
- autofill, sign, submit, and reconcile a transaction without ever handling a seed or private key.

Protocol data validation, canonical JSON, payload URIs, schema resolution, and UID derivation live in
`@xcs-protocol/core`. XRPL serialization, address validation, signing, and submission use `xrpl.js`.

## Transaction flow

Use `prepareSignAndSubmit` for a headless signer. A UI that previews the final transaction should:

1. call `autofillXcsTransaction`;
2. display the returned transaction to the user;
3. pass that exact transaction to `signPreparedAndSubmit`.

`signPreparedAndSubmit` validates the wallet result, rejects non-signature mutations, and reconciles
ambiguous submission results. The `Signer` interface receives unsigned transaction JSON and returns
only a signed blob and transaction hash. Hosts integrating a wallet that refreshes
`LastLedgerSequence` may explicitly enable `allowSignerLastLedgerSequenceRefresh`; every other
non-signature field remains bound to the reviewed transaction, and submission uses the signed expiry
value.

After signing, the SDK checks the current ledger before invoking `onValidatedSignature`. An
already-expired fresh signature is rejected without persisting recovery material or relaying it;
the journal records a failed preparation so the host can offer a fresh review. It checks again
after `beforeSubmit`, immediately before relay. If expiry occurs after recovery material was
exposed to host hooks, the operation remains signed and recoverable. These first-submission
guards do not establish historical absence for `submitSignedTransaction` retries.

The optional operation journal records hashes and lifecycle stages, never signed blobs, payloads,
seeds, or private keys. Browser and service hosts can persist a validated signed blob through
`onValidatedSignature` before the first relay attempt. Volatile checks belong in `beforeSubmit`; if
that hook rejects, the SDK keeps the journal stage `signed` so the host's persisted artifact remains
recoverable instead of being mislabeled as a terminal signing failure.

`getTransactionStatus` returns `not_found`, not `expired`, when the node cannot find a hash.
An open ledger beyond `LastLedgerSequence` does not prove that the transaction failed: it may
still validate in the preceding ledger or be missing from this node's history. Polling keeps
reconciling until a validated result or the timeout; a timeout remains `pending`. The current
journal does not store the submission-window start needed to prove final absence, so it does
not automatically release an unresolved operation's business lock. `LastLedgerSequence` still
prevents XRPL from validating the signed blob in a later ledger. See
[XRPL reliable submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission).

## Network safety

`connectAndValidateNetwork` checks the connected network ID, required amendment, and profile
activation anchor. `verifyNetworkProfileActivation` additionally reads the immutable activation
ledger and therefore requires a history-capable rippled endpoint.

`assertXcsTransactionSemantics` accepts only:

- the exact schema registry `Payment`, amount, flags, and canonical memo defined by the profile;
- native credential transactions containing a valid XCS schema UID and, for creation, an
  integrity-bound payload URI.

Schema UIDs cannot be known before inclusion. `deriveSchemaUid` requires validated ledger and
transaction coordinates with a `tesSUCCESS` result.

## Payload URI note

XRPL permits a 256-byte Credential URI. The locked `xrpl.js` 5.0.0 validator currently applies its
limit to the hexadecimal JSON representation, so submission helpers reject URIs above 128 bytes.
Prefer a raw CIDv1 IPFS URI or a short HTTPS URL until that upstream behavior changes.
