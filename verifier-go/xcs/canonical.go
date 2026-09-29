package xcs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func ParseJSON(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, invalid("JSON_INVALID_UNICODE", "$", "input is not valid UTF-8")
	}
	if err := validateUnicodeEscapes(data); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder, "$")
	if err != nil {
		if _, ok := err.(*Error); ok {
			return nil, err
		}
		return nil, invalid("JSON_INVALID", "$", "%v", err)
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, invalid("JSON_INVALID", "$", "unexpected trailing content")
	}
	return value, nil
}

func hexQuad(data []byte) (uint16, bool) {
	if len(data) < 4 {
		return 0, false
	}
	var value uint16
	for _, character := range data[:4] {
		value <<= 4
		switch {
		case character >= '0' && character <= '9':
			value += uint16(character - '0')
		case character >= 'a' && character <= 'f':
			value += uint16(character-'a') + 10
		case character >= 'A' && character <= 'F':
			value += uint16(character-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func validateUnicodeEscapes(data []byte) error {
	inString := false
	for index := 0; index < len(data); index++ {
		switch data[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(data) {
				continue
			}
			index++
			if data[index] != 'u' {
				continue
			}
			first, ok := hexQuad(data[index+1:])
			if !ok {
				continue // encoding/json reports malformed escapes.
			}
			index += 4
			if first >= 0xd800 && first <= 0xdbff {
				if index+6 >= len(data) || data[index+1] != '\\' || data[index+2] != 'u' {
					return invalid("JSON_INVALID_UNICODE", "$", "unpaired high surrogate")
				}
				second, valid := hexQuad(data[index+3:])
				if !valid || second < 0xdc00 || second > 0xdfff {
					return invalid("JSON_INVALID_UNICODE", "$", "invalid low surrogate")
				}
				index += 6
			} else if first >= 0xdc00 && first <= 0xdfff {
				return invalid("JSON_INVALID_UNICODE", "$", "unpaired low surrogate")
			}
		}
	}
	return nil
}

func decodeValue(decoder *json.Decoder, path string) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, invalid("JSON_INVALID", path, "object key is not a string")
			}
			if _, exists := object[key]; exists {
				return nil, invalid("JSON_DUPLICATE_KEY", path+"."+key, "duplicate object key")
			}
			value, err := decodeValue(decoder, path+"."+key)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for decoder.More() {
			value, err := decodeValue(decoder, path)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return array, nil
	default:
		return nil, invalid("JSON_INVALID", path, "unexpected delimiter")
	}
}

func appendString(destination *bytes.Buffer, value string) error {
	if !utf8.ValidString(value) {
		return invalid("JSON_INVALID_UNICODE", "$", "string is not valid UTF-8")
	}
	destination.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"', '\\':
			destination.WriteByte('\\')
			destination.WriteRune(character)
		case '\b':
			destination.WriteString("\\b")
		case '\t':
			destination.WriteString("\\t")
		case '\n':
			destination.WriteString("\\n")
		case '\f':
			destination.WriteString("\\f")
		case '\r':
			destination.WriteString("\\r")
		default:
			if character < 0x20 {
				fmt.Fprintf(destination, "\\u%04x", character)
			} else {
				destination.WriteRune(character)
			}
		}
	}
	destination.WriteByte('"')
	return nil
}

func formatECMAScriptNumber(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", invalid("JSON_NON_IJSON_NUMBER", "$", "number is not finite")
	}
	if value == 0 {
		return "0", nil
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64), nil
	}
	scientific := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.Split(scientific, "e")
	exponent, err := strconv.Atoi(parts[1])
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%se%+d", parts[0], exponent), nil
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	for index := 0; index < len(leftUnits) && index < len(rightUnits); index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func appendCanonical(destination *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		destination.WriteString("null")
	case bool:
		if typed {
			destination.WriteString("true")
		} else {
			destination.WriteString("false")
		}
	case string:
		return appendString(destination, typed)
	case json.Number:
		parsed, err := strconv.ParseFloat(string(typed), 64)
		if err != nil {
			return invalid("JSON_NON_IJSON_NUMBER", "$", "%v", err)
		}
		formatted, err := formatECMAScriptNumber(parsed)
		if err != nil {
			return err
		}
		destination.WriteString(formatted)
	case float64:
		formatted, err := formatECMAScriptNumber(typed)
		if err != nil {
			return err
		}
		destination.WriteString(formatted)
	case int:
		destination.WriteString(strconv.Itoa(typed))
	case uint32:
		destination.WriteString(strconv.FormatUint(uint64(typed), 10))
	case []any:
		destination.WriteByte('[')
		for index, element := range typed {
			if index > 0 {
				destination.WriteByte(',')
			}
			if err := appendCanonical(destination, element); err != nil {
				return err
			}
		}
		destination.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return utf16Less(keys[left], keys[right]) })
		destination.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				destination.WriteByte(',')
			}
			if err := appendString(destination, key); err != nil {
				return err
			}
			destination.WriteByte(':')
			if err := appendCanonical(destination, typed[key]); err != nil {
				return err
			}
		}
		destination.WriteByte('}')
	default:
		return invalid("CANONICALIZATION_UNSUPPORTED_VALUE", "$", "unsupported value %T", value)
	}
	return nil
}

func Canonicalize(value any) ([]byte, error) {
	var result bytes.Buffer
	if err := appendCanonical(&result, value); err != nil {
		return nil, err
	}
	return result.Bytes(), nil
}
