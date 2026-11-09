package provider

import (
	"context"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

// The framework validates every schema (defaults only on computed attributes, valid plan modifiers...) when Terraform
// asks for them; this catches a broken schema without Terraform or a server.
func TestProviderSchemasAreValid(t *testing.T) {
	server, err := providerserver.NewProtocol6WithError(New("test")())()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := server.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range resp.Diagnostics {
		t.Errorf("schema diagnostic: %s: %s", d.Summary, d.Detail)
	}
	for _, name := range []string{"montral_monitor", "montral_alert_channel", "montral_status_page", "montral_maintenance_window", "montral_project_alerting"} {
		if _, ok := resp.ResourceSchemas[name]; !ok {
			t.Errorf("resource %s missing", name)
		}
	}
	for _, name := range []string{"montral_monitor", "montral_project"} {
		if _, ok := resp.DataSourceSchemas[name]; !ok {
			t.Errorf("data source %s missing", name)
		}
	}
	// secrets must be marked sensitive
	sensitive := map[string][]string{
		"montral_alert_channel": {"secret_config"},
		"montral_status_page":   {"password"},
		"montral_monitor":       {"headers", "request_body", "heartbeat_token", "heartbeat_url"},
	}
	for res, attrs := range sensitive {
		for _, a := range attrs {
			found := false
			for _, at := range resp.ResourceSchemas[res].Block.Attributes {
				if at.Name == a {
					found = true
					if !at.Sensitive {
						t.Errorf("%s.%s is not sensitive", res, a)
					}
				}
			}
			if !found {
				t.Errorf("%s.%s missing", res, a)
			}
		}
	}
	for _, at := range resp.Provider.Block.Attributes {
		if at.Name == "api_key" && !at.Sensitive {
			t.Error("provider api_key is not sensitive")
		}
	}
}

func str(s string) *string { return &s }
func i64(n int64) *int64   { return &n }

func TestMonitorProblems(t *testing.T) {
	cases := []struct {
		name string
		spec monitorSpec
		want []string // attribute names, in order
	}{
		{"valid http", monitorSpec{Type: str("http"), Target: str("https://example.com/health")}, nil},
		{"http needs URL", monitorSpec{Type: str("http"), Target: str("example.com")}, []string{"target"}},
		{"missing target", monitorSpec{Type: str("tcp")}, []string{"target"}},
		{"unknown target skipped", monitorSpec{Type: str("tcp"), TargetUnknown: true}, nil},
		{"heartbeat has no target", monitorSpec{Type: str("heartbeat"), Target: str("x")}, []string{"target"}},
		{"heartbeat empty target", monitorSpec{Type: str("heartbeat"), Target: str("")}, nil},
		{"tcp host:port", monitorSpec{Type: str("tcp"), Target: str("db.example.com:5432")}, nil},
		{"tcp ipv6", monitorSpec{Type: str("tcp"), Target: str("[2001:db8::1]:443")}, nil},
		{"tcp missing port", monitorSpec{Type: str("tcp"), Target: str("db.example.com")}, []string{"target"}},
		{"certificate host", monitorSpec{Type: str("certificate"), Target: str("example.com"), IntervalSec: i64(3600)}, nil},
		{"certificate url", monitorSpec{Type: str("certificate"), Target: str("https://example.com"), IntervalSec: i64(3600)}, []string{"target"}},
		{"ping ip", monitorSpec{Type: str("ping"), Target: str("192.0.2.1")}, nil},
		{"ping with port", monitorSpec{Type: str("ping"), Target: str("example.com:80")}, []string{"target"}},
		{"dns", monitorSpec{Type: str("dns"), Target: str("example.com"), DNSConfigured: true}, nil},
		{"websocket", monitorSpec{Type: str("websocket"), Target: str("wss://example.com/ws")}, nil},
		{"websocket http url", monitorSpec{Type: str("websocket"), Target: str("https://example.com/ws")}, []string{"target"}},
		{"postgres", monitorSpec{Type: str("postgres"), Target: str("postgres://db.example.com:5433")}, nil},
		{"postgres host", monitorSpec{Type: str("postgres"), Target: str("db.example.com")}, nil},
		{"postgres path", monitorSpec{Type: str("postgres"), Target: str("postgres://u@db.example.com/x")}, []string{"target"}},
		{"redis port range", monitorSpec{Type: str("redis"), Target: str("cache:70000")}, []string{"target"}},
		{"domain", monitorSpec{Type: str("domain"), Target: str("example.com"), IntervalSec: i64(86400)}, nil},
		{"domain interval too short", monitorSpec{Type: str("domain"), Target: str("example.com"), IntervalSec: i64(60)}, []string{"interval_sec"}},
		{"body with GET", monitorSpec{Type: str("http"), Target: str("https://e.com"), RequestBody: str("{}")}, []string{"request_body"}},
		{"body with POST", monitorSpec{Type: str("http"), Target: str("https://e.com"), Method: str("POST"), RequestBody: str("{}")}, nil},
		{"body on tcp", monitorSpec{Type: str("tcp"), Target: str("e.com:1"), RequestBody: str("x")}, []string{"request_body"}},
		{"body too large", monitorSpec{Type: str("http"), Target: str("https://e.com"), Method: str("POST"), RequestBody: str(strings.Repeat("x", 16385))}, []string{"request_body"}},
		{"json needs expected", monitorSpec{Type: str("http"), Target: str("https://e.com"), JSONPath: str("$.status")}, []string{"json_expected"}},
		{"json exists", monitorSpec{Type: str("http"), Target: str("https://e.com"), JSONPath: str("$.status"), JSONMatch: str("exists")}, nil},
		{"json equals", monitorSpec{Type: str("http"), Target: str("https://e.com"), JSONPath: str("data.items[0].state"), JSONExpected: str("ok")}, nil},
		{"json HEAD", monitorSpec{Type: str("http"), Target: str("https://e.com"), Method: str("HEAD"), JSONPath: str("a"), JSONExpected: str("b")}, []string{"json_path"}},
		{"json bad path", monitorSpec{Type: str("http"), Target: str("https://e.com"), JSONPath: str("a..b"), JSONExpected: str("b")}, []string{"json_path"}},
		{"json on tcp", monitorSpec{Type: str("tcp"), Target: str("e.com:1"), JSONExpected: str("x")}, []string{"json_path"}},
		{"dns settings on http", monitorSpec{Type: str("http"), Target: str("https://e.com"), DNSConfigured: true}, []string{"dns_record_type"}},
		{"regions on dns", monitorSpec{Type: str("dns"), Target: str("example.com"), Regions: []string{"eu-west"}}, []string{"regions"}},
		{"auto region on dns", monitorSpec{Type: str("dns"), Target: str("example.com"), Regions: []string{"auto"}}, nil},
		{"regions on http", monitorSpec{Type: str("http"), Target: str("https://e.com"), Regions: []string{"auto", "eu-west"}}, nil},
		{"unknown type skipped", monitorSpec{}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.spec.problems()
			var attrs []string
			for _, p := range got {
				attrs = append(attrs, p.Attribute)
			}
			if strings.Join(attrs, ",") != strings.Join(tc.want, ",") {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestJSONPathProblem(t *testing.T) {
	for _, ok := range []string{"status", "$.data.items[0].state", `["key with space"].ok`, "$[0]", "a-b_c$", "$key", `$["x\"y"]`, "a[10]"} {
		if p := jsonPathProblem(ok); p != "" {
			t.Errorf("%q: unexpected problem %q", ok, p)
		}
	}
	for _, bad := range []string{"$", "a..b", "a.", "[-1]", "[*]", "['x']", "a[0", "[01]", "a b", strings.Repeat("a.", 33) + "a", strings.Repeat("x", 201)} {
		if p := jsonPathProblem(bad); p == "" {
			t.Errorf("%q: expected a problem", bad)
		}
	}
}

func TestChannelProblems(t *testing.T) {
	m := func(kv ...string) map[string]string {
		out := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			out[kv[i]] = kv[i+1]
		}
		return out
	}
	cases := []struct {
		name          string
		typ           string
		plain, secret map[string]string
		wantN         int
	}{
		{"webhook ok", "webhook", m(), m("url", "https://hooks.example.com/x"), 0},
		{"webhook url in plain config", "webhook", m("url", "https://hooks.example.com/x"), m(), 1}, // misplaced
		{"webhook bad url", "webhook", m(), m("url", "ftp://x"), 1},
		{"email ok", "email", m("to", "ops@example.com"), m(), 0},
		{"email bad", "email", m("to", "nope"), m(), 1},
		{"email unknown key", "email", m("to", "ops@example.com", "cc", "x@example.com"), m(), 1},
		{"telegram ok", "telegram", m("chatId", "-100123"), m("botToken", "123:abc"), 0},
		{"telegram chatId secret", "telegram", m(), m("botToken", "123:abc", "chatId", "1"), 1},
		{"ntfy ok", "ntfy", m("priority", "4"), m("url", "https://ntfy.sh", "topic", "alerts", "token", "tk_1"), 0},
		{"ntfy topic path", "ntfy", m(), m("url", "https://ntfy.sh/alerts", "topic", "alerts"), 1},
		{"ntfy token over http", "ntfy", m(), m("url", "http://ntfy.local", "topic", "alerts", "token", "x"), 1},
		{"ntfy bad priority", "ntfy", m("priority", "9"), m("url", "https://ntfy.sh", "topic", "a"), 1},
		{"pushover ok", "pushover", m("device", "phone,tablet"), m("token", strings.Repeat("a", 30), "userKey", strings.Repeat("b", 30)), 0},
		{"pushover short", "pushover", m(), m("token", "a", "userKey", strings.Repeat("b", 30)), 1},
		{"gotify http", "gotify", m(), m("url", "http://gotify.example.com", "token", "t"), 1},
		{"googlechat wrong host", "googlechat", m(), m("url", "https://example.com/v1/spaces/x/messages?key=a&token=b"), 1},
		{"mattermost ok", "mattermost", m(), m("url", "https://mm.example.com/hooks/abc123"), 0},
		{"empty value", "pagerduty", m(), m("routingKey", ""), 1},
		{"surrounding spaces", "pagerduty", m(), m("routingKey", " k "), 1},
		{"push", "push", m(), m(), 0},
		{"unknown maps skip required", "webhook", nil, nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := channelProblems(tc.typ, tc.plain, tc.secret)
			if len(got) != tc.wantN {
				t.Errorf("got %d problems %v, want %d", len(got), got, tc.wantN)
			}
		})
	}
}

func TestSplitChannelConfig(t *testing.T) {
	api := map[string]any{"url": "https://ntfy.sh", "topic": client.Mask, "priority": "3", "token": "https://ntfy.sh/" + client.Mask}
	plain, secret := splitChannelConfig("ntfy", api, map[string]string{}, map[string]string{"topic": "alerts", "token": "tk"})
	if len(plain) != 0 {
		t.Errorf("default priority leaked into config: %v", plain)
	}
	if secret["url"] != "https://ntfy.sh" || secret["topic"] != "alerts" || secret["token"] != "tk" {
		t.Errorf("secrets %v", secret)
	}
	plain, _ = splitChannelConfig("ntfy", api, map[string]string{"priority": "3"}, nil)
	if plain["priority"] != "3" {
		t.Errorf("configured default dropped: %v", plain)
	}
	// a masked secret with nothing in state stays out of state (import by a non-manager key)
	_, secret = splitChannelConfig("slack", map[string]any{"url": "https://hooks.slack.com/" + client.Mask}, nil, nil)
	if _, ok := secret["url"]; ok {
		t.Errorf("masked value stored: %v", secret)
	}
	plain, _ = splitChannelConfig("email", map[string]any{"to": "a@example.com", "ignored": nil}, nil, nil)
	if plain["to"] != "a@example.com" || len(plain) != 1 {
		t.Errorf("email: %v", plain)
	}
}

func TestMaintenanceProblems(t *testing.T) {
	rec := func(tz, until string) *recurrenceModel {
		return &recurrenceModel{Frequency: types.StringValue("daily"), TimeZone: types.StringValue(tz), Until: types.StringValue(until)}
	}
	cases := []struct {
		name         string
		start, end   string
		r            *recurrenceModel
		wantProblems int
	}{
		{"ok", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", nil, 0},
		{"offsets", "2030-01-01T02:00:00+01:00", "2030-01-01T02:30:00+01:00", nil, 0},
		{"end before start", "2030-01-01T04:00:00Z", "2030-01-01T02:00:00Z", nil, 1},
		{"no offset", "2030-01-01T02:00:00", "2030-01-01T04:00:00Z", nil, 1},
		{"unknown skipped", "", "", nil, 0},
		{"recurring ok", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", rec("America/Toronto", "2030-03-01T02:00:00Z"), 0},
		{"recurring too long", "2030-01-01T02:00:00Z", "2030-01-02T04:00:00Z", rec("UTC", "2030-03-01T02:00:00Z"), 1},
		{"recurring bad zone", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", rec("Mars/Olympus", "2030-03-01T02:00:00Z"), 1},
		{"recurring abbreviation", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", rec("EST", "2030-03-01T02:00:00Z"), 1},
		{"until too far", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", rec("UTC", "2031-06-01T02:00:00Z"), 1},
		{"until before start", "2030-01-01T02:00:00Z", "2030-01-01T04:00:00Z", rec("UTC", "2029-06-01T02:00:00Z"), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := maintenanceProblems(tc.start, tc.end, tc.r); len(got) != tc.wantProblems {
				t.Errorf("got %v, want %d problems", got, tc.wantProblems)
			}
		})
	}
}

func TestSameInstant(t *testing.T) {
	if got := sameInstant(types.StringValue("2030-01-01T03:00:00+01:00"), "2030-01-01T02:00:00.000Z"); got.ValueString() != "2030-01-01T03:00:00+01:00" {
		t.Errorf("equal instants: %v", got)
	}
	if got := sameInstant(types.StringValue("2030-01-01T03:00:00+01:00"), "2030-01-01T05:00:00.000Z"); got.ValueString() != "2030-01-01T05:00:00Z" {
		t.Errorf("drift hidden: %v", got)
	}
	if got := sameInstant(types.StringNull(), "2030-01-01T05:00:00.000Z"); got.ValueString() != "2030-01-01T05:00:00Z" {
		t.Errorf("import: %v", got)
	}
}

func TestParseImportID(t *testing.T) {
	id := "3f1e1c1a-0000-4000-8000-000000000001"
	project := "3f1e1c1a-0000-4000-8000-000000000002"
	if p, i, err := parseImportID(id); err != nil || p != "" || i != id {
		t.Errorf("plain id: %q %q %v", p, i, err)
	}
	if p, i, err := parseImportID(project + "/" + id); err != nil || p != project || i != id {
		t.Errorf("project/id: %q %q %v", p, i, err)
	}
	for _, bad := range []string{"", "x", id + "/x", "a/b/c"} {
		if _, _, err := parseImportID(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
