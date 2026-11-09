package provider

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

// testAccUserID is the API key owner's Montral user id (a workspace member to escalate to).
func testAccUserID(t *testing.T) string {
	t.Helper()
	if os.Getenv("TF_ACC") == "" {
		t.Skip("acceptance test: set TF_ACC=1")
	}
	var me struct {
		UserID string `json:"userId"`
	}
	if err := testAccClient(t).Get(context.Background(), "/me", "", &me); err != nil || me.UserID == "" {
		t.Fatalf("reading /me: %v", err)
	}
	return me.UserID
}

func escalationPolicyConfig(name, userID string, timeout int, project bool) string {
	projectArg := ""
	if project {
		projectArg = "project_id = data.montral_project.current.id"
	}
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

resource "montral_escalation_policy" "test" {
  name         = %[1]q
  repeat_count = 1
  %[5]s
  steps = [
    { timeout_min = %[4]d, channel_ids = [montral_alert_channel.first.id] },
    { timeout_min = 30, channel_ids = [montral_alert_channel.second.id], user_ids = [%[3]q] },
  ]
}

resource "montral_monitor" "m" {
  name                 = "%[1]s-monitor"
  type                 = "http"
  target               = %[2]q
  escalation_policy_id = montral_escalation_policy.test.id
}
`, name, testTarget(), userID, timeout, projectArg)
}

func checkPoliciesGone(t *testing.T) func(*terraform.State) error {
	return func(s *terraform.State) error {
		c := testAccClient(t)
		for _, rs := range s.RootModule().Resources {
			if rs.Type != "montral_escalation_policy" {
				continue
			}
			err := c.Get(context.Background(), "/escalation-policies/"+rs.Primary.ID, "", nil)
			if err == nil {
				return fmt.Errorf("escalation policy %s still exists", rs.Primary.ID)
			}
			if !client.IsNotFound(err) {
				return err
			}
		}
		return nil
	}
}

// create, update in place, import, drift (an edit through the API), out-of-band delete, replace on project change
func TestAccEscalationPolicy_basic(t *testing.T) {
	name := randName("tf-acc-policy")
	user := testAccUserID(t)
	var id string
	resource.Test(t, resource.TestCase{
		PreCheck:                 func() { testAccPreCheck(t) },
		ProtoV6ProviderFactories: testAccProtoV6ProviderFactories,
		CheckDestroy:             resource.ComposeAggregateTestCheckFunc(checkPoliciesGone(t), checkMonitorsGone(t)),
		Steps: []resource.TestStep{
			{
				Config: escalationPolicyConfig(name, user, 5, false),
				Check: resource.ComposeAggregateTestCheckFunc(
					captureID("montral_escalation_policy.test", &id),
					resource.TestCheckNoResourceAttr("montral_escalation_policy.test", "project_id"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "repeat_count", "1"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "version", "1"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "steps.#", "2"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "steps.0.timeout_min", "5"),
					resource.TestCheckTypeSetElemAttrPair("montral_escalation_policy.test", "steps.0.channel_ids.*", "montral_alert_channel.first", "id"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "steps.0.user_ids.#", "0"),
					resource.TestCheckTypeSetElemAttr("montral_escalation_policy.test", "steps.1.user_ids.*", user),
					resource.TestCheckResourceAttrPair("montral_monitor.m", "escalation_policy_id", "montral_escalation_policy.test", "id"),
				),
			},
			{
				// in place: same id, a new version
				Config: escalationPolicyConfig(name+"-renamed", user, 10, false),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_escalation_policy.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPtr("montral_escalation_policy.test", "id", &id),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "name", name+"-renamed"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "steps.0.timeout_min", "10"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "version", "2"),
				),
			},
			{ResourceName: "montral_escalation_policy.test", ImportState: true, ImportStateVerify: true},
			{
				// drift: edited through the API (with its version), the plan shows it
				PreConfig: func() {
					c := testAccClient(t)
					var p apiPolicy
					if err := c.Get(context.Background(), "/escalation-policies/"+id, "", &p); err != nil {
						t.Fatal(err)
					}
					body := map[string]any{"version": p.Version, "name": "edited by hand", "repeatCount": 3,
						"steps": []map[string]any{{"timeoutMin": 60, "userIds": []string{user}}}}
					if err := c.Patch(context.Background(), "/escalation-policies/"+id, "", body, nil); err != nil {
						t.Fatal(err)
					}
				},
				Config:             escalationPolicyConfig(name+"-renamed", user, 10, false),
				PlanOnly:           true,
				ExpectNonEmptyPlan: true,
			},
			{
				// apply converges, sending the refreshed version
				Config: escalationPolicyConfig(name+"-renamed", user, 10, false),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_escalation_policy.test", plancheck.ResourceActionUpdate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "name", name+"-renamed"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "repeat_count", "1"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "steps.#", "2"),
					resource.TestCheckResourceAttr("montral_escalation_policy.test", "version", "4"),
				),
			},
			{
				// deleted outside Terraform: created again, and the monitor follows the new policy
				PreConfig: func() {
					if err := testAccClient(t).Delete(context.Background(), "/escalation-policies/"+id, ""); err != nil {
						t.Fatal(err)
					}
				},
				Config: escalationPolicyConfig(name+"-renamed", user, 10, false),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_escalation_policy.test", plancheck.ResourceActionCreate),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					idChanged("montral_escalation_policy.test", &id),
					captureID("montral_escalation_policy.test", &id),
					resource.TestCheckResourceAttrPair("montral_monitor.m", "escalation_policy_id", "montral_escalation_policy.test", "id"),
				),
			},
			{
				// moving the policy into a project replaces it
				Config: escalationPolicyConfig(name+"-renamed", user, 10, true),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("montral_escalation_policy.test", plancheck.ResourceActionReplace),
				}},
				Check: resource.ComposeAggregateTestCheckFunc(
					idChanged("montral_escalation_policy.test", &id),
					resource.TestCheckResourceAttrPair("montral_escalation_policy.test", "project_id", "data.montral_project.current", "id"),
					resource.TestCheckResourceAttrPair("montral_monitor.m", "escalation_policy_id", "montral_escalation_policy.test", "id"),
				),
			},
			{ResourceName: "montral_escalation_policy.test", ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestAccEscalationPolicy_validation(t *testing.T) {
	const ch = "00000000-0000-4000-8000-000000000001"
	cases := map[string]string{
		`name = "x"` + "\n" + `steps = [{ timeout_min = 5 }]`: "each step needs at least one channel, person or schedule",
		`name = "x"` + "\n" + `steps = []`:                    "list must contain at least 1 elements",
		`name = "x"` + "\n" + `repeat_count = 9` + "\n" + `steps = [{ timeout_min = 5, channel_ids = ["` + ch + `"] }]`: "repeat_count value must be between 0 and 5",
		`name = " x"` + "\n" + `steps = [{ timeout_min = 5, channel_ids = ["` + ch + `"] }]`:                            "must not have surrounding spaces",
		`name = "x"` + "\n" + `steps = [{ timeout_min = 0, channel_ids = ["` + ch + `"] }]`:                             "value must be between 1 and 1440",
		`name = "x"` + "\n" + `steps = [{ timeout_min = 5, schedule_ids = ["nope"] }]`:                                  "must be a UUID",
	}
	steps := []resource.TestStep{}
	for body, want := range cases {
		steps = append(steps, resource.TestStep{
			Config:      "resource \"montral_escalation_policy\" \"bad\" {\n" + body + "\n}\n",
			PlanOnly:    true,
			ExpectError: wrapRE(want),
		})
	}
	resource.Test(t, resource.TestCase{PreCheck: func() { testAccPreCheck(t) }, ProtoV6ProviderFactories: testAccProtoV6ProviderFactories, Steps: steps})
}
