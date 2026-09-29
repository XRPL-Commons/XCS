package xcs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"regexp"
	"strings"
)

const maxPayloadBytes = 1024 * 1024

var (
	ipfsPattern        = regexp.MustCompile(`^ipfs://(b[a-z2-7]+)$`)
	httpsDigestPattern = regexp.MustCompile(`^xcs-sha256=([0-9a-f]{64})$`)
)

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567"

func decodeBase32Lower(value string) ([]byte, bool) {
	bits := 0
	accumulator := 0
	decoded := make([]byte, 0, len(value)*5/8)
	for _, character := range value {
		digit := strings.IndexRune(base32Alphabet, character)
		if digit < 0 {
			return nil, false
		}
		accumulator = accumulator<<5 | digit
		bits += 5
		if bits >= 8 {
			bits -= 8
			decoded = append(decoded, byte(accumulator>>bits&0xff))
			accumulator &= 1<<bits - 1
		}
	}
	return decoded, bits == 0 || accumulator == 0
}

type CredentialPayload struct {
	XCSVersion string         `json:"xcsVersion"`
	Issuer     string         `json:"issuer"`
	Subject    string         `json:"subject"`
	Schema     string         `json:"schema"`
	Claims     map[string]any `json:"claims"`
}

type PayloadContext struct {
	Issuer    string
	Subject   string
	SchemaUID string
	Schema    SchemaDefinition
}

type PayloadURI struct {
	Kind      string `json:"kind"`
	URI       string `json:"uri"`
	FetchURL  string `json:"fetchUrl,omitempty"`
	CID       string `json:"cid,omitempty"`
	DigestHex string `json:"digestHex"`
}

func ParseCredentialPayload(data []byte, context PayloadContext) (CredentialPayload, error) {
	if len(data) > maxPayloadBytes {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$payload", "payload exceeds 1 MiB")
	}
	value, err := ParseJSON(data)
	if err != nil {
		return CredentialPayload{}, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$", "payload must be an object")
	}
	allowed := map[string]bool{
		"xcsVersion": true, "issuer": true, "subject": true, "schema": true, "claims": true,
	}
	for key := range object {
		if !allowed[key] {
			return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$."+key, "unknown payload property")
		}
	}
	version, versionOK := object["xcsVersion"].(string)
	issuer, issuerOK := object["issuer"].(string)
	subject, subjectOK := object["subject"].(string)
	schemaUID, schemaOK := object["schema"].(string)
	claims, claimsOK := object["claims"].(map[string]any)
	if !versionOK || version != "0.1" {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$.xcsVersion", "must be 0.1")
	}
	if !issuerOK || !IsClassicAddress(issuer) || issuer != context.Issuer {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$.issuer", "does not match credential issuer")
	}
	if !subjectOK || !IsClassicAddress(subject) || subject != context.Subject {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$.subject", "does not match credential subject")
	}
	if !schemaOK || !uidPattern.MatchString(schemaUID) || schemaUID != context.SchemaUID {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$.schema", "does not match CredentialType")
	}
	if !claimsOK {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$.claims", "must be an object")
	}
	if err := ValidateClaimsAgainstSchema(claims, context.Schema); err != nil {
		return CredentialPayload{}, err
	}
	canonical, err := Canonicalize(object)
	if err != nil {
		return CredentialPayload{}, err
	}
	if !bytes.Equal(canonical, data) {
		return CredentialPayload{}, invalid("PAYLOAD_INVALID", "$payload", "payload is not RFC 8785 canonical JSON")
	}
	return CredentialPayload{
		XCSVersion: version,
		Issuer:     issuer,
		Subject:    subject,
		Schema:     schemaUID,
		Claims:     claims,
	}, nil
}

func InspectPayloadURI(rawURI string) (PayloadURI, error) {
	if len([]byte(rawURI)) < 1 || len([]byte(rawURI)) > 256 {
		return PayloadURI{}, invalid("PAYLOAD_URI_INVALID", "$uri", "must contain 1 to 256 UTF-8 bytes")
	}
	if match := ipfsPattern.FindStringSubmatch(rawURI); match != nil {
		cid := match[1]
		decoded, ok := decodeBase32Lower(cid[1:])
		if !ok || len(cid) != 59 || len(decoded) != 36 || decoded[0] != 1 || decoded[1] != 0x55 || decoded[2] != 0x12 || decoded[3] != 0x20 {
			return PayloadURI{}, invalid("PAYLOAD_URI_INVALID", "$uri", "IPFS URI is not a raw sha2-256 CIDv1")
		}
		return PayloadURI{
			Kind: "ipfs", URI: rawURI, CID: cid, DigestHex: hex.EncodeToString(decoded[4:]),
		}, nil
	}
	parsed, err := url.Parse(rawURI)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return PayloadURI{}, invalid("PAYLOAD_URI_INVALID", "$uri", "must be HTTPS without user information")
	}
	digestMatch := httpsDigestPattern.FindStringSubmatch(parsed.Fragment)
	if digestMatch == nil {
		return PayloadURI{}, invalid("PAYLOAD_URI_INVALID", "$uri", "missing lowercase xcs-sha256 fragment")
	}
	digest := digestMatch[1]
	parsed.Fragment = ""
	return PayloadURI{
		Kind: "https", URI: rawURI, FetchURL: parsed.String(), DigestHex: digest,
	}, nil
}

func VerifyPayloadIntegrity(data []byte, rawURI string) (bool, string, string, error) {
	if len(data) > maxPayloadBytes {
		return false, "", "", invalid("PAYLOAD_INVALID", "$payload", "payload exceeds 1 MiB")
	}
	digest := sha256.Sum256(data)
	actual := hex.EncodeToString(digest[:])
	parsed, err := InspectPayloadURI(rawURI)
	if err != nil {
		return false, "", actual, err
	}
	return parsed.DigestHex == actual, parsed.DigestHex, actual, nil
}
