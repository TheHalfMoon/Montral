package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testKey = "montral_test_key_never_real_0123456789"

func newTestClient(t *testing.T, h http.HandlerFunc) (*Client, *[]time.Duration) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(Options{Endpoint: srv.URL, APIKey: testKey, ProjectID: "11111111-1111-1111-1111-111111111111"})
	if err != nil {
		t.Fatal(err)
	}
	waits := &[]time.Duration{}
	c.sleep = func(_ context.Context, d time.Duration) error { *waits = append(*waits, d); return nil }
	return c, waits
}

func TestParseEndpoint(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:8787":            "http://localhost:8787",
		"http://[::1]:8787/":               "http://[::1]:8787",
		"https://montral.example.com":      "https://montral.example.com",
		"https://montral.example.com/":     "https://montral.example.com",
		"https://montral.example.com/api":  "https://montral.example.com",
		"https://montral.example.com/api/": "https://montral.example.com",
		"http://127.0.0.1:8787":            "http://127.0.0.1:8787",
		"https://example.com/montral/api":  "https://example.com/montral",
		" https://example.com/x?y=1#frag ": "https://example.com/x",
	} {
		u, err := ParseEndpoint(in, false)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got := strings.TrimRight(u.String(), "/"); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "montral.example.com", "ftp://example.com", "https://user:pass@example.com", "/api"} {
		if _, err := ParseEndpoint(bad, false); err == nil {
			t.Errorf("%q: expected an error", bad)
		}
	}
}

func TestNewRequiresKey(t *testing.T) {
	if _, err := New(Options{Endpoint: "https://example.com"}); err == nil {
		t.Fatal("expected an error without an API key")
	}
}

func TestHeadersAndDecoding(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			t.Errorf("authorization header: %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/api/monitors/abc" {
			t.Errorf("path: %q", r.URL.Path)
		}
		if got := r.Header.Get("X-Project-Id"); got != "22222222-2222-2222-2222-222222222222" {
			t.Errorf("project header: %q", got)
		}
		if r.Method == http.MethodPatch {
			if r.Header.Get("Content-Type") != "application/json" {
				t.Errorf("content type: %q", r.Header.Get("Content-Type"))
			}
			body, _ := io.ReadAll(r.Body)
			if string(body) != `{"name":"x"}` {
				t.Errorf("body: %s", body)
			}
		}
		// unknown fields must not break decoding
		_, _ = w.Write([]byte(`{"id":"abc","name":"n","brandNewField":{"nested":true},"regions":["auto"]}`))
	})
	var m Monitor
	if err := c.Get(context.Background(), "/monitors/abc", "22222222-2222-2222-2222-222222222222", &m); err != nil {
		t.Fatal(err)
	}
	if m.ID != "abc" || m.Name != "n" || len(m.Regions) != 1 {
		t.Fatalf("decoded %+v", m)
	}
	if err := c.Patch(context.Background(), "/monitors/abc", "22222222-2222-2222-2222-222222222222", map[string]string{"name": "x"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDefaultProjectHeader(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-Project-Id"); got != "11111111-1111-1111-1111-111111111111" {
			t.Errorf("default project header: %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.Delete(context.Background(), "/monitors/abc", ""); err != nil {
		t.Fatal(err)
	}
}

func TestRetriesTooManyRequestsWithRetryAfter(t *testing.T) {
	var calls atomic.Int32
	c, waits := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"Too many attempts","code":"rate_limited"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"ok"}`))
	})
	var m Monitor
	if err := c.Post(context.Background(), "/monitors", "", map[string]string{}, &m); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || m.ID != "ok" {
		t.Fatalf("calls=%d id=%q", calls.Load(), m.ID)
	}
	if len(*waits) != 2 || (*waits)[0] != 2*time.Second {
		t.Fatalf("waits %v, want two waits of 2s", *waits)
	}
}

func TestRetriesServiceUnavailableWithBackoff(t *testing.T) {
	var calls atomic.Int32
	c, waits := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 4 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.Delete(context.Background(), "/monitors/x", ""); err != nil {
		t.Fatal(err)
	}
	if len(*waits) != 3 {
		t.Fatalf("waits %v", *waits)
	}
	for i := 1; i < len(*waits); i++ {
		if (*waits)[i] < (*waits)[i-1] {
			t.Errorf("backoff did not grow: %v", *waits)
		}
	}
}

func TestRetryAfterIsCapped(t *testing.T) {
	var calls atomic.Int32
	c, waits := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "86400")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := c.Delete(context.Background(), "/x", ""); err != nil {
		t.Fatal(err)
	}
	if (*waits)[0] != c.MaxRetryAfter {
		t.Fatalf("wait %v, want cap %v", (*waits)[0], c.MaxRetryAfter)
	}
}

func TestGivesUpAfterMaxRetries(t *testing.T) {
	var calls atomic.Int32
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"Temporarily unavailable, please retry"}`))
	})
	err := c.Get(context.Background(), "/monitors", "", nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 503 {
		t.Fatalf("err %v", err)
	}
	if calls.Load() != int32(c.MaxRetries+1) {
		t.Fatalf("calls %d", calls.Load())
	}
}

func TestNoRetryOnClientErrors(t *testing.T) {
	for _, status := range []int{400, 401, 402, 403, 404, 409, 413} {
		var calls atomic.Int32
		c, waits := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"nope","code":"some_code"}`))
		})
		err := c.Post(context.Background(), "/monitors", "", map[string]int{}, nil)
		if err == nil || calls.Load() != 1 || len(*waits) != 0 {
			t.Errorf("status %d: err=%v calls=%d waits=%v", status, err, calls.Load(), *waits)
		}
	}
}

func TestErrorShapes(t *testing.T) {
	zod4Issues, _ := json.Marshal([]map[string]any{{"path": []any{"intervalSec"}, "message": "Too small: expected number to be >=60"}})
	for name, tc := range map[string]struct {
		status   int
		body     string
		contains []string
		code     string
	}{
		"route error with code": {400, `{"error":"Target is a private or internal address.","code":"target_not_allowed"}`,
			[]string{"HTTP 400", "[target_not_allowed]", "Target is a private", "POST /monitors"}, "target_not_allowed"},
		"plain route error": {404, `{"error":"Not found"}`, []string{"HTTP 404", "Not found"}, ""},
		"zod issues": {400, `{"success":false,"error":{"name":"ZodError","issues":[{"path":["regions",0],"message":"Invalid"}]}}`,
			[]string{"[validation_failed]", "regions.0: Invalid"}, "validation_failed"},
		"zod 4 message": {400, `{"success":false,"error":{"name":"ZodError","message":` + string(mustJSON(string(zod4Issues))) + `}}`,
			[]string{"intervalSec: Too small"}, "validation_failed"},
		"non-json": {502, `<html>Bad gateway</html>`, []string{"HTTP 502", "Bad gateway"}, ""},
		"empty":    {500, ``, []string{"HTTP 500", "Internal Server Error"}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			err := parseError("POST", "/monitors", tc.status, []byte(tc.body))
			for _, s := range tc.contains {
				if !strings.Contains(err.Error(), s) {
					t.Errorf("%q does not contain %q", err.Error(), s)
				}
			}
			if err.(*APIError).Code != tc.code {
				t.Errorf("code %q, want %q", err.(*APIError).Code, tc.code)
			}
		})
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestIsNotFound(t *testing.T) {
	if !IsNotFound(&APIError{Status: 404}) || IsNotFound(&APIError{Status: 400}) || IsNotFound(errors.New("x")) {
		t.Fatal("IsNotFound misclassifies")
	}
}

func TestRetryAfterParsing(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	if d, ok := retryAfter("5", now); !ok || d != 5*time.Second {
		t.Errorf("seconds: %v %v", d, ok)
	}
	if d, ok := retryAfter(now.Add(30*time.Second).Format(http.TimeFormat), now); !ok || d != 30*time.Second {
		t.Errorf("date: %v %v", d, ok)
	}
	if d, ok := retryAfter(now.Add(-time.Minute).Format(http.TimeFormat), now); !ok || d != 0 {
		t.Errorf("past date: %v %v", d, ok)
	}
	for _, bad := range []string{"", "soon", "-3"} {
		if _, ok := retryAfter(bad, now); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestTransportErrorsRetriedForReadsOnly(t *testing.T) {
	c, err := New(Options{Endpoint: "http://127.0.0.1:1", APIKey: testKey})
	if err != nil {
		t.Fatal(err)
	}
	var waits int
	c.sleep = func(context.Context, time.Duration) error { waits++; return nil }
	if err := c.Get(context.Background(), "/monitors", "", nil); err == nil || waits != c.MaxRetries {
		t.Errorf("GET: err=%v waits=%d", err, waits)
	}
	waits = 0
	if err := c.Post(context.Background(), "/monitors", "", map[string]int{}, nil); err == nil || waits != 0 {
		t.Errorf("POST: err=%v waits=%d", err, waits)
	}
}

func TestAPIKeyNeverInErrors(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad"}`))
	})
	err := c.Get(context.Background(), "/monitors", "", nil)
	if err == nil || strings.Contains(err.Error(), testKey) {
		t.Fatalf("err %v", err)
	}
	if got := redact(errors.New("dial failed for Bearer "+testKey), testKey).Error(); strings.Contains(got, testKey) || !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("redact: %q", got)
	}
}

func TestContextCancelStopsRetries(t *testing.T) {
	c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	ctx, cancel := context.WithCancel(context.Background())
	c.sleep = func(ctx context.Context, d time.Duration) error { cancel(); return ctx.Err() }
	if err := c.Get(ctx, "/monitors", "", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
}

func TestPlainHTTPOnlyForLoopbackOrWhenAllowed(t *testing.T) {
	for _, remote := range []string{"http://montral.example.com", "http://10.0.0.5:8787", "http://127.0.0.2", "http://localhost.example.com"} {
		_, err := ParseEndpoint(remote, false)
		if err == nil || !strings.Contains(err.Error(), "insecure_http") {
			t.Errorf("%s: want a refusal naming insecure_http, got %v", remote, err)
		}
		if _, err := ParseEndpoint(remote, true); err != nil {
			t.Errorf("%s with insecure_http: %v", remote, err)
		}
		if _, err := New(Options{Endpoint: remote, APIKey: testKey}); err == nil {
			t.Errorf("New(%s) accepted plain http", remote)
		}
		if _, err := New(Options{Endpoint: remote, APIKey: testKey, AllowInsecureHTTP: true}); err != nil {
			t.Errorf("New(%s, AllowInsecureHTTP): %v", remote, err)
		}
	}
	for _, local := range []string{"http://localhost", "http://LOCALHOST:1", "http://127.0.0.1:8787", "http://[::1]", "https://montral.example.com"} {
		if _, err := ParseEndpoint(local, false); err != nil {
			t.Errorf("%s: %v", local, err)
		}
	}
}

func TestPostRetriedOnlyWhenNothingWasDone(t *testing.T) {
	cases := []struct {
		name      string
		method    string
		status    int
		body      string
		wantCalls int32
	}{
		{"POST 429 is retried", http.MethodPost, 429, `{"error":"Too many attempts, try again later"}`, 2},
		{"POST 503 from a proxy is not retried", http.MethodPost, 503, `<html>Service Unavailable</html>`, 1},
		{"POST 503 with another JSON error is not retried", http.MethodPost, 503, `{"error":"maintenance"}`, 1},
		{"POST 503 rolled back by Montral is retried", http.MethodPost, 503, `{"error":"Temporarily unavailable, please retry"}`, 2},
		{"PATCH 503 from a proxy is retried", http.MethodPatch, 503, ``, 2},
		{"PUT 503 is retried", http.MethodPut, 503, ``, 2},
		{"DELETE 503 is retried", http.MethodDelete, 503, ``, 2},
		{"GET 503 is retried", http.MethodGet, 503, ``, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			c, _ := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) == 1 {
					w.WriteHeader(tc.status)
					_, _ = w.Write([]byte(tc.body))
					return
				}
				_, _ = w.Write([]byte(`{}`))
			})
			var body any
			if tc.method != http.MethodGet && tc.method != http.MethodDelete {
				body = map[string]string{"name": "x"}
			}
			_ = c.Do(context.Background(), Request{Method: tc.method, Path: "/monitors", Body: body}, nil)
			if calls.Load() != tc.wantCalls {
				t.Errorf("calls %d, want %d", calls.Load(), tc.wantCalls)
			}
		})
	}
}

func TestRouteMissingVersusNotFound(t *testing.T) {
	if !IsRouteMissing(parseError("GET", "/maintenance/x", 404, []byte("404 Not Found"))) {
		t.Error("plain-text 404 should be a missing route")
	}
	jsonNotFound := parseError("GET", "/maintenance/x", 404, []byte(`{"error":"Not found"}`))
	if IsRouteMissing(jsonNotFound) || !IsNotFound(jsonNotFound) {
		t.Error("Montral's JSON 404 is a missing object, not a missing route")
	}
}
