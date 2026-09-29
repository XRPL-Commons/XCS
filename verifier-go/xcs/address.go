package xcs

import (
	"crypto/sha256"
	"slices"
)

const xrpBase58Alphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"

func decodeBase58(value string) ([]byte, bool) {
	decoded := []byte{0}
	for _, character := range value {
		digit := -1
		for index, candidate := range xrpBase58Alphabet {
			if candidate == character {
				digit = index
				break
			}
		}
		if digit < 0 {
			return nil, false
		}
		carry := digit
		for index := len(decoded) - 1; index >= 0; index-- {
			carry += int(decoded[index]) * 58
			decoded[index] = byte(carry & 0xff)
			carry >>= 8
		}
		for carry > 0 {
			decoded = append([]byte{byte(carry & 0xff)}, decoded...)
			carry >>= 8
		}
	}

	zeroes := 0
	for zeroes < len(value) && value[zeroes] == xrpBase58Alphabet[0] {
		zeroes++
	}
	if len(decoded) == 1 && decoded[0] == 0 {
		decoded = decoded[:0]
	}
	return append(make([]byte, zeroes), decoded...), true
}

func IsClassicAddress(value string) bool {
	if len(value) < 25 || len(value) > 35 || value[0] != 'r' {
		return false
	}
	decoded, ok := decodeBase58(value)
	if !ok || len(decoded) != 25 || decoded[0] != 0 {
		return false
	}
	first := sha256.Sum256(decoded[:21])
	second := sha256.Sum256(first[:])
	return slices.Equal(decoded[21:], second[:4])
}
