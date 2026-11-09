// Package provider implements the Montral Terraform provider with the Terraform Plugin Framework.
package provider

import (
	"context"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-log/tflog"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var _ provider.Provider = &montralProvider{}

type montralProvider struct {
	version string
}

// New returns the provider factory used by main and by the acceptance tests.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &montralProvider{version: version} }
}

type providerModel struct {
	Endpoint     types.String `tfsdk:"endpoint"`
	APIKey       types.String `tfsdk:"api_key"`
	ProjectID    types.String `tfsdk:"project_id"`
	InsecureHTTP types.Bool   `tfsdk:"insecure_http"`
}

func (p *montralProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "montral"
	resp.Version = p.version
}

func (p *montralProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Manages monitors, alert channels, status pages, maintenance windows and project escalation of a " +
			"[Montral](https://github.com/TheHalfMoon/Montral) deployment through its REST API, authenticated with an API key.",
		Attributes: map[string]schema.Attribute{
			"endpoint": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Base URL of the Montral deployment, such as `https://montral.example.com`. May also be set with the `MONTRAL_ENDPOINT` environment variable. TLS certificates are always verified.",
			},
			"api_key": schema.StringAttribute{
				Optional:            true,
				Sensitive:           true,
				MarkdownDescription: "Montral API key (`montral_...`), created under Settings → API keys. May also be set with the `MONTRAL_API_KEY` environment variable. The key's workspace (and project limit, if any) decides what the provider can reach.",
			},
			"project_id": schema.StringAttribute{
				Optional:            true,
				MarkdownDescription: "Default project UUID for resources that do not set their own `project_id`. May also be set with `MONTRAL_PROJECT_ID`. Without it, the key's first project (or the workspace's default project) is used.",
				Validators:          []validatorString{uuidValidator()},
			},
			"insecure_http": schema.BoolAttribute{
				Optional:            true,
				MarkdownDescription: "Allow a plain `http://` endpoint on a host other than `localhost`, `127.0.0.1` or `::1`. Off by default: over plain HTTP the API key and every secret the provider sends cross the network unencrypted. Use only on a trusted private network.",
			},
		},
	}
}

func (p *montralProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var cfg providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for attr, v := range map[string]types.String{"endpoint": cfg.Endpoint, "api_key": cfg.APIKey, "project_id": cfg.ProjectID} {
		if v.IsUnknown() {
			resp.Diagnostics.AddAttributeError(path.Root(attr), "Unknown provider configuration",
				"The provider cannot be configured with a value known only after apply. Set "+attr+" statically or through its environment variable.")
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	endpoint := firstNonEmpty(cfg.Endpoint.ValueString(), os.Getenv("MONTRAL_ENDPOINT"))
	apiKey := firstNonEmpty(cfg.APIKey.ValueString(), os.Getenv("MONTRAL_API_KEY"))
	projectID := firstNonEmpty(cfg.ProjectID.ValueString(), os.Getenv("MONTRAL_PROJECT_ID"))
	if endpoint == "" {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Missing Montral endpoint", "Set endpoint in the provider block or the MONTRAL_ENDPOINT environment variable.")
	}
	if apiKey == "" {
		resp.Diagnostics.AddAttributeError(path.Root("api_key"), "Missing Montral API key", "Set api_key in the provider block or the MONTRAL_API_KEY environment variable.")
	}
	if projectID != "" && !uuidRE.MatchString(projectID) {
		resp.Diagnostics.AddAttributeError(path.Root("project_id"), "Invalid project_id", "project_id (or MONTRAL_PROJECT_ID) must be a project UUID.")
	}
	if resp.Diagnostics.HasError() {
		return
	}
	c, err := client.New(client.Options{
		Endpoint:          endpoint,
		APIKey:            apiKey,
		ProjectID:         projectID,
		UserAgent:         "terraform-provider-montral/" + p.version,
		AllowInsecureHTTP: cfg.InsecureHTTP.ValueBool(),
	})
	if err != nil {
		resp.Diagnostics.AddAttributeError(path.Root("endpoint"), "Invalid Montral provider configuration", err.Error())
		return
	}
	// the key is never logged: only where requests go
	tflog.Debug(ctx, "configured Montral client", map[string]any{"endpoint": c.BaseURL(), "project_id": projectID})
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *montralProvider) Resources(_ context.Context) []func() resource.Resource {
	return []func() resource.Resource{
		NewMonitorResource,
		NewAlertChannelResource,
		NewStatusPageResource,
		NewMaintenanceWindowResource,
		NewProjectAlertingResource,
		NewEscalationPolicyResource,
	}
}

func (p *montralProvider) DataSources(_ context.Context) []func() datasource.DataSource {
	return []func() datasource.DataSource{
		NewMonitorDataSource,
		NewProjectDataSource,
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
