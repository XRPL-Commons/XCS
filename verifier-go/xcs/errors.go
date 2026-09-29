package xcs

import "fmt"

type Error struct {
	Code string `json:"code"`
	Path string `json:"path,omitempty"`
	Msg  string `json:"message"`
}

func (e *Error) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Msg)
	}
	return fmt.Sprintf("%s at %s: %s", e.Code, e.Path, e.Msg)
}

func invalid(code, path, format string, args ...any) error {
	return &Error{Code: code, Path: path, Msg: fmt.Sprintf(format, args...)}
}
