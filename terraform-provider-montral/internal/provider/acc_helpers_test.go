package provider

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/acctest"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

// Acceptance tests run against a real Montral server (TF_ACC=1, MONTRAL_ENDPOINT, MONTRAL_API_KEY; see
// .github/workflows/montral-terraform.yml). The server must allow private targets (ALLOW_PRIVATE_TARGETS=true) so the
// monitors can check the server itself instead of the internet.

var testAccProtoV6ProviderFactories = map[string]func() (tfprotov6.ProviderServer, error){
	"montral": providerserver.NewProtocol6WithError(New("test")()),
}

func testAccPreCheck(t *testing.T) {
	t.Helper()
	for _, v := range []string{"MONTRAL_ENDPOINT", "MONTRAL_API_KEY"} {
		if os.Getenv(v) == "" {
			t.Fatalf("%s must be set for acceptance tests", v)
		}
	}
}

// testAccClient is the API client the tests use to change things behind Terraform's back.
func testAccClient(t *testing.T) *client.Client {
	t.Helper()
	c, err := client.New(client.Options{Endpoint: os.Getenv("MONTRAL_ENDPOINT"), APIKey: os.Getenv("MONTRAL_API_KEY"), ProjectID: os.Getenv("MONTRAL_PROJECT_ID")})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// testTarget is an HTTP URL the server can check: its own health endpoint unless MONTRAL_TEST_TARGET says otherwise.
func testTarget() string {
	if v := os.Getenv("MONTRAL_TEST_TARGET"); v != "" {
		return v
	}
	return os.Getenv("MONTRAL_ENDPOINT") + "/health"
}

// testHostPort is the server's own host:port, for tcp monitors.
func testHostPort() string {
	u, err := url.Parse(os.Getenv("MONTRAL_ENDPOINT"))
	if err != nil {
		return "127.0.0.1:80"
	}
	if u.Port() == "" {
		if u.Scheme == "https" {
			return u.Hostname() + ":443"
		}
		return u.Hostname() + ":80"
	}
	return u.Host
}

func randName(prefix string) string {
	return prefix + "-" + acctest.RandStringFromCharSet(8, "abcdefghijklmnopqrstuvwxyz0123456789")
}

// captureID stores a resource's id for later steps.
func captureID(name string, into *string) func(*terraform.State) error {
	return func(s *terraform.State) error {
		rs, ok := s.RootModule().Resources[name]
		if !ok {
			return fmt.Errorf("%s not in state", name)
		}
		*into = rs.Primary.ID
		return nil
	}
}

// idChanged fails unless the resource's id differs from *previous (it was replaced or recreated).
func idChanged(name string, previous *string) func(*terraform.State) error {
	return func(s *terraform.State) error {
		rs, ok := s.RootModule().Resources[name]
		if !ok {
			return fmt.Errorf("%s not in state", name)
		}
		if rs.Primary.ID == *previous {
			return fmt.Errorf("%s still has id %s; expected a new object", name, *previous)
		}
		return nil
	}
}

// importStateIDWithProject builds the `<project_id>/<id>` import ID.
func importStateIDWithProject(name string) func(*terraform.State) (string, error) {
	return func(s *terraform.State) (string, error) {
		rs, ok := s.RootModule().Resources[name]
		if !ok {
			return "", fmt.Errorf("%s not in state", name)
		}
		if p := rs.Primary.Attributes["project_id"]; p != "" {
			return p + "/" + rs.Primary.ID, nil
		}
		return rs.Primary.ID, nil
	}
}

// checkGone verifies after destroy that the API no longer has the objects.
func checkMonitorsGone(t *testing.T) func(*terraform.State) error {
	return func(s *terraform.State) error {
		c := testAccClient(t)
		for _, rs := range s.RootModule().Resources {
			if rs.Type != "montral_monitor" {
				continue
			}
			err := c.Get(context.Background(), "/monitors/"+rs.Primary.ID, rs.Primary.Attributes["project_id"], nil)
			if err == nil {
				return fmt.Errorf("monitor %s still exists", rs.Primary.ID)
			}
			if !client.IsNotFound(err) {
				return err
			}
		}
		return nil
	}
}

func listContains[T any](c *client.Client, path, project, id string, idOf func(T) string) (bool, error) {
	var list []T
	if err := c.Get(context.Background(), path, project, &list); err != nil {
		return false, err
	}
	for _, x := range list {
		if idOf(x) == id {
			return true, nil
		}
	}
	return false, nil
}

func checkListedGone(t *testing.T, resourceType, path string) func(*terraform.State) error {
	return func(s *terraform.State) error {
		c := testAccClient(t)
		for _, rs := range s.RootModule().Resources {
			if rs.Type != resourceType {
				continue
			}
			var found bool
			var err error
			switch resourceType {
			case "montral_alert_channel":
				found, err = listContains(c, path, rs.Primary.Attributes["project_id"], rs.Primary.ID, func(x client.Channel) string { return x.ID })
			case "montral_maintenance_window":
				err = c.Get(context.Background(), "/maintenance/"+rs.Primary.ID, rs.Primary.Attributes["project_id"], nil)
				found = err == nil
				if client.IsNotFound(err) {
					err = nil
				}
			}
			if err != nil {
				return err
			}
			if found {
				return fmt.Errorf("%s %s still exists", resourceType, rs.Primary.ID)
			}
		}
		return nil
	}
}

// wrapRE matches text that Terraform may have wrapped over several lines: QuoteMeta, with any whitespace run allowed
// wherever s has a space.
func wrapRE(s string) *regexp.Regexp {
	parts := strings.Fields(s)
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	return regexp.MustCompile(strings.Join(parts, `\s+`))
}

// testAccClientURL is the endpoint as the provider normalises it.
func testAccClientURL() string {
	u, err := client.ParseEndpoint(os.Getenv("MONTRAL_ENDPOINT"), true)
	if err != nil {
		return ""
	}
	return strings.TrimRight(u.String(), "/")
}
