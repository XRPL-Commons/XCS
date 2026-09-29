# XCS conformance vectors

`v0.1/` contains language-neutral JSON fixtures for the normative, deterministic
parts of XCS. Implementations must consume the values as data; they must not call
or embed another implementation.

- `canonicalization.json`: strict JSON parsing and RFC 8785 output.
- `schema-uid.json`: complete UID preimages and SHA-256 results.
- `claims.json`: valid and invalid typed claim objects.
- `payload-integrity.json`: HTTPS digests and raw CIDv1 values.

The TypeScript core and the standalone Go verifier both execute these vectors in
their test suites.

Schema normalization is part of the wire contract: an explicit
`"optional": false` is equivalent to the default and is omitted before JCS and
UID computation. Implementations must never hash the unnormalized input object.
