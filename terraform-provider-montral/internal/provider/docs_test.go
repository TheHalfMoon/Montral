package provider

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-go/tftypes"
)

// The docs/ pages follow the tfplugindocs layout and are rendered from the provider's own schema and the examples/
// directory, so they cannot drift from the code. Regenerate with:
//
//	MONTRAL_UPDATE_DOCS=1 go test ./internal/provider -run TestDocsAreCurrent
//
// (tfplugindocs itself needs a Terraform binary; this renders the same format without one.)

var docNotes = map[string]string{
	"resource/montral_alert_channel": `## Secrets and drift

Settings Montral treats as credentials (` + "`url`, `secret`, `botToken`, `routingKey`, `token`, `topic`, `userKey`" + `) belong in
` + "`secret_config`" + `, which is sensitive. The API returns them only to workspace owners and admins. With such a key, ` + "`terraform plan`" + `
detects any out-of-band change. With a member's key the API returns placeholders instead: the provider then keeps the values from
state and cannot detect a credential changed outside Terraform (names, toggles and plain settings are still refreshed).
Both maps are stored in the state file. Protect it like any other secret store.

Settings the API fills in itself (ntfy ` + "`priority = \"3\"`" + `) are left out of state unless configured.
Montral refuses to delete a channel that monitors still alert. Terraform removes the monitor reference first when both
are in the same configuration.
`,
	"resource/montral_status_page": `## Password

Montral stores a page password as a PBKDF2 hash and never returns it. Set it with the write-only ` + "`password_wo`" + `
(Terraform 1.11 or later, OpenTofu 1.11 or later). Its value is never written to the plan or the state. Terraform cannot
compare a value it does not store, so the password is sent on create and whenever ` + "`password_wo_version`" + ` changes. To
rotate the password, change both.

` + "```terraform" + `
resource "montral_status_page" "partners" {
  slug                = "partners"
  title               = "Partner status"
  visibility          = "password"
  password_wo         = var.partner_page_password
  password_wo_version = 2 # bump to send a new password
}
` + "```" + `

The older ` + "`password`" + ` argument still works on older Terraform versions, but it is deprecated because it keeps the
password (sensitive) in state. To migrate, replace ` + "`password = ...`" + ` with ` + "`password_wo = ...`" + ` and
` + "`password_wo_version = 1`" + `. The next apply sends the password once more and removes it from state.

A password changed in the dashboard is not detected either way. ` + "`has_password`" + ` shows whether one is set. Removing the
password arguments keeps the stored hash. Every other attribute, including ` + "`components`" + `, is refreshed on every plan.
`,
	"resource/montral_maintenance_window": `## Updates and drift

The API creates, lists and deletes maintenance windows but does not edit them, so changing any argument replaces the
window. The provider reads each window with ` + "`GET /maintenance/:id`" + `, so ended windows and long series are refreshed
like any other. A window deleted outside Terraform is created again. An older server without that endpoint makes the
provider fall back to the project's list, which is capped at 1000 windows. A window missing from a full list is then kept
in state with a warning instead of being dropped.
Instants are compared as moments: ` + "`2026-12-01T03:00:00+01:00`" + ` and ` + "`2026-12-01T02:00:00Z`" + ` are the same value.
Destroying a recurring window cancels its series: future occurrences are deleted, a running one ends now, and past
ones stay as history.
`,
	"resource/montral_monitor": `## Drift

Every argument is refreshed on each plan: a monitor edited or paused in the dashboard shows as a change, and a deleted
monitor is created again. Request ` + "`headers`" + ` and ` + "`request_body`" + ` are shown by the API only to workspace owners and
admins. With a member's key they are kept from state and out-of-band changes to them are not detected.
` + "`status`" + ` is informational and never causes a diff.
`,
	"resource/montral_project_alerting": `## Lifecycle

A project always has alerting settings. Creating this resource overwrites them, and destroying it resets them to the defaults
(no repeats, no email repeats, no escalation).
`,
}

func TestDocsAreCurrent(t *testing.T) {
	server, err := providerserver.NewProtocol6WithError(New("test")())()
	if err != nil {
		t.Fatal(err)
	}
	resp, err := server.GetProviderSchema(context.Background(), &tfprotov6.GetProviderSchemaRequest{})
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join("..", "..")
	pages := map[string]string{
		filepath.Join("docs", "index.md"): renderProviderPage(t, root, resp.Provider),
	}
	for name, s := range resp.ResourceSchemas {
		pages[filepath.Join("docs", "resources", strings.TrimPrefix(name, "montral_")+".md")] = renderPage(t, root, "resource", name, s)
	}
	for name, s := range resp.DataSourceSchemas {
		pages[filepath.Join("docs", "data-sources", strings.TrimPrefix(name, "montral_")+".md")] = renderPage(t, root, "data-source", name, s)
	}
	update := os.Getenv("MONTRAL_UPDATE_DOCS") == "1"
	for rel, want := range pages {
		full := filepath.Join(root, rel)
		if update {
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(want), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(full)
		if err != nil || strings.ReplaceAll(string(got), "\r\n", "\n") != want {
			t.Errorf("%s is out of date; run MONTRAL_UPDATE_DOCS=1 go test ./internal/provider -run TestDocsAreCurrent", rel)
		}
	}
}

func readExample(t *testing.T, path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimRight(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
}

func renderProviderPage(t *testing.T, root string, s *tfprotov6.Schema) string {
	var b strings.Builder
	b.WriteString("---\npage_title: \"montral Provider\"\nsubcategory: \"\"\ndescription: |-\n  " + firstLine(s.Block.Description) + "\n---\n\n")
	b.WriteString("# montral Provider\n\n" + s.Block.Description + "\n\n")
	b.WriteString("This provider is **unpublished**: build it from source and point Terraform at it with `dev_overrides` (see the [README](../README.md)).\n\n")
	b.WriteString("## Example Usage\n\n```terraform\n" + readExample(t, filepath.Join(root, "examples", "provider", "provider.tf")) + "\n```\n\n")
	b.WriteString(renderSchema(s.Block, ""))
	return b.String()
}

func renderPage(t *testing.T, root, kind, name string, s *tfprotov6.Schema) string {
	title := map[string]string{"resource": "Resource", "data-source": "Data Source"}[kind]
	dir := map[string]string{"resource": "resources", "data-source": "data-sources"}[kind]
	file := map[string]string{"resource": "resource.tf", "data-source": "data-source.tf"}[kind]
	var b strings.Builder
	fmt.Fprintf(&b, "---\npage_title: %q\nsubcategory: \"\"\ndescription: |-\n  %s\n---\n\n", name+" "+title+" - terraform-provider-montral", firstLine(s.Block.Description))
	fmt.Fprintf(&b, "# %s (%s)\n\n%s\n\n", name, title, s.Block.Description)
	if ex := readExample(t, filepath.Join(root, "examples", dir, name, file)); ex != "" {
		b.WriteString("## Example Usage\n\n```terraform\n" + ex + "\n```\n\n")
	}
	b.WriteString(renderSchema(s.Block, ""))
	if note, ok := docNotes[kind+"/"+name]; ok {
		b.WriteString("\n" + note)
	}
	if ex := readExample(t, filepath.Join(root, "examples", dir, name, "import.sh")); ex != "" {
		b.WriteString("\n## Import\n\nImport is supported using the following syntax:\n\n```shell\n" + ex + "\n```\n")
	}
	return b.String()
}

func firstLine(s string) string {
	if i := strings.Index(s, ". "); i > 0 {
		return s[:i+1]
	}
	return s
}

type docAttr struct {
	name string
	attr *tfprotov6.SchemaAttribute
}

func renderSchema(block *tfprotov6.SchemaBlock, nestedPrefix string) string {
	var b strings.Builder
	if nestedPrefix == "" {
		b.WriteString("<!-- schema generated from the provider schema (tfplugindocs format) -->\n## Schema\n")
	}
	groups := map[string][]docAttr{}
	for _, a := range block.Attributes {
		group := "Optional"
		switch {
		case a.Required:
			group = "Required"
		case a.Computed && !a.Optional:
			group = "Read-Only"
		}
		groups[group] = append(groups[group], docAttr{a.Name, a})
	}
	var nested []docAttr
	for _, g := range []string{"Required", "Optional", "Read-Only"} {
		list := groups[g]
		if len(list) == 0 {
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].name < list[j].name })
		b.WriteString("\n### " + g + "\n\n")
		for _, a := range list {
			typ := typeName(a.attr)
			if a.attr.Sensitive {
				typ += ", Sensitive"
			}
			desc := strings.TrimSpace(a.attr.Description)
			link := ""
			if a.attr.NestedType != nil {
				anchor := "nestedatt--" + strings.ReplaceAll(nestedPrefix+a.name, ".", "--")
				link = fmt.Sprintf(" (see [below for nested schema](#%s))", anchor)
				nested = append(nested, a)
			}
			fmt.Fprintf(&b, "- `%s` (%s) %s%s\n", a.name, typ, desc, link)
		}
	}
	for _, a := range nested {
		anchor := "nestedatt--" + strings.ReplaceAll(nestedPrefix+a.name, ".", "--")
		fmt.Fprintf(&b, "\n<a id=%q></a>\n### Nested Schema for `%s`\n", anchor, nestedPrefix+a.name)
		inner := &tfprotov6.SchemaBlock{Attributes: a.attr.NestedType.Attributes}
		b.WriteString(renderSchema(inner, nestedPrefix+a.name+"."))
	}
	return b.String()
}

func typeName(a *tfprotov6.SchemaAttribute) string {
	if a.NestedType != nil {
		switch a.NestedType.Nesting {
		case tfprotov6.SchemaObjectNestingModeList:
			return "Attributes List"
		case tfprotov6.SchemaObjectNestingModeSet:
			return "Attributes Set"
		case tfprotov6.SchemaObjectNestingModeMap:
			return "Attributes Map"
		default:
			return "Attributes"
		}
	}
	return tfTypeName(a.Type)
}

func tfTypeName(t tftypes.Type) string {
	switch {
	case t.Is(tftypes.String):
		return "String"
	case t.Is(tftypes.Number):
		return "Number"
	case t.Is(tftypes.Bool):
		return "Boolean"
	case t.Is(tftypes.List{}):
		return "List of " + tfTypeName(t.(tftypes.List).ElementType)
	case t.Is(tftypes.Set{}):
		return "Set of " + tfTypeName(t.(tftypes.Set).ElementType)
	case t.Is(tftypes.Map{}):
		return "Map of " + tfTypeName(t.(tftypes.Map).ElementType)
	}
	return t.String()
}
