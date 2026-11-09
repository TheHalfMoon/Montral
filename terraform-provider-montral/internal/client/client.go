// Package client is a small REST client for the Montral management API (`/api/*`), authenticated with an API key.
//
// It retries 429 and 503 answers with exponential backoff (honouring Retry-After), never retries any other 4xx, and
// never writes the API key into an error, a log line or a retry message.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client talks to one Montral deployment.
type Client struct {
	baseURL    *url.URL
	apiKey     string
	projectID  string
	userAgent  string
	httpClient *http.Client

	// MaxRetries is how many times a 429/503 (or, for reads, a transport error) is retried. Default 5.
	MaxRetries int
	// MinBackoff and MaxBackoff bound the wait between retries when the server sends no Retry-After.
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// MaxRetryAfter caps a server-sent Retry-After, so one answer cannot stall a plan for minutes. Default 60s.
	MaxRetryAfter time.Duration
	// sleep is replaceable in tests.
	sleep func(ctx context.Context, d time.Duration) error
}

// Options configures New.
type Options struct {
	Endpoint   string
	APIKey     string
	ProjectID  string
	UserAgent  string
	HTTPClient *http.Client
	// AllowInsecureHTTP permits a plain http:// endpoint on a host other than localhost, 127.0.0.1 or ::1.
	AllowInsecureHTTP bool
}

// New validates the endpoint and returns a client. TLS certificates are verified by Go's default transport.
func New(o Options) (*Client, error) {
	if strings.TrimSpace(o.APIKey) == "" {
		return nil, errors.New("an API key is required (set api_key or MONTRAL_API_KEY)")
	}
	base, err := ParseEndpoint(o.Endpoint, o.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 60 * time.Second}
	}
	ua := o.UserAgent
	if ua == "" {
		ua = "terraform-provider-montral"
	}
	return &Client{
		baseURL:       base,
		apiKey:        o.APIKey,
		projectID:     o.ProjectID,
		userAgent:     ua,
		httpClient:    hc,
		MaxRetries:    5,
		MinBackoff:    500 * time.Millisecond,
		MaxBackoff:    20 * time.Second,
		MaxRetryAfter: 60 * time.Second,
		sleep:         sleepCtx,
	}, nil
}

// ParseEndpoint accepts an absolute http(s) base URL such as https://montral.example.com (a trailing /api is dropped).
// Plain http:// is refused, because the API key would cross the network in clear text, except for a loopback host
// (localhost, 127.0.0.1, ::1) or when allowInsecureHTTP is set.
func ParseEndpoint(raw string, allowInsecureHTTP bool) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("an endpoint is required (set endpoint or MONTRAL_ENDPOINT)")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("endpoint must be an absolute http(s) URL such as https://montral.example.com, got %q", raw)
	}
	if u.User != nil {
		return nil, errors.New("endpoint must not contain credentials; use api_key")
	}
	if u.Scheme == "http" && !allowInsecureHTTP && !isLoopback(u.Hostname()) {
		return nil, fmt.Errorf("endpoint %q uses plain http, which would send the API key unencrypted; use https, or set insecure_http = true to allow it", u.Scheme+"://"+u.Host)
	}
	u.RawQuery, u.Fragment = "", ""
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/api")
	return u, nil
}

// BaseURL is the deployment's base URL without a trailing slash.
func (c *Client) BaseURL() string { return strings.TrimRight(c.baseURL.String(), "/") }

// ProjectID is the provider-level default project ("" = the key's or workspace's default project).
func (c *Client) ProjectID() string { return c.projectID }

// APIError is a non-2xx answer. Code is Montral's machine-readable `code` when the answer has one.
type APIError struct {
	Method  string
	Path    string
	Status  int
	Code    string
	Message string
	// FromAPI is true when the body was Montral's JSON error ({"error": ...}); a plain-text 404 instead means the route
	// does not exist on this server (an older version).
	FromAPI bool
}

func (e *APIError) Error() string {
	code := ""
	if e.Code != "" {
		code = " [" + e.Code + "]"
	}
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	return fmt.Sprintf("Montral API %s %s returned HTTP %d%s: %s", e.Method, e.Path, e.Status, code, msg)
}

// IsRouteMissing reports a 404 that did not come from a Montral route (no JSON error body): the endpoint does not
// exist on this server version.
func IsRouteMissing(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound && !apiErr.FromAPI
}

// IsNotFound reports whether err is a 404 from the API.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// Request is one API call. Path is relative to /api (for example "/monitors").
type Request struct {
	Method    string
	Path      string
	ProjectID string // overrides the client's default project for this call
	Body      any
}

// Do sends the request and decodes a JSON answer into out (when out is non-nil and the answer has a body).
func (c *Client) Do(ctx context.Context, r Request, out any) error {
	var payload []byte
	if r.Body != nil {
		var err error
		if payload, err = json.Marshal(r.Body); err != nil {
			return fmt.Errorf("encoding request body: %w", err)
		}
	}
	project := r.ProjectID
	if project == "" {
		project = c.projectID
	}
	target := c.BaseURL() + "/api" + r.Path
	idempotent := r.Method == http.MethodGet || r.Method == http.MethodHead
	for attempt := 0; ; attempt++ {
		var body io.Reader
		if payload != nil {
			body = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(ctx, r.Method, target, body)
		if err != nil {
			return fmt.Errorf("building request %s %s: %w", r.Method, r.Path, err)
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent)
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if project != "" {
			req.Header.Set("X-Project-Id", project)
		}
		res, err := c.httpClient.Do(req)
		if err != nil {
			// a write may have reached the server; only reads are repeated after a transport failure
			if idempotent && attempt < c.MaxRetries && ctx.Err() == nil {
				if serr := c.sleep(ctx, c.backoff(attempt)); serr != nil {
					return serr
				}
				continue
			}
			return fmt.Errorf("Montral API %s %s: %w", r.Method, r.Path, redact(err, c.apiKey))
		}
		data, readErr := io.ReadAll(io.LimitReader(res.Body, 32<<20))
		res.Body.Close()
		if readErr != nil {
			return fmt.Errorf("Montral API %s %s: reading answer: %w", r.Method, r.Path, readErr)
		}
		if retryable(r.Method, res.StatusCode, data) && attempt < c.MaxRetries {
			wait, ok := retryAfter(res.Header.Get("Retry-After"), time.Now())
			if !ok {
				wait = c.backoff(attempt)
			} else if wait > c.MaxRetryAfter {
				wait = c.MaxRetryAfter
			}
			if serr := c.sleep(ctx, wait); serr != nil {
				return serr
			}
			continue
		}
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return parseError(r.Method, r.Path, res.StatusCode, data)
		}
		if out == nil || len(bytes.TrimSpace(data)) == 0 || res.StatusCode == http.StatusNoContent {
			return nil
		}
		// unknown fields are ignored: newer servers may add fields without breaking older providers
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("Montral API %s %s: decoding answer: %w", r.Method, r.Path, err)
		}
		return nil
	}
}

// Get, Post, Patch, Put and Delete are shorthands for Do.
func (c *Client) Get(ctx context.Context, path, project string, out any) error {
	return c.Do(ctx, Request{Method: http.MethodGet, Path: path, ProjectID: project}, out)
}
func (c *Client) Post(ctx context.Context, path, project string, body, out any) error {
	return c.Do(ctx, Request{Method: http.MethodPost, Path: path, ProjectID: project, Body: body}, out)
}
func (c *Client) Patch(ctx context.Context, path, project string, body, out any) error {
	return c.Do(ctx, Request{Method: http.MethodPatch, Path: path, ProjectID: project, Body: body}, out)
}
func (c *Client) Put(ctx context.Context, path, project string, body, out any) error {
	return c.Do(ctx, Request{Method: http.MethodPut, Path: path, ProjectID: project, Body: body}, out)
}
func (c *Client) Delete(ctx context.Context, path, project string) error {
	return c.Do(ctx, Request{Method: http.MethodDelete, Path: path, ProjectID: project}, nil)
}

// isLoopback is true for localhost, 127.0.0.1 and ::1: plain http there never leaves the machine.
func isLoopback(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}

// rolledBackMessage is the body of Montral's own 503 (handleApiError in apps/api/src/app.ts): PostgreSQL rolled the
// whole transaction back (deadlock or serialization failure), so nothing was written.
const rolledBackMessage = "Temporarily unavailable, please retry"

// retryable decides whether an answer is retried. 429 means the request was refused before any work, for every method.
// A 503 is retried for every method except POST: a POST creates something, and a 503 from a proxy or load balancer
// says nothing about whether the server already did. POST is retried on 503 only when the answer is Montral's own
// rolled-back error.
func retryable(method string, status int, body []byte) bool {
	switch status {
	case http.StatusTooManyRequests:
		return true
	case http.StatusServiceUnavailable:
		if method != http.MethodPost {
			return true
		}
		var e struct {
			Error string `json:"error"`
		}
		return json.Unmarshal(body, &e) == nil && e.Error == rolledBackMessage
	}
	return false
}

func (c *Client) backoff(attempt int) time.Duration {
	d := c.MinBackoff << attempt
	if d <= 0 || d > c.MaxBackoff {
		d = c.MaxBackoff
	}
	// up to 25% jitter, so parallel applies do not retry in lockstep
	return d - time.Duration(rand.Int64N(int64(d)/4+1))
}

// retryAfter parses a Retry-After header: delay-seconds or an HTTP date.
func retryAfter(v string, now time.Time) (time.Duration, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0, false
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0, false
		}
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(v); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// parseError reads Montral's error shapes: {"error": "text", "code": "..."} from route handlers, and
// {"success": false, "error": {...ZodError...}} from request validation.
func parseError(method, path string, status int, data []byte) error {
	e := &APIError{Method: method, Path: path, Status: status}
	var body struct {
		Error json.RawMessage `json:"error"`
		Code  string          `json:"code"`
	}
	if json.Unmarshal(data, &body) != nil {
		e.Message = strings.TrimSpace(truncate(string(data), 300))
		return e
	}
	e.Code = body.Code
	e.FromAPI = len(body.Error) > 0
	var text string
	if json.Unmarshal(body.Error, &text) == nil {
		e.Message = text
		return e
	}
	var zod struct {
		Name    string  `json:"name"`
		Message string  `json:"message"`
		Issues  []issue `json:"issues"`
	}
	if json.Unmarshal(body.Error, &zod) == nil {
		issues := zod.Issues
		if len(issues) == 0 && zod.Message != "" {
			// zod 4 serialises its issues as a JSON string in `message`
			if json.Unmarshal([]byte(zod.Message), &issues) != nil {
				e.Message = truncate(zod.Message, 300)
			}
		}
		if len(issues) > 0 {
			parts := make([]string, 0, len(issues))
			for _, i := range issues {
				parts = append(parts, i.String())
			}
			e.Message = "invalid request: " + strings.Join(parts, "; ")
			if e.Code == "" {
				e.Code = "validation_failed"
			}
		}
	}
	return e
}

type issue struct {
	Path    []any  `json:"path"`
	Message string `json:"message"`
}

func (i issue) String() string {
	if len(i.Path) == 0 {
		return i.Message
	}
	parts := make([]string, len(i.Path))
	for n, p := range i.Path {
		parts[n] = fmt.Sprint(p)
	}
	return strings.Join(parts, ".") + ": " + i.Message
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// redact removes the API key from an error message, should a transport ever echo a header.
func redact(err error, secret string) error {
	if secret == "" || !strings.Contains(err.Error(), secret) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), secret, "[REDACTED]"))
}
