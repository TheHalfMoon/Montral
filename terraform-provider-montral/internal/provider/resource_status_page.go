package provider

import (
	"context"
	"fmt"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/float64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/float64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/tfsdk"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &statusPageResource{}
	_ resource.ResourceWithImportState    = &statusPageResource{}
	_ resource.ResourceWithValidateConfig = &statusPageResource{}
)

var (
	slugRE        = regexp.MustCompile(`^[a-z0-9-]{3,40}$`)
	externalURLRE = regexp.MustCompile(`^(?i)https?://\S+$`)
)

// NewStatusPageResource is the montral_status_page resource.
func NewStatusPageResource() resource.Resource { return &statusPageResource{} }

type statusPageResource struct{ client *client.Client }

type statusPageModel struct {
	ID                       types.String  `tfsdk:"id"`
	ProjectID                types.String  `tfsdk:"project_id"`
	Slug                     types.String  `tfsdk:"slug"`
	Title                    types.String  `tfsdk:"title"`
	Theme                    types.String  `tfsdk:"theme"`
	ShowLatency              types.Bool    `tfsdk:"show_latency"`
	ExternalURL              types.String  `tfsdk:"external_url"`
	HideBranding             types.Bool    `tfsdk:"hide_branding"`
	UptimeOkPct              types.Float64 `tfsdk:"uptime_ok_pct"`
	UptimeWarnPct            types.Float64 `tfsdk:"uptime_warn_pct"`
	MCPEnabled               types.Bool    `tfsdk:"mcp_enabled"`
	Visibility               types.String  `tfsdk:"visibility"`
	Password                 types.String  `tfsdk:"password"`
	PasswordWO               types.String  `tfsdk:"password_wo"`
	PasswordWOVersion        types.Int64   `tfsdk:"password_wo_version"`
	HasPassword              types.Bool    `tfsdk:"has_password"`
	MaintenanceReminderHours types.Int64   `tfsdk:"maintenance_reminder_hours"`
	Components               types.List    `tfsdk:"components"`
	URL                      types.String  `tfsdk:"url"`
	CreatedAt                types.String  `tfsdk:"created_at"`
}

type componentModel struct {
	MonitorID types.String `tfsdk:"monitor_id"`
	GroupName types.String `tfsdk:"group_name"`
}

var componentAttrTypes = map[string]attr.Type{"monitor_id": types.StringType, "group_name": types.StringType}

func (r *statusPageResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_status_page"
}

func (r *statusPageResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A public (or members-only, or password-protected) Montral status page showing monitors as ordered, " +
			"optionally grouped components. Changing `slug` or `project_id` replaces the page.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "Status page UUID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project_id": schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project UUID; defaults to the provider's project.",
				Validators:    []validator.String{uuidValidator()},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured(), stringplanmodifier.UseStateForUnknown()}},
			"slug": schema.StringAttribute{Required: true, MarkdownDescription: "URL slug (3-40 lowercase letters, digits or hyphens), unique on the deployment: the page is served at `/status/<slug>`. Changing it replaces the page.",
				Validators:    []validator.String{stringvalidator.RegexMatches(slugRE, "must be 3-40 lowercase letters, digits or hyphens")},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"title": schema.StringAttribute{Required: true, MarkdownDescription: "Page title (1-120 characters).",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 120)}},
			"theme": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("light"),
				MarkdownDescription: "`light` (default), `dark` or `auto`.",
				Validators:          []validator.String{stringvalidator.OneOf("light", "dark", "auto")}},
			"show_latency": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true),
				MarkdownDescription: "Show response times. Default true."},
			"external_url": schema.StringAttribute{Optional: true, MarkdownDescription: "Website the page header links to (http or https).",
				Validators: []validator.String{stringvalidator.LengthAtMost(2048), stringvalidator.RegexMatches(externalURLRE, "must be an http(s) URL")}},
			"hide_branding": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false),
				MarkdownDescription: "Hide Montral's name and mark (where the plan allows it). Default false."},
			"uptime_ok_pct": schema.Float64Attribute{Optional: true, Computed: true,
				MarkdownDescription: "Uptime bars are green at or above this percentage (1-100). Montral's default is 99.9; when the argument is removed the current value is kept.",
				PlanModifiers:       []planmodifier.Float64{float64planmodifier.UseStateForUnknown()},
				Validators:          []validator.Float64{float64validator.Between(1, 100)}},
			"uptime_warn_pct": schema.Float64Attribute{Optional: true, Computed: true,
				MarkdownDescription: "Uptime bars are amber at or above this percentage (1-100, below `uptime_ok_pct`), red below. Montral's default is 98; when the argument is removed the current value is kept.",
				PlanModifiers:       []planmodifier.Float64{float64planmodifier.UseStateForUnknown()},
				Validators:          []validator.Float64{float64validator.Between(1, 100)}},
			"mcp_enabled": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true),
				MarkdownDescription: "Let the public MCP tools serve this page. Default true."},
			"visibility": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("public"),
				MarkdownDescription: "`public` (default), `members` (signed-in workspace members only) or `password` (members, or anyone with `password` or a share link).",
				Validators:          []validator.String{stringvalidator.OneOf("public", "members", "password")}},
			"password_wo": schema.StringAttribute{Optional: true, Sensitive: true, WriteOnly: true,
				MarkdownDescription: "Page password (8-200 characters) for `visibility = \"password\"`, write-only: it is never stored in the plan or state (Terraform 1.11+ / OpenTofu 1.11+). It is sent on create and whenever `password_wo_version` changes. Changing it signs every outside visitor out.",
				Validators: []validator.String{stringvalidator.LengthBetween(8, 200),
					stringvalidator.AlsoRequires(path.MatchRoot("password_wo_version")), stringvalidator.ConflictsWith(path.MatchRoot("password"))}},
			"password_wo_version": schema.Int64Attribute{Optional: true,
				MarkdownDescription: "Any number that you change to send `password_wo` again: Terraform cannot compare a write-only value, so this is the trigger for rotating the password.",
				Validators:          []validator.Int64{int64validator.AlsoRequires(path.MatchRoot("password_wo"))}},
			"password": schema.StringAttribute{Optional: true, Sensitive: true,
				DeprecationMessage:  "password is kept (sensitive) in state; use password_wo with password_wo_version (Terraform 1.11+), which never stores it. Migrate by replacing password = X with password_wo = X and password_wo_version = 1.",
				MarkdownDescription: "**Deprecated**: use `password_wo`. Page password (8-200 characters), kept (sensitive) in state and sent when it changes. Works on Terraform versions without write-only attributes.",
				Validators:          []validator.String{stringvalidator.LengthBetween(8, 200)}},
			"has_password": schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether Montral holds a password for the page."},
			"maintenance_reminder_hours": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(24),
				MarkdownDescription: "Hours (0-168) before maintenance starts that subscribers are reminded; 0 = never. Default 24.",
				Validators:          []validator.Int64{int64validator.Between(0, 168)}},
			"components": schema.ListNestedAttribute{Optional: true,
				MarkdownDescription: "Monitors shown on the page, in order (at most 200). Monitors must belong to the page's project.",
				Validators:          []validator.List{listvalidator.SizeAtMost(200)},
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"monitor_id": schema.StringAttribute{Required: true, MarkdownDescription: "Monitor UUID.", Validators: []validator.String{uuidValidator()}},
					"group_name": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("Services"),
						MarkdownDescription: "Group heading (1-60 characters, no surrounding spaces); consecutive components with the same group are shown together. Default `Services`, as in Montral.",
						Validators:          []validator.String{stringvalidator.LengthBetween(1, 60), stringvalidator.RegexMatches(regexp.MustCompile(`^\S(.*\S)?$`), "must not have surrounding spaces")}},
				}},
			},
			"url": schema.StringAttribute{Computed: true, MarkdownDescription: "Public address of the page (`<endpoint>/status/<slug>`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"created_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
		},
	}
}

func (r *statusPageResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *statusPageResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m statusPageModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if m.Visibility.ValueString() == "password" && m.Password.IsNull() && m.PasswordWO.IsNull() {
		resp.Diagnostics.AddAttributeError(path.Root("password_wo"), "Invalid status page configuration", `a page with visibility = "password" needs a password (password_wo)`)
	}
	ok, warn := 99.9, 98.0
	if !m.UptimeOkPct.IsNull() && !m.UptimeOkPct.IsUnknown() {
		ok = m.UptimeOkPct.ValueFloat64()
	}
	if !m.UptimeWarnPct.IsNull() && !m.UptimeWarnPct.IsUnknown() {
		warn = m.UptimeWarnPct.ValueFloat64()
	}
	if !m.UptimeOkPct.IsUnknown() && !m.UptimeWarnPct.IsUnknown() && warn >= ok {
		resp.Diagnostics.AddAttributeError(path.Root("uptime_warn_pct"), "Invalid status page configuration",
			fmt.Sprintf("the amber threshold (uptime_warn_pct = %g) must be below the green one (uptime_ok_pct = %g)", warn, ok))
	}
}

func (m *statusPageModel) components(ctx context.Context, diags *diag.Diagnostics) []client.StatusPageComponent {
	out := []client.StatusPageComponent{}
	if m.Components.IsNull() || m.Components.IsUnknown() {
		return out
	}
	var comps []componentModel
	diags.Append(m.Components.ElementsAs(ctx, &comps, false)...)
	for _, c := range comps {
		out = append(out, client.StatusPageComponent{MonitorID: c.MonitorID.ValueString(), GroupName: strPtr(c.GroupName)})
	}
	return out
}

func boolPtr(v types.Bool) *bool {
	b := v.ValueBool()
	return &b
}

func (m *statusPageModel) write(ctx context.Context, diags *diag.Diagnostics) client.StatusPageWrite {
	hours := m.MaintenanceReminderHours.ValueInt64()
	return client.StatusPageWrite{
		Title:                    m.Title.ValueString(),
		Theme:                    m.Theme.ValueString(),
		ShowLatency:              boolPtr(m.ShowLatency),
		ExternalURL:              strPtr(m.ExternalURL),
		HideBranding:             boolPtr(m.HideBranding),
		UptimeOkPct:              float64Ptr(m.UptimeOkPct),
		UptimeWarnPct:            float64Ptr(m.UptimeWarnPct),
		MCPEnabled:               boolPtr(m.MCPEnabled),
		Visibility:               m.Visibility.ValueString(),
		MaintenanceReminderHours: &hours,
		Components:               m.components(ctx, diags),
	}
}

func (m *statusPageModel) fromAPI(api *client.StatusPage, baseURL string) {
	m.ID = types.StringValue(api.ID)
	m.ProjectID = strValue(api.ProjectID)
	m.Slug = types.StringValue(api.Slug)
	m.Title = types.StringValue(api.Title)
	m.Theme = types.StringValue(api.Theme)
	m.ShowLatency = types.BoolValue(api.ShowLatency)
	m.ExternalURL = strValue(api.ExternalURL)
	m.HideBranding = types.BoolValue(api.HideBranding)
	m.UptimeOkPct = sameFloat(m.UptimeOkPct, api.UptimeOkPct)
	m.UptimeWarnPct = sameFloat(m.UptimeWarnPct, api.UptimeWarnPct)
	m.MCPEnabled = types.BoolValue(api.MCPEnabled)
	m.Visibility = types.StringValue(api.Visibility)
	m.HasPassword = types.BoolValue(api.HasPassword)
	m.MaintenanceReminderHours = types.Int64Value(api.MaintenanceReminderHours)
	// the password itself is never returned: m.Password (deprecated) keeps what configuration/state holds, and the
	// write-only password_wo never reaches state
	m.PasswordWO = types.StringNull()
	if len(api.Components) == 0 && m.Components.IsNull() {
		// no components and none configured: stay null rather than an empty list
	} else {
		elems := make([]attr.Value, 0, len(api.Components))
		for _, c := range api.Components {
			elems = append(elems, types.ObjectValueMust(componentAttrTypes, map[string]attr.Value{
				"monitor_id": types.StringValue(c.MonitorID),
				"group_name": strValue(c.GroupName),
			}))
		}
		m.Components = types.ListValueMust(types.ObjectType{AttrTypes: componentAttrTypes}, elems)
	}
	m.URL = types.StringValue(baseURL + "/status/" + api.Slug)
	m.CreatedAt = types.StringValue(api.CreatedAt)
}

func (r *statusPageResource) get(ctx context.Context, id, project string) (*client.StatusPage, error) {
	var page client.StatusPage
	if err := r.client.Get(ctx, "/status-pages/"+id, project, &page); err != nil {
		return nil, err
	}
	return &page, nil
}

func (r *statusPageResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan statusPageModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := plan.write(ctx, &resp.Diagnostics)
	body.Slug = plan.Slug.ValueString()
	body.Password = plan.Password.ValueString()
	if wo := r.writeOnlyPassword(ctx, req.Config, &resp.Diagnostics); wo != "" {
		body.Password = wo
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.StatusPage
	project := plan.ProjectID.ValueString()
	if err := r.client.Post(ctx, "/status-pages", project, body, &created); err != nil {
		apiError(&resp.Diagnostics, "creating status page", err)
		return
	}
	page, err := r.get(ctx, created.ID, derefOr(created.ProjectID, project))
	if err != nil {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), created.ID)...)
		apiError(&resp.Diagnostics, "reading new status page "+created.ID, err)
		return
	}
	plan.fromAPI(page, r.client.BaseURL())
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *statusPageResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state statusPageModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	page, err := r.get(ctx, state.ID.ValueString(), state.ProjectID.ValueString())
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		apiError(&resp.Diagnostics, "reading status page "+state.ID.ValueString(), err)
		return
	}
	state.fromAPI(page, r.client.BaseURL())
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *statusPageResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state statusPageModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	project := state.ProjectID.ValueString()
	body := plan.write(ctx, &resp.Diagnostics)
	// a password is sent only when it changed: every new password signs outside visitors out
	if !plan.Password.IsNull() && !plan.Password.Equal(state.Password) {
		body.Password = plan.Password.ValueString()
	}
	// the write-only password cannot be compared: its version is the trigger
	if !plan.PasswordWOVersion.IsNull() && !plan.PasswordWOVersion.Equal(state.PasswordWOVersion) {
		if wo := r.writeOnlyPassword(ctx, req.Config, &resp.Diagnostics); wo != "" {
			body.Password = wo
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Patch(ctx, "/status-pages/"+id, project, body, nil); err != nil {
		apiError(&resp.Diagnostics, "updating status page "+id, err)
		return
	}
	page, err := r.get(ctx, id, project)
	if err != nil {
		apiError(&resp.Diagnostics, "reading status page "+id, err)
		return
	}
	plan.fromAPI(page, r.client.BaseURL())
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *statusPageResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state statusPageModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Delete(ctx, "/status-pages/"+state.ID.ValueString(), state.ProjectID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "deleting status page "+state.ID.ValueString(), err)
	}
}

func (r *statusPageResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithProject(ctx, req, resp)
}

// float64Ptr is nil (the field is left out: server default on create, unchanged on update) for an unknown value.
func float64Ptr(v types.Float64) *float64 {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	f := v.ValueFloat64()
	return &f
}

// sameFloat keeps the configured value when the API returns the same float64: a configured 99.9 is an exact decimal,
// the API's is the nearest float64, and Terraform would otherwise report an inconsistent result.
func sameFloat(prior types.Float64, api float64) types.Float64 {
	if !prior.IsNull() && !prior.IsUnknown() && prior.ValueFloat64() == api {
		return prior
	}
	return types.Float64Value(api)
}

// writeOnlyPassword reads password_wo from the configuration: the only place a write-only value exists.
func (r *statusPageResource) writeOnlyPassword(ctx context.Context, config tfsdk.Config, diags *diag.Diagnostics) string {
	var wo types.String
	diags.Append(config.GetAttribute(ctx, path.Root("password_wo"), &wo)...)
	if wo.IsNull() || wo.IsUnknown() {
		return ""
	}
	return wo.ValueString()
}
