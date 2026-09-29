package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/XRPL-Commons/XCS/verifier-go/xcs"
)

func read(path string) []byte {
	data, err := os.ReadFile(path)
	if err != nil {
		fatal(err)
	}
	return data
}

func write(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	var protocolError *xcs.Error
	if errors.As(err, &protocolError) {
		_ = json.NewEncoder(os.Stderr).Encode(protocolError)
	} else {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]string{
			"code": "INTERNAL", "message": err.Error(),
		})
	}
	os.Exit(1)
}

func usage() {
	fmt.Fprintln(os.Stderr, `Offline XCS v0.1 verifier

Usage:
  xcs-verify uid UID_INPUT.json
  xcs-verify schema SCHEMA.json
  xcs-verify claims SCHEMA.json CLAIMS.json
  xcs-verify payload SCHEMA.json PAYLOAD.json URI ISSUER SUBJECT SCHEMA_UID`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	switch os.Args[1] {
	case "uid":
		if len(os.Args) != 3 {
			usage()
		}
		input, err := xcs.ParseSchemaUIDInput(read(os.Args[2]))
		if err != nil {
			fatal(err)
		}
		uid, preimage, err := xcs.ComputeSchemaUID(input)
		if err != nil {
			fatal(err)
		}
		write(map[string]any{"valid": true, "uid": uid, "canonicalPreimage": string(preimage)})
	case "schema":
		if len(os.Args) != 3 {
			usage()
		}
		if _, err := xcs.ParseSchema(read(os.Args[2])); err != nil {
			fatal(err)
		}
		write(map[string]any{"valid": true})
	case "claims":
		if len(os.Args) != 4 {
			usage()
		}
		schema, err := xcs.ParseSchema(read(os.Args[2]))
		if err != nil {
			fatal(err)
		}
		value, err := xcs.ParseJSON(read(os.Args[3]))
		if err != nil {
			fatal(err)
		}
		claims, ok := value.(map[string]any)
		if !ok {
			fatal(fmt.Errorf("claims must be a JSON object"))
		}
		if err := xcs.ValidateClaimsAgainstSchema(claims, schema); err != nil {
			fatal(err)
		}
		write(map[string]any{"valid": true})
	case "payload":
		if len(os.Args) != 8 {
			usage()
		}
		schema, err := xcs.ParseSchema(read(os.Args[2]))
		if err != nil {
			fatal(err)
		}
		payloadBytes := read(os.Args[3])
		integrity, expected, actual, err := xcs.VerifyPayloadIntegrity(payloadBytes, os.Args[4])
		if err != nil {
			fatal(err)
		}
		if _, err := xcs.ParseCredentialPayload(payloadBytes, xcs.PayloadContext{
			Issuer: os.Args[5], Subject: os.Args[6], SchemaUID: os.Args[7], Schema: schema,
		}); err != nil {
			fatal(err)
		}
		write(map[string]any{
			"valid": integrity, "expectedDigestHex": expected, "actualDigestHex": actual,
		})
	default:
		usage()
	}
}
