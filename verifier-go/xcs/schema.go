package xcs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxSchemaDepth  = 16
	maxSchemaFields = 256
)

var (
	fieldNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	uidPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func containsControl(value string) bool {
	for _, character := range value {
		if character <= 0x1f || (character >= 0x7f && character <= 0x9f) {
			return true
		}
	}
	return false
}

type FieldDescriptor struct {
	Type      string                     `json:"type"`
	Optional  bool                       `json:"optional,omitempty"`
	Items     *FieldDescriptor           `json:"items,omitempty"`
	Fields    map[string]FieldDescriptor `json:"fields,omitempty"`
	itemsSet  bool
	fieldsSet bool
}

func (descriptor *FieldDescriptor) UnmarshalJSON(data []byte) error {
	var properties map[string]json.RawMessage
	if err := json.Unmarshal(data, &properties); err != nil {
		return err
	}
	for key := range properties {
		switch key {
		case "type", "optional", "items", "fields":
		default:
			return invalid("SCHEMA_INVALID", "$", "unknown field descriptor property %q", key)
		}
	}
	if err := json.Unmarshal(properties["type"], &descriptor.Type); err != nil {
		return err
	}
	if raw, exists := properties["optional"]; exists {
		var optional any
		if err := json.Unmarshal(raw, &optional); err != nil {
			return err
		}
		value, ok := optional.(bool)
		if !ok {
			return invalid("SCHEMA_INVALID", "$", "optional must be a boolean")
		}
		descriptor.Optional = value
	}
	if raw, exists := properties["items"]; exists {
		descriptor.itemsSet = true
		if string(raw) != "null" {
			var items FieldDescriptor
			if err := json.Unmarshal(raw, &items); err != nil {
				return err
			}
			descriptor.Items = &items
		}
	}
	if raw, exists := properties["fields"]; exists {
		descriptor.fieldsSet = true
		if err := json.Unmarshal(raw, &descriptor.Fields); err != nil {
			return err
		}
	}
	return nil
}

type SchemaDefinition struct {
	XCSVersion  string                     `json:"xcsVersion"`
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	Extends     string                     `json:"extends,omitempty"`
	Supersedes  string                     `json:"supersedes,omitempty"`
	Fields      map[string]FieldDescriptor `json:"fields"`
}

func decodeKnownJSON(data []byte, destination any) error {
	if _, err := ParseJSON(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(destination); err != nil {
		var protocolError *Error
		if errors.As(err, &protocolError) {
			return protocolError
		}
		return invalid("JSON_INVALID", "$", "%v", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return invalid("JSON_INVALID", "$", "unexpected trailing content")
	}
	return nil
}

func ParseSchema(data []byte) (SchemaDefinition, error) {
	parsed, err := ParseJSON(data)
	if err != nil {
		return SchemaDefinition{}, err
	}
	if object, ok := parsed.(map[string]any); ok {
		for _, relation := range []string{"extends", "supersedes"} {
			if value, exists := object[relation]; exists {
				relationUID, valid := value.(string)
				if !valid || !uidPattern.MatchString(relationUID) {
					return SchemaDefinition{}, invalid("SCHEMA_INVALID", "$."+relation, "must be a lowercase schema UID")
				}
			}
		}
	}
	var schema SchemaDefinition
	if err := decodeKnownJSON(data, &schema); err != nil {
		return SchemaDefinition{}, err
	}
	if err := ValidateSchema(schema); err != nil {
		return SchemaDefinition{}, err
	}
	return schema, nil
}

func incrementFieldCount(count *int, path string) error {
	(*count)++
	if *count > maxSchemaFields {
		return invalid("SCHEMA_FIELD_LIMIT_EXCEEDED", path, "more than %d fields", maxSchemaFields)
	}
	return nil
}

func validateFields(fields map[string]FieldDescriptor, path string, depth int, count *int) error {
	if len(fields) == 0 {
		return invalid("SCHEMA_INVALID", path, "fields must not be empty")
	}
	if depth > maxSchemaDepth {
		return invalid("SCHEMA_DEPTH_EXCEEDED", path, "field nesting exceeds %d", maxSchemaDepth)
	}
	for name, descriptor := range fields {
		if !fieldNamePattern.MatchString(name) {
			return invalid("SCHEMA_INVALID", path+"."+name, "invalid field name")
		}
		if err := incrementFieldCount(count, path+"."+name); err != nil {
			return err
		}
		fieldPath := path + "." + name
		switch descriptor.Type {
		case "string", "bool", "uint", "int", "bytes", "address":
			if descriptor.Items != nil || descriptor.Fields != nil || descriptor.itemsSet || descriptor.fieldsSet {
				return invalid("SCHEMA_INVALID", fieldPath, "scalar descriptor has composite properties")
			}
		case "array":
			if descriptor.Items == nil || descriptor.Fields != nil || descriptor.fieldsSet {
				return invalid("SCHEMA_INVALID", fieldPath, "array requires items only")
			}
			if err := validateDescriptor(*descriptor.Items, fieldPath+".items", depth+1, count); err != nil {
				return err
			}
		case "object":
			if descriptor.Items != nil || descriptor.itemsSet {
				return invalid("SCHEMA_INVALID", fieldPath, "object cannot define items")
			}
			if err := validateFields(descriptor.Fields, fieldPath+".fields", depth+1, count); err != nil {
				return err
			}
		default:
			return invalid("SCHEMA_INVALID", fieldPath+".type", "unsupported field type %q", descriptor.Type)
		}
	}
	return nil
}

func validateDescriptor(descriptor FieldDescriptor, path string, depth int, count *int) error {
	if depth > maxSchemaDepth {
		return invalid("SCHEMA_DEPTH_EXCEEDED", path, "field nesting exceeds %d", maxSchemaDepth)
	}
	if err := incrementFieldCount(count, path); err != nil {
		return err
	}
	switch descriptor.Type {
	case "string", "bool", "uint", "int", "bytes", "address":
		if descriptor.Items != nil || descriptor.Fields != nil || descriptor.itemsSet || descriptor.fieldsSet {
			return invalid("SCHEMA_INVALID", path, "scalar descriptor has composite properties")
		}
	case "array":
		if descriptor.Items == nil || descriptor.Fields != nil || descriptor.fieldsSet {
			return invalid("SCHEMA_INVALID", path, "array requires items only")
		}
		return validateDescriptor(*descriptor.Items, path+".items", depth+1, count)
	case "object":
		if descriptor.Items != nil || descriptor.itemsSet {
			return invalid("SCHEMA_INVALID", path, "object cannot define items")
		}
		return validateFields(descriptor.Fields, path+".fields", depth+1, count)
	default:
		return invalid("SCHEMA_INVALID", path+".type", "unsupported field type %q", descriptor.Type)
	}
	return nil
}

func ValidateSchema(schema SchemaDefinition) error {
	if schema.XCSVersion != "0.1" {
		return invalid("SCHEMA_INVALID", "$.xcsVersion", "must be 0.1")
	}
	if !utf8.ValidString(schema.Name) || len([]byte(schema.Name)) < 1 || len([]byte(schema.Name)) > 64 || containsControl(schema.Name) {
		return invalid("SCHEMA_INVALID", "$.name", "must contain 1 to 64 UTF-8 bytes")
	}
	if !utf8.ValidString(schema.Description) || len([]byte(schema.Description)) < 1 || len([]byte(schema.Description)) > 256 || containsControl(schema.Description) {
		return invalid("SCHEMA_INVALID", "$.description", "must contain 1 to 256 UTF-8 bytes")
	}
	if schema.Extends != "" && !uidPattern.MatchString(schema.Extends) {
		return invalid("SCHEMA_INVALID", "$.extends", "must be a lowercase schema UID")
	}
	if schema.Supersedes != "" && !uidPattern.MatchString(schema.Supersedes) {
		return invalid("SCHEMA_INVALID", "$.supersedes", "must be a lowercase schema UID")
	}
	if schema.Extends != "" && strings.EqualFold(schema.Extends, schema.Supersedes) {
		return invalid("SCHEMA_INVALID", "$", "extends and supersedes cannot be identical")
	}
	count := 0
	return validateFields(schema.Fields, "$.fields", 1, &count)
}

func descriptorMap(descriptor FieldDescriptor) map[string]any {
	result := map[string]any{"type": descriptor.Type}
	if descriptor.Optional {
		result["optional"] = true
	}
	if descriptor.Items != nil {
		result["items"] = descriptorMap(*descriptor.Items)
	}
	if descriptor.Type == "object" {
		result["fields"] = fieldsMap(descriptor.Fields)
	}
	return result
}

func fieldsMap(fields map[string]FieldDescriptor) map[string]any {
	result := make(map[string]any, len(fields))
	for name, descriptor := range fields {
		result[name] = descriptorMap(descriptor)
	}
	return result
}

func schemaMap(schema SchemaDefinition) map[string]any {
	result := map[string]any{
		"xcsVersion":  schema.XCSVersion,
		"name":        schema.Name,
		"description": schema.Description,
		"fields":      fieldsMap(schema.Fields),
	}
	if schema.Extends != "" {
		result["extends"] = schema.Extends
	}
	if schema.Supersedes != "" {
		result["supersedes"] = schema.Supersedes
	}
	return result
}
