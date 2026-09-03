# Contributing

XCS is an interoperability protocol. Changes to canonicalization, schema validation, UID generation, wire encoding or verification results are public-contract changes, even when the code diff is small.

## Development workflow

1. Open an issue describing observable behavior and compatibility impact.
2. For normative changes, add or update an ADR and language-neutral conformance vectors first.
3. Update both the TypeScript core and independent Go verifier.
4. Run `pnpm verify` and `go test ./...` from `verifier-go`.
5. Before production, regenerate the database baseline and document reset/recovery steps for
   persistent-data changes. After production launch, add forward migration notes instead.

Normative identifiers, API fields, error codes and code comments are English. User documentation and the playground are maintained in English and French.

## Compatibility

An existing valid schema is never reinterpreted. A change that affects schema validity, UID bytes or payload interpretation requires a new XCS protocol version and network activation profile.

Do not commit secrets, `.env` files, Testnet wallet seeds, database dumps or payloads containing personal data.
