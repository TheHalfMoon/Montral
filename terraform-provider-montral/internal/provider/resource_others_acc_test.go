package provider

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
)

// ---- montral_alert_channel ----------------------------------------------------------------------------------------

func channelConfig(name, path string, enabled bool) string {
	return fmt.Sprintf(`
resource "montral_alert_channel" "webhook" {
  name    = %q
  type    = "webhook"
  enabled = %t
  secret_config = {
    url = %q
  }
}

resource "montral_alert_channel" "email" {
  name        = "%[1]s-email"
  type        = "email"
  scope       = "project"
  auto_enable = true
  config = {
    to = "tf-acc@example.test"
  }
}

resource "montral_alert_channel" "ntfy" {
  name = "%[1]s-ntfy"
  type = "ntfy"
  secret_config = {
    url   = "https://ntfy.sh"
    topic = "montral-tf-acc"
  }
}
`, name, enabled, testTarget()+path)
}

func TestAccAlertChannel_basic(t *testing.T) {
	name := randName("tf-acc-channel")
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkListedGone(t, "montral_alert_channel", "/channels"),
		Steps: []resource.TestStep{
			{
				Config: channelConfig(name, "?hook=1", true),
				Check: resource.ComposeAggregateTestCheckFunc(
					captureID("montral_alert_channel.webhook", &id),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "scope", "workspace"),
					resource.TestCheckNoResourceAttr("montral_alert_channel.webhook", "project_id"),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "secret_config.url", testTarget()+"?hook=1"),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "config.%", "0"),
					resource.TestCheckResourceAttr("montral_alert_channel.email", "scope", "project"),
					resource.TestCheckResourceAttrSet("montral_alert_channel.email", "project_id"),
					resource.TestCheckResourceAttr("montral_alert_channel.email", "config.to", "tf-acc@example.test"),
					resource.TestCheckResourceAttr("montral_alert_channel.email", "auto_enable", "true"),
					// the API's default ntfy priority is not forced into the configuration
					resource.TestCheckNoResourceAttr("montral_alert_channel.ntfy", "config.priority"),
				),
			},
			{
				// in place: name, enabled and the secret URL
				Config: channelConfig(name+"-renamed", "?hook=2", false),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_alert_channel.webhook", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_alert_channel.webhook", "id", &id),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "name", name+"-renamed"),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "enabled", "false"),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "secret_config.url", testTarget()+"?hook=2"),
				),
			},
			// the key is an owner's, so the API returns credentials and import can rebuild secret_config
			{ResourceName: "montral_alert_channel.webhook", ImportState: true, ImportStateVerify: true},
			{ResourceName: "montral_alert_channel.ntfy", ImportState: true, ImportStateVerify: true},
			{ResourceName: "montral_alert_channel.email", ImportState: true, ImportStateVerify: true, ImportStateIdFunc: importStateIDWithProject("montral_alert_channel.email")},
			{
				// a type change replaces the channel
				Config: channelConfig(name+"-renamed", "?hook=2", false) + `
resource "montral_alert_channel" "swap" {
  name = "swap"
  type = "slack"
  secret_config = { url = "https://hooks.slack.com/services/T000/B000/XXXX" }
}`,
			},
			{
				Config: channelConfig(name+"-renamed", "?hook=2", false) + `
resource "montral_alert_channel" "swap" {
  name = "swap"
  type = "discord"
  secret_config = { url = "https://discord.com/api/webhooks/1/abc" }
}`,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_alert_channel.swap", plancheck.ResourceActionReplace),
				}},
			},
		},
	})
}

func TestAccAlertChannel_driftAndDisappears(t *testing.T) {
	name := randName("tf-acc-channel-drift")
	var id string
	cfg := channelConfig(name, "", true)
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkListedGone(t, "montral_alert_channel", "/channels"),
		Steps: []resource.TestStep{
			{Config: cfg, Check: captureID("montral_alert_channel.webhook", &id)},
			{
				PreConfig: func() {
					body := map[string]any{"name": "renamed by hand", "enabled": false, "config": map[string]string{"url": testTarget() + "?by=hand"}}
					if err := testAccClient(t).Patch(context.Background(), "/channels/"+id, "", body, nil); err != nil {
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
					plancheck.ExpectResourceAction("montral_alert_channel.webhook", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "name", name),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "enabled", "true"),
					resource.TestCheckResourceAttr("montral_alert_channel.webhook", "secret_config.url", testTarget()),
				),
			},
			{
				PreConfig: func() {
					if err := testAccClient(t).Delete(context.Background(), "/channels/"+id, ""); err != nil {
						t.Fatal(err)
					}
				},
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_alert_channel.webhook", plancheck.ResourceActionCreate),
				}},
				Check: idChanged("montral_alert_channel.webhook", &id),
			},
		},
	})
}

func TestAccAlertChannel_validation(t *testing.T) {
	cases := map[string]string{
		`type = "webhook"` + "\n" + `config = { url = "https://example.com" }`:      `set it in secret_config`,
		`type = "webhook"` + "\n" + `secret_config = { url = "ftp://example.com" }`: `http(s) URL`,
		`type = "email"` + "\n" + `config = { to = "not-an-address" }`:              `email address`,
		`type = "email"`: `email channels need "to"`,
		`type = "telegram"` + "\n" + `secret_config = { botToken = "1:a", chatId = "1" }`: `not a credential`,
		`type = "sms"`: `value must be one of`,
		`type = "webhook"` + "\n" + `project_id = "00000000-0000-4000-8000-000000000000"` + "\n" + `secret_config = { url = "https://example.com" }`: `scope = "project"`,
	}
	steps := []resource.TestStep{}
	for body, want := range cases {
		steps = append(steps, resource.TestStep{
			Config:      "resource \"montral_alert_channel\" \"bad\" {\n  name = \"bad\"\n  " + body + "\n}\n",
			PlanOnly:    true,
			ExpectError: wrapRE(want),
		})
	}
	resource.Test(t, resource.TestCase{PreCheck: func() { testAccPreCheck(t) }, ProtoV6ProviderFactories: testAccProtoV6ProviderFactories, Steps: steps})
}

// ---- montral_status_page ------------------------------------------------------------------------------------------

func statusPageConfig(slug, title, visibility, password string) string {
	pw := ""
	if password != "" {
		pw = fmt.Sprintf("password = %q", password)
	}
	return fmt.Sprintf(`
resource "montral_monitor" "api" {
  name   = "%[1]s-api"
  type   = "http"
  target = %[5]q
}

resource "montral_monitor" "web" {
  name   = "%[1]s-web"
  type   = "http"
  target = %[5]q
}

resource "montral_status_page" "test" {
  slug       = %[1]q
  title      = %[2]q
  theme      = "dark"
  visibility = %[3]q
  %[4]s
  maintenance_reminder_hours = 12
  uptime_ok_pct   = 99.5
  uptime_warn_pct = 97
  external_url    = "https://example.com"
  components = [
    { monitor_id = montral_monitor.api.id, group_name = "Core" },
    { monitor_id = montral_monitor.web.id },
  ]
}
`, slug, title, visibility, pw, testTarget())
}

func TestAccStatusPage_basic(t *testing.T) {
	slug := randName("tf-acc-page")
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{
			{
				Config: statusPageConfig(slug, "Acceptance status", "public", ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					captureID("montral_status_page.test", &id),
					resource.TestCheckResourceAttr("montral_status_page.test", "slug", slug),
					resource.TestCheckResourceAttr("montral_status_page.test", "theme", "dark"),
					resource.TestCheckResourceAttr("montral_status_page.test", "has_password", "false"),
					resource.TestCheckResourceAttr("montral_status_page.test", "maintenance_reminder_hours", "12"),
					resource.TestCheckResourceAttr("montral_status_page.test", "uptime_ok_pct", "99.5"),
					resource.TestCheckResourceAttr("montral_status_page.test", "components.#", "2"),
					resource.TestCheckResourceAttr("montral_status_page.test", "components.0.group_name", "Core"),
					resource.TestCheckResourceAttrPair("montral_status_page.test", "components.1.monitor_id", "montral_monitor.web", "id"),
					resource.TestCheckResourceAttr("montral_status_page.test", "url", testAccClientURL()+"/status/"+slug),
				),
			},
			{
				// in place: title, visibility and a write-only password
				Config: statusPageConfig(slug, "Acceptance status (protected)", "password", "correct horse battery"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_status_page.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_status_page.test", "id", &id),
					resource.TestCheckResourceAttr("montral_status_page.test", "visibility", "password"),
					resource.TestCheckResourceAttr("montral_status_page.test", "has_password", "true"),
					resource.TestCheckResourceAttr("montral_status_page.test", "password", "correct horse battery"),
				),
			},
			{
				// the password is never returned, so it cannot be imported
				ResourceName:            "montral_status_page.test",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"password"},
			},
			{
				// out-of-band edit: plan shows it, apply converges
				PreConfig: func() {
					body := map[string]any{"title": "edited by hand", "theme": "light", "components": []any{}}
					if err := testAccClient(t).Patch(context.Background(), "/status-pages/"+id, "", body, nil); err != nil {
						t.Fatal(err)
					}
				},
				Config:             statusPageConfig(slug, "Acceptance status (protected)", "password", "correct horse battery"),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{
				Config: statusPageConfig(slug, "Acceptance status (protected)", "password", "correct horse battery"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("montral_status_page.test", "title", "Acceptance status (protected)"),
					resource.TestCheckResourceAttr("montral_status_page.test", "theme", "dark"),
					resource.TestCheckResourceAttr("montral_status_page.test", "components.#", "2"),
				),
			},
			{
				// slug changes replace the page
				Config: statusPageConfig(slug+"-b", "Acceptance status (protected)", "password", "correct horse battery"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_status_page.test", plancheck.ResourceActionReplace),
				}},
				Check: idChanged("montral_status_page.test", &id),
			},
			{
				PreConfig: func() {
					var current string
					// the replaced page's id is in state; delete it behind Terraform's back
					var pages []struct {
						ID   string `json:"id"`
						Slug string `json:"slug"`
					}
					if err := testAccClient(t).Get(context.Background(), "/status-pages", "", &pages); err != nil {
						t.Fatal(err)
					}
					for _, p := range pages {
						if p.Slug == slug+"-b" {
							current = p.ID
						}
					}
					if current == "" {
						t.Fatal("replaced page not found")
					}
					id = current
					if err := testAccClient(t).Delete(context.Background(), "/status-pages/"+current, ""); err != nil {
						t.Fatal(err)
					}
				},
				Config: statusPageConfig(slug+"-b", "Acceptance status (protected)", "password", "correct horse battery"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_status_page.test", plancheck.ResourceActionCreate),
				}},
				Check: idChanged("montral_status_page.test", &id),
			},
		},
	})
}

func TestAccStatusPage_validation(t *testing.T) {
	cases := map[string]string{
		`slug = "Bad Slug"` + "\n" + `title = "x"`:                                                                 `lowercase letters, digits or hyphens`,
		`slug = "ok-slug"` + "\n" + `title = "x"` + "\n" + `visibility = "password"`:                               `needs a password`,
		`slug = "ok-slug"` + "\n" + `title = "x"` + "\n" + `uptime_ok_pct = 95` + "\n" + `uptime_warn_pct = 96`:    `amber threshold`,
		`slug = "ok-slug"` + "\n" + `title = "x"` + "\n" + `password = "short"` + "\n" + `visibility = "password"`: `string length must be between 8 and 200`,
		`slug = "ok-slug"` + "\n" + `title = "x"` + "\n" + `theme = "neon"`:                                        `value must be one of`,
	}
	steps := []resource.TestStep{}
	for body, want := range cases {
		steps = append(steps, resource.TestStep{
			Config: "resource \"montral_status_page\" \"bad\" {\n" + body + "\n}\n", PlanOnly: true, ExpectError: wrapRE(want),
		})
	}
	resource.Test(t, resource.TestCase{PreCheck: func() { testAccPreCheck(t) }, ProtoV6ProviderFactories: testAccProtoV6ProviderFactories, Steps: steps})
}

// ---- montral_maintenance_window -----------------------------------------------------------------------------------

func maintenanceConfig(name, start, end, recurrence string) string {
	return fmt.Sprintf(`
resource "montral_monitor" "m" {
  name   = "%[1]s-monitor"
  type   = "http"
  target = %[5]q
}

resource "montral_maintenance_window" "test" {
  name        = %[1]q
  starts_at   = %[2]q
  ends_at     = %[3]q
  monitor_ids = [montral_monitor.m.id]
  %[4]s
}
`, name, start, end, recurrence, testTarget())
}

func TestAccMaintenanceWindow_basic(t *testing.T) {
	name := randName("tf-acc-maint")
	day := time.Now().UTC().Add(72 * time.Hour).Truncate(24 * time.Hour)
	start := day.Add(2 * time.Hour).Format(time.RFC3339)
	// the same instant written with an offset: no drift after the API answers in UTC
	end := day.Add(4 * time.Hour).In(time.FixedZone("", 3600)).Format(time.RFC3339)
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkListedGone(t, "montral_maintenance_window", "/maintenance"),
		Steps: []resource.TestStep{
			{
				Config: maintenanceConfig(name, start, end, ""),
				Check: resource.ComposeAggregateTestCheckFunc(
					captureID("montral_maintenance_window.test", &id),
					resource.TestCheckResourceAttr("montral_maintenance_window.test", "starts_at", start),
					resource.TestCheckResourceAttr("montral_maintenance_window.test", "ends_at", end),
					resource.TestCheckResourceAttr("montral_maintenance_window.test", "monitor_ids.#", "1"),
					resource.TestCheckNoResourceAttr("montral_maintenance_window.test", "series_id"),
				),
			},
			{
				// the API cannot edit a window: any change replaces it
				Config: maintenanceConfig(name+"-renamed", start, end, ""),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_maintenance_window.test", plancheck.ResourceActionReplace),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(idChanged("montral_maintenance_window.test", &id), captureID("montral_maintenance_window.test", &id)),
			},
			{
				ResourceName:            "montral_maintenance_window.test",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"ends_at"}, // configured with an offset, imported in UTC
			},
			{
				PreConfig: func() {
					if err := testAccClient(t).Delete(context.Background(), "/maintenance/"+id, ""); err != nil {
						t.Fatal(err)
					}
				},
				Config: maintenanceConfig(name+"-renamed", start, end, ""),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_maintenance_window.test", plancheck.ResourceActionCreate),
				}},
			},
			{
				// a weekly series; destroy cancels it
				Config: maintenanceConfig(name+"-weekly", start, day.Add(3*time.Hour).Format(time.RFC3339), fmt.Sprintf(`recurrence = {
    frequency = "weekly"
    time_zone = "America/Toronto"
    until     = %q
  }`, day.Add(30*24*time.Hour).Format(time.RFC3339))),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrSet("montral_maintenance_window.test", "series_id"),
					resource.TestCheckResourceAttr("montral_maintenance_window.test", "recurrence.frequency", "weekly"),
				),
			},
		},
	})
}

func TestAccMaintenanceWindow_validation(t *testing.T) {
	cases := map[string]string{
		`starts_at = "2030-01-01T04:00:00Z"` + "\n" + `ends_at = "2030-01-01T02:00:00Z"`:                                                                                                        `the end must be after the start`,
		`starts_at = "tomorrow"` + "\n" + `ends_at = "2030-01-01T02:00:00Z"`:                                                                                                                    `RFC 3339`,
		`starts_at = "2030-01-01T02:00:00Z"` + "\n" + `ends_at = "2030-01-03T02:00:00Z"` + "\n" + `recurrence = { frequency = "daily", time_zone = "UTC", until = "2030-02-01T00:00:00Z" }`:     `at most 24 hours`,
		`starts_at = "2030-01-01T02:00:00Z"` + "\n" + `ends_at = "2030-01-01T03:00:00Z"` + "\n" + `recurrence = { frequency = "daily", time_zone = "Nowhere", until = "2030-02-01T00:00:00Z" }`: `IANA time zone`,
	}
	steps := []resource.TestStep{}
	for body, want := range cases {
		steps = append(steps, resource.TestStep{
			Config: "resource \"montral_maintenance_window\" \"bad\" {\n  name = \"bad\"\n" + body + "\n}\n", PlanOnly: true, ExpectError: wrapRE(want),
		})
	}
	resource.Test(t, resource.TestCase{PreCheck: func() { testAccPreCheck(t) }, ProtoV6ProviderFactories: testAccProtoV6ProviderFactories, Steps: steps})
}

// ---- montral_project_alerting + data sources ------------------------------------------------------------------------

func TestAccProjectAlerting_basic(t *testing.T) {
	name := randName("tf-acc-alerting")
	cfg := func(levels string, reminder string) string {
		return fmt.Sprintf(`
data "montral_project" "current" {}

resource "montral_alert_channel" "first" {
  name          = "%[1]s-first"
  type          = "webhook"
  secret_config = { url = %[2]q }
}

resource "montral_alert_channel" "second" {
  name          = "%[1]s-second"
  type          = "pagerduty"
  secret_config = { routingKey = "synthetic-routing-key" }
}

resource "montral_project_alerting" "test" {
  project_id = data.montral_project.current.id
  %[4]s
  escalation = [%[3]s]
}
`, name, testTarget(), levels, reminder)
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		Steps: []resource.TestStep{
			{
				Config: cfg(`{ channel_ids = [montral_alert_channel.first.id], escalate_after_min = 5 }`, `reminder_interval_min = 15`),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPair("montral_project_alerting.test", "id", "data.montral_project.current", "id"),
					resource.TestCheckResourceAttr("montral_project_alerting.test", "reminder_interval_min", "15"),
					resource.TestCheckResourceAttr("montral_project_alerting.test", "escalation.#", "1"),
					resource.TestCheckResourceAttr("montral_project_alerting.test", "escalation.0.escalate_after_min", "5"),
				),
			},
			{
				Config: cfg(`{ channel_ids = [montral_alert_channel.first.id], escalate_after_min = 5 },
    { channel_ids = [montral_alert_channel.first.id, montral_alert_channel.second.id], escalate_after_min = 30 }`, `reminder_email = true`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_project_alerting.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckNoResourceAttr("montral_project_alerting.test", "reminder_interval_min"),
					resource.TestCheckResourceAttr("montral_project_alerting.test", "reminder_email", "true"),
					resource.TestCheckResourceAttr("montral_project_alerting.test", "escalation.1.channel_ids.#", "2"),
				),
			},
			{ResourceName: "montral_project_alerting.test", ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestAccProjectAlerting_validation(t *testing.T) {
	const ch = "00000000-0000-4000-8000-000000000001"
	cases := map[string]string{
		`escalation = [{ channel_ids = ["` + ch + `"], escalate_after_min = 30 }, { channel_ids = ["` + ch + `"], escalate_after_min = 10 }]`: "must come later than the one before",
		`reminder_interval_min = 7`:                                   "value must be one of",
		`escalation = [{ channel_ids = [], escalate_after_min = 5 }]`: "set must contain at least 1 elements",
	}
	steps := []resource.TestStep{}
	for body, want := range cases {
		steps = append(steps, resource.TestStep{
			Config:      "resource \"montral_project_alerting\" \"bad\" {\n  project_id = \"" + ch + "\"\n  " + body + "\n}\n",
			PlanOnly:    true,
			ExpectError: wrapRE(want),
		})
	}
	resource.Test(t, resource.TestCase{PreCheck: func() { testAccPreCheck(t) }, ProtoV6ProviderFactories: testAccProtoV6ProviderFactories, Steps: steps})
}

func TestAccDataSources(t *testing.T) {
	name := randName("tf-acc-ds")
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             checkMonitorsGone(t),
		Steps: []resource.TestStep{{
			Config: fmt.Sprintf(`
data "montral_project" "current" {}

data "montral_project" "by_id" {
  id = data.montral_project.current.id
}

data "montral_project" "by_name" {
  name = data.montral_project.current.name
}

resource "montral_monitor" "m" {
  name   = %q
  type   = "http"
  target = %q
  tags   = ["ds"]
}

data "montral_monitor" "by_id" {
  id = montral_monitor.m.id
}

data "montral_monitor" "by_name" {
  name       = montral_monitor.m.name
  project_id = montral_monitor.m.project_id
}
`, name, testTarget()),
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttrSet("data.montral_project.current", "id"),
				resource.TestCheckResourceAttrSet("data.montral_project.current", "organization_id"),
				resource.TestCheckResourceAttrPair("data.montral_project.by_id", "name", "data.montral_project.current", "name"),
				resource.TestCheckResourceAttrPair("data.montral_project.by_name", "id", "data.montral_project.current", "id"),
				resource.TestCheckResourceAttrPair("data.montral_monitor.by_id", "name", "montral_monitor.m", "name"),
				resource.TestCheckResourceAttrPair("data.montral_monitor.by_name", "id", "montral_monitor.m", "id"),
				resource.TestCheckResourceAttr("data.montral_monitor.by_name", "type", "http"),
				resource.TestCheckResourceAttr("data.montral_monitor.by_name", "tags.0", "ds"),
				resource.TestCheckResourceAttrPair("montral_monitor.m", "project_id", "data.montral_project.current", "id"),
			),
		}},
	})
}

// ---- several resources referencing each other ---------------------------------------------------------------------

func TestAccMultiResource(t *testing.T) {
	name := randName("tf-acc-stack")
	day := time.Now().UTC().Add(96 * time.Hour).Truncate(time.Hour)
	cfg := func(title string) string {
		return fmt.Sprintf(`
data "montral_project" "current" {}

resource "montral_alert_channel" "ops" {
  name          = "%[1]s-ops"
  type          = "webhook"
  secret_config = { url = %[2]q }
}

resource "montral_monitor" "api" {
  name        = "%[1]s-api"
  type        = "http"
  target      = %[2]q
  channel_ids = [montral_alert_channel.ops.id]
  json_path   = "ok"
  json_expected = "true"
}

resource "montral_monitor" "heartbeat" {
  name        = "%[1]s-cron"
  type        = "heartbeat"
  interval_sec = 3600
  channel_ids = [montral_alert_channel.ops.id]
}

resource "montral_status_page" "public" {
  slug  = "%[1]s"
  title = %[3]q
  components = [
    { monitor_id = montral_monitor.api.id, group_name = "API" },
    { monitor_id = montral_monitor.heartbeat.id, group_name = "Jobs" },
  ]
}

resource "montral_maintenance_window" "upgrade" {
  name        = "%[1]s-upgrade"
  starts_at   = %[4]q
  ends_at     = %[5]q
  monitor_ids = [montral_monitor.api.id]
}

resource "montral_project_alerting" "current" {
  project_id = data.montral_project.current.id
  escalation = [{ channel_ids = [montral_alert_channel.ops.id], escalate_after_min = 15 }]
}
`, name, testTarget(), title, day.Format(time.RFC3339), day.Add(time.Hour).Format(time.RFC3339))
	}
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy: resource.ComposeAggregateTestCheckFunc(
			checkMonitorsGone(t),
			checkListedGone(t, "montral_alert_channel", "/channels"),
			checkListedGone(t, "montral_maintenance_window", "/maintenance"),
		),
		Steps: []resource.TestStep{
			{
				Config: cfg("Stack status"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("montral_monitor.api", "channel_ids.#", "1"),
					resource.TestCheckTypeSetElemAttrPair("montral_monitor.api", "channel_ids.*", "montral_alert_channel.ops", "id"),
					resource.TestCheckResourceAttrPair("montral_status_page.public", "components.0.monitor_id", "montral_monitor.api", "id"),
					resource.TestCheckResourceAttrPair("montral_status_page.public", "components.1.monitor_id", "montral_monitor.heartbeat", "id"),
					resource.TestCheckTypeSetElemAttrPair("montral_maintenance_window.upgrade", "monitor_ids.*", "montral_monitor.api", "id"),
				),
			},
			{
				Config: cfg("Stack status v2"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_status_page.public", plancheck.ResourceActionUpdate),
					plancheck.ExpectResourceAction("montral_monitor.api", plancheck.ResourceActionNoop),
					plancheck.ExpectResourceAction("montral_alert_channel.ops", plancheck.ResourceActionNoop),
				}},
			},
		},
	})
}
