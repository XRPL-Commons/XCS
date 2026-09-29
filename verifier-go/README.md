# Independent Go verifier

This module is an offline, standard-library-only implementation of the XCS v0.1
deterministic rules. It does not import or execute the TypeScript implementation.

Run its shared conformance suite:

```sh
GOCACHE=/tmp/xcs-go-cache go test ./...
```

Build the CLI:

```sh
go build -o xcs-verify ./cmd/xcs-verify
```

Commands:

```text
xcs-verify uid UID_INPUT.json
xcs-verify schema SCHEMA.json
xcs-verify claims SCHEMA.json CLAIMS.json
xcs-verify payload SCHEMA.json PAYLOAD.json URI ISSUER SUBJECT SCHEMA_UID
```

Every command writes one JSON result. Protocol errors are written to stderr with
a stable `code`, `path`, and `message`, then the process exits non-zero.

The `claims` and `payload` commands require a locally complete schema. If the
input schema contains `extends`, they fail closed with `SCHEMA_PARENT_NOT_FOUND`;
the offline CLI has no ledger-backed parent catalog from which to resolve
inherited fields.
