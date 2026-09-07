# Contributing

Keep changes small, testable, and owned by one layer.

1. Put deterministic protocol behavior in `packages/core`.
2. Use `xrpl.js` for XRPL primitives and vetted libraries for cryptography, encoding, canonicalization, and parsing. Do not implement those primitives locally.
3. Keep signing outside XCS; builders return unsigned transactions and wallets own keys.
4. Add tests for observable behavior and important rejection paths.
5. Run the affected package checks, then `pnpm verify` when the whole workspace is stable.
6. Include rollout and recovery notes for persistent-data changes.

Changes to schema validity, UID derivation, canonical payload bytes, URI integrity, or lifecycle projection are protocol changes. Document them in an ADR and update the specification before shipping them.
