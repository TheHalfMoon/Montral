package provider

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Montral's monitor rules (apps/api/src/routes/monitors.ts, http-request.ts, json-assertion.ts, netguard.ts) that
// can be judged without the server, so a bad configuration fails at `terraform plan` instead of mid-apply.

var (
	monitorTypes   = []string{"http", "tcp", "dns", "heartbeat", "postgres", "mysql", "redis", "websocket", "domain", "certificate", "ping"}
	httpMethods    = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
	probeTypes     = map[string]bool{"http": true, "tcp": true, "websocket": true}
	expiryTypes    = map[string]bool{"domain": true, "certificate": true}
	regionRE       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,23}$`)
	tagRE          = regexp.MustCompile(`^\S(.{0,30}\S)?$`)
	schemeRE       = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)
	hostLabelRE    = regexp.MustCompile(`^(?i)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$`)
	locationRE     = regexp.MustCompile(`^(/|(?i)https?://\S+$)`)
	maxRequestBody = 16 * 1024
)

// monitorSpec is the part of a monitor configuration the cross-field rules look at. A nil pointer is a value that is
// null or not known yet (rules that need it are skipped until it is known).
type monitorSpec struct {
	Type             *string
	Target           *string
	Method           *string
	RequestBody      *string
	JSONPath         *string
	JSONExpected     *string
	JSONMatch        *string
	Regions          []string // nil: unknown
	IntervalSec      *int64
	DNSConfigured    bool // dns_record_type, dns_expected_value or dns_match_mode set in configuration
	TargetUnknown    bool
	RegionsUnknown   bool
	JSONPathUnknown  bool
	JSONExpUnknown   bool
	RequestBodyKnown bool
}

// problem is one invalid setting: the attribute it belongs to and why.
type problem struct {
	Attribute string
	Message   string
}

func (s monitorSpec) problems() []problem {
	var out []problem
	add := func(a, m string) { out = append(out, problem{a, m}) }
	if s.Type == nil {
		return nil
	}
	t := *s.Type
	method := "GET"
	if s.Method != nil {
		method = *s.Method
	}

	// target
	if !s.TargetUnknown {
		target := ""
		if s.Target != nil {
			target = *s.Target
		}
		if t == "heartbeat" {
			if target != "" {
				add("target", "heartbeat monitors have no target; leave it unset (Montral gives them a ping URL instead)")
			}
		} else if strings.TrimSpace(target) == "" {
			add("target", fmt.Sprintf("a %s monitor needs a target", t))
		} else if msg := targetProblem(t, target); msg != "" {
			add("target", msg)
		}
	}

	// request body (requestBodyProblem)
	if s.RequestBody != nil && *s.RequestBody != "" {
		switch {
		case t != "http":
			add("request_body", "request bodies are supported for HTTP monitors only")
		case method == "GET" || method == "HEAD":
			add("request_body", "GET and HEAD cannot send a request body; choose another method")
		case len(*s.RequestBody) > maxRequestBody:
			add("request_body", "request body exceeds 16384 UTF-8 bytes")
		}
	}

	// JSON assertion (jsonAssertionProblem)
	hasPath := s.JSONPath != nil && *s.JSONPath != ""
	if t != "http" {
		if hasPath || s.JSONExpected != nil {
			add("json_path", "JSON assertions are supported for HTTP monitors only")
		}
	} else {
		if hasPath && method == "HEAD" {
			add("json_path", "a JSON assertion needs a response body; HEAD requests have none")
		}
		if hasPath {
			if msg := jsonPathProblem(*s.JSONPath); msg != "" {
				add("json_path", msg)
			}
		}
		match := "equals"
		if s.JSONMatch != nil {
			match = *s.JSONMatch
		}
		if hasPath && match != "exists" && s.JSONExpected == nil && !s.JSONExpUnknown {
			add("json_expected", "json_expected is required when json_match is equals or contains")
		}
	}

	// DNS settings are reset to their defaults by the API for any other type
	if t != "dns" && s.DNSConfigured {
		add("dns_record_type", "dns_record_type, dns_expected_value and dns_match_mode apply to dns monitors only")
	}

	// regions (regionProblem): explicit regions only for the types a remote probe can run
	if !s.RegionsUnknown && s.Regions != nil && !probeTypes[t] {
		for _, r := range s.Regions {
			if r != "auto" {
				add("regions", "regions other than auto are available for http, tcp and websocket monitors only")
				break
			}
		}
	}

	// domain and certificate checks are bounded to 1 hour .. 1 day (the API would silently adjust the value)
	if expiryTypes[t] && s.IntervalSec != nil && (*s.IntervalSec < 3600 || *s.IntervalSec > 86400) {
		add("interval_sec", fmt.Sprintf("%s monitors check every 3600 to 86400 seconds", t))
	}
	return out
}

// targetProblem checks the target's shape for its type (the server additionally refuses private addresses unless
// the deployment sets ALLOW_PRIVATE_TARGETS=true, which can only be known by asking it).
func targetProblem(t, target string) string {
	switch t {
	case "http":
		if u, err := url.Parse(target); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return "an http monitor target must be an absolute http:// or https:// URL"
		}
	case "websocket":
		if u, err := url.Parse(target); err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
			return "a websocket monitor target must be a ws:// or wss:// URL"
		}
	case "tcp":
		if !looseHostPort(target, 0) {
			return "a tcp monitor target must be host:port"
		}
	case "certificate":
		if !hostPort(target, true) {
			return "a certificate monitor target must be host or host:port"
		}
	case "ping", "dns":
		if schemeRE.MatchString(target) || strings.ContainsAny(target, "/?#") || (!validHost(target)) {
			return fmt.Sprintf("a %s monitor target must be a hostname%s, without scheme, port or path", t, map[bool]string{true: " or IP address", false: ""}[t == "ping"])
		}
	case "domain":
		if schemeRE.MatchString(target) || strings.ContainsAny(target, "/?#:") || !strings.Contains(target, ".") {
			return "a domain monitor target must be a registered domain such as example.com, without scheme or path"
		}
	case "postgres", "mysql", "redis":
		if !looseHostPort(target, 1) {
			return fmt.Sprintf("a %s monitor target must be host or host:port (a scheme such as %s:// is allowed, a path or credentials are not)", t, t)
		}
	}
	return ""
}

// looseHostPort mirrors hostPort in apps/api/src/netguard.ts: an optional scheme, then host or [ipv6], then :port
// (required when defaultPort is 0).
var (
	looseHostPortRE = regexp.MustCompile(`^(\[[^\]]+\]|[^:/?#@\s]+)(?::(\d+))?$`)
	schemePrefixRE  = regexp.MustCompile(`^(?i)[a-z]+://`)
)

func looseHostPort(target string, defaultPort int) bool {
	t := schemePrefixRE.ReplaceAllString(strings.TrimSpace(target), "")
	m := looseHostPortRE.FindStringSubmatch(t)
	if m == nil {
		return false
	}
	port := defaultPort
	if m[2] != "" {
		port, _ = strconv.Atoi(m[2])
	}
	return port > 0 && port < 65536
}

func hostPort(target string, portOptional bool) bool {
	if schemeRE.MatchString(target) || strings.ContainsAny(target, "/?#") {
		return false
	}
	host, port, err := net.SplitHostPort(target)
	if err != nil {
		return portOptional && validHost(target)
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535 && validHost(host)
}

func validHost(h string) bool {
	h = strings.TrimSuffix(strings.Trim(h, "[]"), ".")
	if h == "" || len(h) > 253 {
		return false
	}
	if net.ParseIP(h) != nil {
		return true
	}
	for _, label := range strings.Split(h, ".") {
		if !hostLabelRE.MatchString(label) {
			return false
		}
	}
	return true
}
