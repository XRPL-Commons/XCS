package xcs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

var hashPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type SchemaUIDInput struct {
	NetworkID        uint32           `json:"networkId"`
	LedgerHash       string           `json:"ledgerHash"`
	LedgerIndex      uint32           `json:"ledgerIndex"`
	TransactionIndex uint32           `json:"transactionIndex"`
	Publisher        string           `json:"publisher"`
	Schema           SchemaDefinition `json:"schema"`
}

func ParseSchemaUIDInput(data []byte) (SchemaUIDInput, error) {
	parsed, err := ParseJSON(data)
	if err != nil {
		return SchemaUIDInput{}, err
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return SchemaUIDInput{}, invalid("UID_INPUT_INVALID", "$", "must be an object")
	}
	for _, field := range []string{"networkId", "ledgerIndex", "transactionIndex"} {
		value, exists := object[field]
		number, valid := value.(json.Number)
		if !exists || !valid {
			return SchemaUIDInput{}, invalid("UID_INPUT_INVALID", "$."+field, "must be a present uint32")
		}
		if _, err := strconv.ParseUint(number.String(), 10, 32); err != nil {
			return SchemaUIDInput{}, invalid("UID_INPUT_INVALID", "$."+field, "must be a uint32")
		}
	}

	var raw struct {
		NetworkID        uint32          `json:"networkId"`
		LedgerHash       string          `json:"ledgerHash"`
		LedgerIndex      uint32          `json:"ledgerIndex"`
		TransactionIndex uint32          `json:"transactionIndex"`
		Publisher        string          `json:"publisher"`
		Schema           json.RawMessage `json:"schema"`
	}
	if err := decodeKnownJSON(data, &raw); err != nil {
		return SchemaUIDInput{}, err
	}
	schema, err := ParseSchema(raw.Schema)
	if err != nil {
		return SchemaUIDInput{}, err
	}
	return SchemaUIDInput{
		NetworkID:        raw.NetworkID,
		LedgerHash:       raw.LedgerHash,
		LedgerIndex:      raw.LedgerIndex,
		TransactionIndex: raw.TransactionIndex,
		Publisher:        raw.Publisher,
		Schema:           schema,
	}, nil
}

func ComputeSchemaUID(input SchemaUIDInput) (string, []byte, error) {
	if !hashPattern.MatchString(input.LedgerHash) {
		return "", nil, invalid("UID_INPUT_INVALID", "$.ledgerHash", "must be a 32-byte hex hash")
	}
	if !IsClassicAddress(input.Publisher) {
		return "", nil, invalid("UID_INPUT_INVALID", "$.publisher", "must be an XRPL classic address")
	}
	if err := ValidateSchema(input.Schema); err != nil {
		return "", nil, err
	}
	preimage := map[string]any{
		"purpose":          "xcs.schema.uid",
		"version":          "0.1",
		"networkId":        input.NetworkID,
		"ledgerHash":       strings.ToLower(input.LedgerHash),
		"ledgerIndex":      input.LedgerIndex,
		"transactionIndex": input.TransactionIndex,
		"publisher":        input.Publisher,
		"schema":           schemaMap(input.Schema),
	}
	canonical, err := Canonicalize(preimage)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), canonical, nil
}
