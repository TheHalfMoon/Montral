package provider

import (
	"context"
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
)

func monitorHTTPConfig(name string, interval int, extra string) string {
	return fmt.Sprintf(`
resource "montral_monitor" "test" {
  name             = %q
  type             = "http"
  target           = %q
  interval_sec     = %d
  timeout_ms       = 5000
  failure_threshold = 2
  tags             = ["terraform", "acc"]
  headers = {
    "X-Synthetic" = "terraform-acceptance"
  }
%s
}
`, name, testTarget(), interval, extra)
}

// create, read, update in place, pause, import, destroy
func TestAccMonitor_basic(t *testing.T) {
	name := randName("tf-acc-monitor")
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{
				Config: monitorHTTPConfig(name, 60, ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					captureID("montral_monitor.test", &id),
					resource.TestCheckResourceAttrSet("montral_monitor.test", "id"),
					resource.TestCheckResourceAttrSet("montral_monitor.test", "project_id"),
					resource.TestCheckResourceAttr("montral_monitor.test", "name", name),
					resource.TestCheckResourceAttr("montral_monitor.test", "method", "GET"),
					resource.TestCheckResourceAttr("montral_monitor.test", "expected_status", "200"),
					resource.TestCheckResourceAttr("montral_monitor.test", "interval_sec", "60"),
					resource.TestCheckResourceAttr("montral_monitor.test", "regions.#", "1"),
					resource.TestCheckResourceAttr("montral_monitor.test", "regions.0", "auto"),
					resource.TestCheckResourceAttr("montral_monitor.test", "tags.#", "2"),
					resource.TestCheckResourceAttr("montral_monitor.test", "headers.X-Synthetic", "terraform-acceptance"),
					resource.TestCheckResourceAttr("montral_monitor.test", "paused", "false"),
					resource.TestCheckResourceAttrSet("montral_monitor.test", "created_at"),
				),
			},
			{
				// in-place update: same id, new values
				Config: monitorHTTPConfig(name+"-renamed", 120, `
  keyword          = "ok"
  keyword_mode     = "contains"
  slow_threshold_ms = 2500
  slow_alert_after = 3
  recovery_threshold = 2
  paused           = true
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_monitor.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_monitor.test", "id", &id),
					resource.TestCheckResourceAttr("montral_monitor.test", "name", name+"-renamed"),
					resource.TestCheckResourceAttr("montral_monitor.test", "interval_sec", "120"),
					resource.TestCheckResourceAttr("montral_monitor.test", "keyword", "ok"),
					resource.TestCheckResourceAttr("montral_monitor.test", "recovery_threshold", "2"),
					resource.TestCheckResourceAttr("montral_monitor.test", "paused", "true"),
					resource.TestCheckResourceAttr("montral_monitor.test", "status", "paused"),
				),
			},
			{
				// resume
				Config: monitorHTTPConfig(name+"-renamed", 120, `  keyword = "ok"`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_monitor.test", "id", &id),
					resource.TestCheckResourceAttr("montral_monitor.test", "paused", "false"),
					resource.TestCheckResourceAttr("montral_monitor.test", "slow_alert_after", "0"),
				),
			},
			{
				ResourceName:      "montral_monitor.test",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				// import with the <project_id>/<id> form
				ResourceName:      "montral_monitor.test",
				ImportState:       true,
				ImportStateIdFunc: importStateIDWithProject("montral_monitor.test"),
				ImportStateVerify: true,
			},
		},
	})
}

// changing the type replaces the monitor
func TestAccMonitor_replace(t *testing.T) {
	name := randName("tf-acc-replace")
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{
				Config: fmt.Sprintf(`
resource "montral_monitor" "test" {
  name   = %q
  type   = "http"
  target = %q
}`, name, testTarget()),
				Check: captureID("montral_monitor.test", &id),
			},
			{
				Config: fmt.Sprintf(`
resource "montral_monitor" "test" {
  name   = %q
  type   = "tcp"
  target = %q
}`, name, testHostPort()),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_monitor.test", plancheck.ResourceActionReplace),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					idChanged("montral_monitor.test", &id),
					resource.TestCheckResourceAttr("montral_monitor.test", "type", "tcp"),
				),
			},
		},
	})
}

// every check type the self-hosted server supports, created together; the heartbeat one is imported
func TestAccMonitor_types(t *testing.T) {
	prefix := randName("tf-acc-types")
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{
				Config: fmt.Sprintf(`
locals {
  prefix = %[1]q
}

resource "montral_monitor" "tcp" {
  name   = "${local.prefix}-tcp"
  type   = "tcp"
  target = %[2]q
}

resource "montral_monitor" "dns" {
  name               = "${local.prefix}-dns"
  type               = "dns"
  target             = "example.com"
  dns_record_type    = "AAAA"
  dns_match_mode     = "contains"
  dns_expected_value = "2606:"
  interval_sec       = 300
}

resource "montral_monitor" "heartbeat" {
  name         = "${local.prefix}-heartbeat"
  type         = "heartbeat"
  interval_sec = 3600
  grace_sec    = 300
}

resource "montral_monitor" "ping" {
  name   = "${local.prefix}-ping"
  type   = "ping"
  target = "127.0.0.1"
}

resource "montral_monitor" "certificate" {
  name                    = "${local.prefix}-certificate"
  type                    = "certificate"
  target                  = "example.com:443"
  interval_sec            = 86400
  domain_expiry_warn_days = 14
}

resource "montral_monitor" "keyword" {
  name         = "${local.prefix}-keyword"
  type         = "http"
  target       = %[3]q
  keyword      = "maintenance"
  keyword_mode = "absent"
}

resource "montral_monitor" "json" {
  name          = "${local.prefix}-json"
  type          = "http"
  method        = "POST"
  target        = %[3]q
  request_body  = jsonencode({ probe = "terraform" })
  headers       = { "Content-Type" = "application/json" }
  json_path     = "$.ok"
  json_match    = "equals"
  json_expected = "true"
  expected_status = 200
}

resource "montral_monitor" "child" {
  name                  = "${local.prefix}-child"
  type                  = "http"
  target                = %[3]q
  depends_on_monitor_id = montral_monitor.keyword.id
}
`, prefix, testHostPort(), testTarget()),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("montral_monitor.dns", "dns_record_type", "AAAA"),
					resource.TestCheckResourceAttr("montral_monitor.dns", "dns_expected_value", "2606:"),
					resource.TestCheckResourceAttr("montral_monitor.heartbeat", "target", ""),
					resource.TestCheckResourceAttrSet("montral_monitor.heartbeat", "heartbeat_token"),
					resource.TestMatchResourceAttr("montral_monitor.heartbeat", "heartbeat_url", regexp.MustCompile(`/api/heartbeat/[0-9a-f]{32}$`)),
					resource.TestCheckResourceAttr("montral_monitor.certificate", "interval_sec", "86400"),
					resource.TestCheckResourceAttr("montral_monitor.keyword", "keyword_mode", "absent"),
					resource.TestCheckResourceAttr("montral_monitor.json", "json_path", "$.ok"),
					resource.TestCheckResourceAttr("montral_monitor.json", "method", "POST"),
					resource.TestCheckResourceAttrPair("montral_monitor.child", "depends_on_monitor_id", "montral_monitor.keyword", "id"),
				),
			},
			{
				ResourceName:      "montral_monitor.heartbeat",
				ImportState:       true,
				ImportStateVerify: true,
			},
			{
				ResourceName:      "montral_monitor.json",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
	})
}

// an out-of-band change shows up in the plan, and apply converges back to the configuration
func TestAccMonitor_drift(t *testing.T) {
	name := randName("tf-acc-drift")
	var id string
	cfg := monitorHTTPConfig(name, 60, "")
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{Config: cfg, Check: captureID("montral_monitor.test", &id)},
			{
				PreConfig: func() {
					c := testAccClient(t)
					body := map[string]any{"name": name + "-changed-by-hand", "intervalSec": 300, "tags": []string{"hand"}}
					if err := c.Patch(context.Background(), "/monitors/"+id, "", body, nil); err != nil {
						t.Fatal(err)
					}
				},
				Config:             cfg,
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_monitor.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_monitor.test", "id", &id),
					resource.TestCheckResourceAttr("montral_monitor.test", "name", name),
					resource.TestCheckResourceAttr("montral_monitor.test", "interval_sec", "60"),
					resource.TestCheckResourceAttr("montral_monitor.test", "tags.0", "terraform"),
				),
			},
		},
	})
}

// a monitor deleted outside Terraform is removed from state and created again
func TestAccMonitor_disappears(t *testing.T) {
	name := randName("tf-acc-gone")
	var id string
	cfg := monitorHTTPConfig(name, 60, "")
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{Config: cfg, Check: captureID("montral_monitor.test", &id)},
			{
				PreConfig: func() {
					if err := testAccClient(t).Delete(context.Background(), "/monitors/"+id, ""); err != nil {
						t.Fatal(err)
					}
				},
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_monitor.test", plancheck.ResourceActionCreate),
				}},
				Check: idChanged("montral_monitor.test", &id),
			},
		},
	})
}

// plan-time validation mirrors the API's rules
func TestAccMonitor_validation(t *testing.T) {
	cases := map[string]struct {
		body string
		err  string
	}{
		"bad type":            {`type = "smtp"` + "\n" + `target = "x"`, `value must be one of`},
		"interval too short":  {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `interval_sec = 30`, `interval_sec`},
		"http target":         {`type = "http"` + "\n" + `target = "example.com"`, `absolute http:// or https:// URL`},
		"heartbeat target":    {`type = "heartbeat"` + "\n" + `target = "https://example.com"`, `heartbeat monitors have no target`},
		"body with GET":       {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `request_body = "{}"`, `GET and HEAD cannot send a request body`},
		"json needs expected": {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `json_path = "$.status"`, `json_expected is required`},
		"bad json path":       {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `json_path = "a..b"` + "\n" + `json_expected = "x"`, `invalid JSON path`},
		"dns on http":         {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `dns_record_type = "MX"`, `apply to dns monitors only`},
		"domain interval":     {`type = "domain"` + "\n" + `target = "example.com"`, `3600 to 86400`},
		"regions on dns":      {`type = "dns"` + "\n" + `target = "example.com"` + "\n" + `regions = ["eu-west"]`, `http, tcp and websocket monitors only`},
		"duplicate regions":   {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `regions = ["auto", "auto"]`, `duplicate values`},
		"bad channel id":      {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `channel_ids = ["not-a-uuid"]`, `must be a UUID`},
		"tag spaces":          {`type = "http"` + "\n" + `target = "https://example.com"` + "\n" + `tags = [" x"]`, `without leading or trailing spaces`},
	}
	steps := []resource.TestStep{}
	for name, tc := range cases {
		steps = append(steps, resource.TestStep{
			Config:      fmt.Sprintf("resource \"montral_monitor\" \"bad\" {\n  name = %q\n  %s\n}\n", "validation "+name, tc.body),
			PlanOnly:    true,
			ExpectError: wrapRE(tc.err),
		})
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps:                    steps,
	})
}

// a server-side refusal surfaces with its status and API error code
func TestAccMonitor_apiError(t *testing.T) {
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{{
			Config: fmt.Sprintf(`
resource "montral_monitor" "bad" {
  name                  = %q
  type                  = "http"
  target                = %q
  depends_on_monitor_id = "00000000-0000-4000-8000-000000000000"
}`, randName("tf-acc-api-error"), testTarget()),
			ExpectError: wrapRE("HTTP 400 [dependency_not_found]"),
		}},
	})
}
