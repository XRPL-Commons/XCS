package xcs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func vectorFile(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "conformance", "v0.1", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestCanonicalizationVectors(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Name      string `json:"name"`
			InputJSON string `json:"inputJson"`
			Canonical string `json:"canonical"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(vectorFile(t, "canonicalization.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			parsed, err := ParseJSON([]byte(vector.InputJSON))
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := Canonicalize(parsed)
			if err != nil {
				t.Fatal(err)
			}
			if string(canonical) != vector.Canonical {
				t.Fatalf("canonical mismatch\nwant %s\ngot  %s", vector.Canonical, canonical)
			}
		})
	}
}

func TestStrictJSONRejectsDuplicateKeys(t *testing.T) {
	_, err := ParseJSON([]byte(`{"a":1,"a":2}`))
	var xcsError *Error
	if !errors.As(err, &xcsError) || xcsError.Code != "JSON_DUPLICATE_KEY" {
		t.Fatalf("expected JSON_DUPLICATE_KEY, got %v", err)
	}
}

func TestStrictJSONRejectsUnpairedSurrogates(t *testing.T) {
	_, err := ParseJSON([]byte(`"\ud800"`))
	var xcsError *Error
	if !errors.As(err, &xcsError) || xcsError.Code != "JSON_INVALID_UNICODE" {
		t.Fatalf("expected JSON_INVALID_UNICODE, got %v", err)
	}
}

func TestSchemaUIDVectors(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Name              string         `json:"name"`
			Input             SchemaUIDInput `json:"input"`
			CanonicalPreimage string         `json:"canonicalPreimage"`
			UID               string         `json:"uid"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(vectorFile(t, "schema-uid.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			uid, canonical, err := ComputeSchemaUID(vector.Input)
			if err != nil {
				t.Fatal(err)
			}
			if uid != vector.UID {
				t.Fatalf("UID mismatch: want %s, got %s", vector.UID, uid)
			}
			if string(canonical) != vector.CanonicalPreimage {
				t.Fatalf("preimage mismatch\nwant %s\ngot  %s", vector.CanonicalPreimage, canonical)
			}
		})
	}
}

func TestSchemaUIDInputRequiresPresentNumericFields(t *testing.T) {
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "Course", Description: "Course completion",
		Fields: map[string]FieldDescriptor{"programId": {Type: "string"}},
	}
	for _, field := range []string{"networkId", "ledgerIndex", "transactionIndex"} {
		for _, variant := range []string{"missing", "null"} {
			t.Run(field+"_"+variant, func(t *testing.T) {
				input := map[string]any{
					"networkId":        0,
					"ledgerHash":       "abababababababababababababababababababababababababababababababab",
					"ledgerIndex":      0,
					"transactionIndex": 0,
					"publisher":        "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
					"schema":           schemaMap(schema),
				}
				if variant == "missing" {
					delete(input, field)
				} else {
					input[field] = nil
				}
				encoded, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				_, err = ParseSchemaUIDInput(encoded)
				var xcsError *Error
				if !errors.As(err, &xcsError) || xcsError.Code != "UID_INPUT_INVALID" {
					t.Fatalf("expected UID_INPUT_INVALID, got %v", err)
				}
			})
		}
	}
}

func TestClaimVectors(t *testing.T) {
	var vectors struct {
		Schema SchemaDefinition `json:"schema"`
		Cases  []struct {
			Name      string          `json:"name"`
			Valid     bool            `json:"valid"`
			ErrorCode string          `json:"errorCode"`
			Claims    json.RawMessage `json:"claims"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(vectorFile(t, "claims.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSchema(vectors.Schema); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			parsed, err := ParseJSON(vector.Claims)
			if err != nil {
				t.Fatal(err)
			}
			claims := parsed.(map[string]any)
			err = ValidateClaims(claims, vectors.Schema.Fields)
			if vector.Valid && err != nil {
				t.Fatalf("expected valid claims: %v", err)
			}
			if !vector.Valid {
				var xcsError *Error
				if !errors.As(err, &xcsError) || xcsError.Code != vector.ErrorCode {
					t.Fatalf("expected %s, got %v", vector.ErrorCode, err)
				}
			}
		})
	}
}

func TestSchemaRejectsControlCharacters(t *testing.T) {
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "unsafe\x00name", Description: "description",
		Fields: map[string]FieldDescriptor{"value": {Type: "string"}},
	}
	if err := ValidateSchema(schema); err == nil {
		t.Fatal("expected control-character rejection")
	}
}

func TestParsedSchemaRejectsNullCompositePropertiesOnScalar(t *testing.T) {
	_, err := ParseSchema([]byte(`{"xcsVersion":"0.1","name":"Name","description":"Description","fields":{"value":{"type":"string","items":null}}}`))
	if err == nil {
		t.Fatal("expected scalar items property rejection")
	}
}

func TestParsedSchemaRejectsNullOptionalAndRelations(t *testing.T) {
	cases := map[string]string{
		"optional":      `{"xcsVersion":"0.1","name":"Name","description":"Description","fields":{"value":{"type":"string","optional":null}}}`,
		"extends":       `{"xcsVersion":"0.1","name":"Name","description":"Description","extends":null,"fields":{"value":{"type":"string"}}}`,
		"empty extends": `{"xcsVersion":"0.1","name":"Name","description":"Description","extends":"","fields":{"value":{"type":"string"}}}`,
		"supersedes":    `{"xcsVersion":"0.1","name":"Name","description":"Description","supersedes":null,"fields":{"value":{"type":"string"}}}`,
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseSchema([]byte(input))
			var xcsError *Error
			if !errors.As(err, &xcsError) || xcsError.Code != "SCHEMA_INVALID" {
				t.Fatalf("expected SCHEMA_INVALID, got %v", err)
			}
		})
	}
}

func TestSchemaCountsArrayItemDescriptors(t *testing.T) {
	fields := make(map[string]FieldDescriptor, 128)
	for index := 0; index < 128; index++ {
		items := FieldDescriptor{Type: "string"}
		fields[fmt.Sprintf("field_%d", index)] = FieldDescriptor{Type: "array", Items: &items}
	}
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "At the descriptor limit", Description: "Array item descriptors count",
		Fields: fields,
	}
	if err := ValidateSchema(schema); err != nil {
		t.Fatalf("expected exactly 256 descriptors to be valid: %v", err)
	}

	items := FieldDescriptor{Type: "string"}
	schema.Fields["field_128"] = FieldDescriptor{Type: "array", Items: &items}
	err := ValidateSchema(schema)
	var xcsError *Error
	if !errors.As(err, &xcsError) || xcsError.Code != "SCHEMA_FIELD_LIMIT_EXCEEDED" {
		t.Fatalf("expected SCHEMA_FIELD_LIMIT_EXCEEDED, got %v", err)
	}
}

func TestPayloadIntegrityVectors(t *testing.T) {
	var vectors struct {
		Cases []struct {
			Name        string `json:"name"`
			ContentUTF8 string `json:"contentUtf8"`
			SHA256      string `json:"sha256"`
			URI         string `json:"uri"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(vectorFile(t, "payload-integrity.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			valid, expected, actual, err := VerifyPayloadIntegrity([]byte(vector.ContentUTF8), vector.URI)
			if err != nil {
				t.Fatal(err)
			}
			if !valid || expected != vector.SHA256 || actual != vector.SHA256 {
				t.Fatalf("integrity mismatch: valid=%v expected=%s actual=%s", valid, expected, actual)
			}
		})
	}
}

func TestCanonicalPayloadValidation(t *testing.T) {
	issuer := "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
	subject := "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"
	schemaUID := "abababababababababababababababababababababababababababababababab"
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "Course", Description: "Course completion",
		Fields: map[string]FieldDescriptor{"programId": {Type: "string"}},
	}
	value := map[string]any{
		"xcsVersion": "0.1", "issuer": issuer, "subject": subject, "schema": schemaUID,
		"claims": map[string]any{"programId": "course-1"},
	}
	canonical, err := Canonicalize(value)
	if err != nil {
		t.Fatal(err)
	}
	context := PayloadContext{Issuer: issuer, Subject: subject, SchemaUID: schemaUID, Schema: schema}
	if _, err := ParseCredentialPayload(canonical, context); err != nil {
		t.Fatal(err)
	}
	pretty, _ := json.MarshalIndent(value, "", "  ")
	if _, err := ParseCredentialPayload(pretty, context); err == nil {
		t.Fatal("expected non-canonical payload rejection")
	}
}

func TestPayloadValidationRejectsUnresolvedInheritedSchema(t *testing.T) {
	issuer := "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
	subject := "rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn"
	schemaUID := "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "Child", Description: "Unresolved inherited schema",
		Extends: "abababababababababababababababababababababababababababababababab",
		Fields:  map[string]FieldDescriptor{"child": {Type: "string"}},
	}
	value := map[string]any{
		"xcsVersion": "0.1", "issuer": issuer, "subject": subject, "schema": schemaUID,
		"claims": map[string]any{"child": "present"},
	}
	canonical, err := Canonicalize(value)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ParseCredentialPayload(canonical, PayloadContext{
		Issuer: issuer, Subject: subject, SchemaUID: schemaUID, Schema: schema,
	})
	var xcsError *Error
	if !errors.As(err, &xcsError) || xcsError.Code != "SCHEMA_PARENT_NOT_FOUND" {
		t.Fatalf("expected unresolved inheritance rejection, got %v", err)
	}
}

func TestClaimValidationRejectsUnresolvedInheritedSchema(t *testing.T) {
	schema := SchemaDefinition{
		XCSVersion: "0.1", Name: "Child", Description: "Unresolved inherited schema",
		Extends: "abababababababababababababababababababababababababababababababab",
		Fields:  map[string]FieldDescriptor{"child": {Type: "string"}},
	}
	err := ValidateClaimsAgainstSchema(map[string]any{"child": "present"}, schema)
	var xcsError *Error
	if !errors.As(err, &xcsError) || xcsError.Code != "SCHEMA_PARENT_NOT_FOUND" {
		t.Fatalf("expected unresolved inheritance rejection, got %v", err)
	}
}
