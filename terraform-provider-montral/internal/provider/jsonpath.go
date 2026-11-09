package provider

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"
)

// jsonPathProblem mirrors parseJsonPath in apps/api/src/json-assertion.ts: optional $ (then . or [), a first bare
// key or bracket, then any of .key, [index] and ["quoted key"]; at most 32 segments and 200 characters.
var (
	jsonBareRE   = regexp.MustCompile(`^[A-Za-z0-9_$-]+`)
	jsonQuotedRE = regexp.MustCompile(`^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"`)
	jsonIndexRE  = regexp.MustCompile(`^(?:0|[1-9][0-9]{0,8})\]`)
)

// jsLength is a JavaScript string's length: UTF-16 code units.
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

func jsonPathProblem(path string) string {
	if jsLength(path) > 200 {
		return "JSON path is longer than 200 characters"
	}
	rest := path
	if strings.HasPrefix(rest, "$.") {
		rest = rest[2:]
	} else if strings.HasPrefix(rest, "$[") {
		rest = rest[1:]
	} else if rest == "$" {
		return "JSON path must name a key or index after $"
	}
	bad := func(why string) string {
		return fmt.Sprintf("invalid JSON path at character %d: %s", jsLength(path)-jsLength(rest)+1, why)
	}
	segments := 0
	first := true
	for rest != "" {
		if strings.HasPrefix(rest, "[") {
			rest = rest[1:]
			if q := jsonQuotedRE.FindString(rest); q != "" {
				rest = rest[len(q):]
				if !strings.HasPrefix(rest, "]") {
					return bad("expected ] after the quoted key")
				}
				rest = rest[1:]
			} else if i := jsonIndexRE.FindString(rest); i != "" {
				rest = rest[len(i):]
			} else {
				return bad(`use [0] for an index or ["key"] for a key`)
			}
		} else {
			if !first {
				if !strings.HasPrefix(rest, ".") {
					return bad("expected . or [")
				}
				rest = rest[1:]
			}
			key := jsonBareRE.FindString(rest)
			if key == "" {
				return bad(`a key needs letters, digits, _, - or $; quote others as ["key"]`)
			}
			rest = rest[len(key):]
		}
		first = false
		segments++
		if segments > 32 {
			return "JSON path is deeper than 32 segments"
		}
	}
	if segments == 0 {
		return "JSON path is empty"
	}
	return ""
}
