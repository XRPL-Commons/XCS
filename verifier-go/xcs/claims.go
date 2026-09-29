package xcs

import (
	"encoding/base64"
	"math/big"
	"regexp"
	"strconv"
)

var (
	unsignedDecimal = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
	signedDecimal   = regexp.MustCompile(`^(?:0|-?[1-9][0-9]*)$`)
	uintMaximum     = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	intMaximum      = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(1))
	intMinimum      = new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 255))
)

func validateClaimValue(value any, descriptor FieldDescriptor, path string) error {
	if value == nil {
		return invalid("CLAIMS_INVALID", path, "null is not allowed")
	}
	switch descriptor.Type {
	case "string":
		if _, ok := value.(string); !ok {
			return invalid("CLAIMS_INVALID", path, "expected string")
		}
	case "bool":
		if _, ok := value.(bool); !ok {
			return invalid("CLAIMS_INVALID", path, "expected boolean")
		}
	case "uint":
		text, ok := value.(string)
		if !ok || len(text) > 78 || !unsignedDecimal.MatchString(text) {
			return invalid("CLAIMS_INVALID", path, "expected canonical unsigned decimal string")
		}
		parsed, _ := new(big.Int).SetString(text, 10)
		if parsed.Cmp(uintMaximum) > 0 {
			return invalid("CLAIMS_INVALID", path, "uint exceeds 256-bit range")
		}
	case "int":
		text, ok := value.(string)
		if !ok || len(text) > 79 || !signedDecimal.MatchString(text) {
			return invalid("CLAIMS_INVALID", path, "expected canonical signed decimal string")
		}
		parsed, _ := new(big.Int).SetString(text, 10)
		if parsed.Cmp(intMinimum) < 0 || parsed.Cmp(intMaximum) > 0 {
			return invalid("CLAIMS_INVALID", path, "int exceeds signed 256-bit range")
		}
	case "bytes":
		text, ok := value.(string)
		if !ok {
			return invalid("CLAIMS_INVALID", path, "expected base64url string")
		}
		decoded, err := base64.RawURLEncoding.DecodeString(text)
		if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != text {
			return invalid("CLAIMS_INVALID", path, "expected canonical base64url without padding")
		}
	case "address":
		text, ok := value.(string)
		if !ok || !IsClassicAddress(text) {
			return invalid("CLAIMS_INVALID", path, "expected XRPL classic address")
		}
	case "array":
		values, ok := value.([]any)
		if !ok || descriptor.Items == nil {
			return invalid("CLAIMS_INVALID", path, "expected array")
		}
		for index, element := range values {
			if err := validateClaimValue(element, *descriptor.Items, path+"["+strconv.Itoa(index)+"]"); err != nil {
				return err
			}
		}
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return invalid("CLAIMS_INVALID", path, "expected object")
		}
		return validateClaimObject(object, descriptor.Fields, path)
	default:
		return invalid("CLAIMS_INVALID", path, "unsupported descriptor")
	}
	return nil
}

func validateClaimObject(claims map[string]any, fields map[string]FieldDescriptor, path string) error {
	for name := range claims {
		if _, ok := fields[name]; !ok {
			return invalid("CLAIMS_INVALID", path+"."+name, "unknown claim")
		}
	}
	for name, descriptor := range fields {
		value, exists := claims[name]
		if !exists {
			if descriptor.Optional {
				continue
			}
			return invalid("CLAIMS_INVALID", path+"."+name, "missing required claim")
		}
		if err := validateClaimValue(value, descriptor, path+"."+name); err != nil {
			return err
		}
	}
	return nil
}

func ValidateClaims(claims map[string]any, fields map[string]FieldDescriptor) error {
	return validateClaimObject(claims, fields, "$.claims")
}

// ValidateClaimsAgainstSchema validates claims only when the supplied schema is
// locally complete. Inherited schemas require parent resolution, which this
// offline verifier cannot infer from a child definition alone.
func ValidateClaimsAgainstSchema(claims map[string]any, schema SchemaDefinition) error {
	if err := ValidateSchema(schema); err != nil {
		return err
	}
	if schema.Extends != "" {
		return invalid(
			"SCHEMA_PARENT_NOT_FOUND",
			"$.extends",
			"cannot validate claims against an unresolved inherited schema",
		)
	}
	return ValidateClaims(claims, schema.Fields)
}
