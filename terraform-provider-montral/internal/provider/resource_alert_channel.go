package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &alertChannelResource{}
	_ resource.ResourceWithImportState    = &alertChannelResource{}
	_ resource.ResourceWithValidateConfig = &alertChannelResource{}
)

// NewAlertChannelResource is the montral_alert_channel resource.
func NewAlertChannelResource() resource.Resource { return &alertChannelResource{} }

type alertChannelResource struct{ client *client.Client }

type alertChannelModel struct {
	ID           types.String `tfsdk:"id"`
	ProjectID    types.String `tfsdk:"project_id"`
	Scope        types.String `tfsdk:"scope"`
	Type         types.String `tfsdk:"type"`
	Name         types.String `tfsdk:"name"`
	Enabled      types.Bool   `tfsdk:"enabled"`
	AutoEnable   types.Bool   `tfsdk:"auto_enable"`
	Config       types.Map    `tfsdk:"config"`
	SecretConfig types.Map    `tfsdk:"secret_config"`
	CreatedAt    types.String `tfsdk:"created_at"`
}

func (r *alertChannelResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_channel"
}

func (r *alertChannelResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	emptyMap := types.MapValueMust(types.StringType, nil)
	resp.Schema = schema.Schema{
		MarkdownDescription: "A Montral alert channel (email, Slack, Discord, Teams, webhook, PagerDuty, Telegram, ntfy, Gotify, " +
			"Pushover, Google Chat, Mattermost, Lark or push). Credentials go in the sensitive `secret_config`; everything else " +
			"in `config`. Changing `type`, `scope` or `project_id` replaces the channel.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "Channel UUID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"scope": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("workspace"),
				MarkdownDescription: "`workspace` (default): shared by every project of the workspace. `project`: only the project in `project_id` (or the provider's project). A key limited to projects can create `project` channels only.",
				Validators:          []validator.String{stringvalidator.OneOf("workspace", "project")},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"project_id": schema.StringAttribute{Optional: true, Computed: true,
				MarkdownDescription: "Project of a `project`-scoped channel; null for workspace channels.",
				Validators:          []validator.String{uuidValidator()},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured(), stringplanmodifier.UseStateForUnknown()}},
			"type": schema.StringAttribute{Required: true,
				MarkdownDescription: "Channel type: `" + strings.Join(channelTypeNames(), "`, `") + "`. `push` needs APNs configured on the server.",
				Validators:          []validator.String{stringvalidator.OneOf(channelTypeNames()...)},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Display name (1-80 characters).",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 80)}},
			"enabled": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true),
				MarkdownDescription: "Whether alerts are delivered. Default true."},
			"auto_enable": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false),
				MarkdownDescription: "New monitors of the project start out alerting this channel. Default false."},
			"config": schema.MapAttribute{ElementType: types.StringType, Optional: true, Computed: true, Default: mapdefault.StaticValue(emptyMap),
				MarkdownDescription: "Non-secret settings: `to` (email), `chatId` (telegram), `priority` (ntfy, \"1\"-\"5\", default \"3\"), `device` (pushover)."},
			"secret_config": schema.MapAttribute{ElementType: types.StringType, Optional: true, Computed: true, Sensitive: true, Default: mapdefault.StaticValue(emptyMap),
				MarkdownDescription: "Credentials: `url` (slack, discord, teams, webhook, googlechat, mattermost, lark, ntfy, gotify), `secret` (lark), `botToken` (telegram), `routingKey` (pagerduty), `token` (ntfy, gotify, pushover), `topic` (ntfy), `userKey` (pushover). " +
					"Montral returns them only to workspace owners and admins; with any other key they are write-only and kept from state, so out-of-band changes to them cannot be detected."},
			"created_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
		},
	}
}

func (r *alertChannelResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// knownMap is the map's values, or nil when the map or any value is not known yet. A null map is empty.
func knownMap(ctx context.Context, v types.Map) map[string]string {
	if v.IsUnknown() {
		return nil
	}
	out := map[string]string{}
	if v.IsNull() {
		return out
	}
	for k, e := range v.Elements() {
		s, ok := e.(types.String)
		if !ok || s.IsUnknown() {
			return nil
		}
		out[k] = s.ValueString()
	}
	return out
}

func (r *alertChannelResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m alertChannelModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() || m.Type.IsUnknown() || m.Type.IsNull() {
		return
	}
	if !m.ProjectID.IsNull() && !m.Scope.IsUnknown() && m.Scope.ValueString() != "project" {
		resp.Diagnostics.AddAttributeError(path.Root("project_id"), "Invalid alert channel configuration",
			`project_id applies to project-scoped channels only; set scope = "project" (workspace channels belong to no project)`)
	}
	for _, p := range channelProblems(m.Type.ValueString(), knownMap(ctx, m.Config), knownMap(ctx, m.SecretConfig)) {
		resp.Diagnostics.AddAttributeError(path.Root(p.Attribute), "Invalid alert channel configuration", p.Message)
	}
}

func (m *alertChannelModel) settings(ctx context.Context, diags *diag.Diagnostics) map[string]string {
	all := stringMap(ctx, m.Config, diags)
	for k, v := range stringMap(ctx, m.SecretConfig, diags) {
		all[k] = v
	}
	return all
}

func (m *alertChannelModel) fromAPI(ctx context.Context, api *client.Channel, prior *alertChannelModel, diags *diag.Diagnostics) {
	m.ID = types.StringValue(api.ID)
	m.ProjectID = strValue(api.ProjectID)
	if api.ProjectID != nil {
		m.Scope = types.StringValue("project")
	} else {
		m.Scope = types.StringValue("workspace")
	}
	m.Type = types.StringValue(api.Type)
	m.Name = types.StringValue(api.Name)
	m.Enabled = types.BoolValue(api.Enabled)
	m.AutoEnable = types.BoolValue(api.AutoEnable)
	var priorPlain, priorSecret map[string]string
	if prior != nil {
		priorPlain = stringMap(ctx, prior.Config, diags)
		priorSecret = stringMap(ctx, prior.SecretConfig, diags)
	}
	plain, secret := splitChannelConfig(api.Type, api.Config, priorPlain, priorSecret)
	m.Config = mapOf(plain)
	m.SecretConfig = mapOf(secret)
	m.CreatedAt = types.StringValue(api.CreatedAt)
}

// find reads one channel through the list endpoint (the API has no single-channel GET); nil when it is gone.
func (r *alertChannelResource) find(ctx context.Context, id, project string) (*client.Channel, error) {
	var list []client.Channel
	if err := r.client.Get(ctx, "/channels", project, &list); err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], nil
		}
	}
	return nil, nil
}

func (r *alertChannelResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertChannelModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"type":       plan.Type.ValueString(),
		"name":       plan.Name.ValueString(),
		"enabled":    plan.Enabled.ValueBool(),
		"autoEnable": plan.AutoEnable.ValueBool(),
		"scope":      plan.Scope.ValueString(),
		"config":     plan.settings(ctx, &resp.Diagnostics),
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.Channel
	project := plan.ProjectID.ValueString()
	if err := r.client.Post(ctx, "/channels", project, body, &created); err != nil {
		apiError(&resp.Diagnostics, "creating alert channel", err)
		return
	}
	prior := plan
	plan.fromAPI(ctx, &created, &prior, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	if prior.Scope.ValueString() == "workspace" && created.ProjectID != nil {
		resp.Diagnostics.AddError("Alert channel created in a project",
			"This API key is limited to specific projects, so Montral created the channel in project "+*created.ProjectID+
				` instead of the whole workspace. Set scope = "project" to match.`)
	}
}

func (r *alertChannelResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertChannelModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	ch, err := r.find(ctx, state.ID.ValueString(), state.ProjectID.ValueString())
	if err != nil {
		apiError(&resp.Diagnostics, "reading alert channel "+state.ID.ValueString(), err)
		return
	}
	if ch == nil {
		resp.State.RemoveResource(ctx)
		return
	}
	prior := state
	state.fromAPI(ctx, ch, &prior, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *alertChannelResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state alertChannelModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	body := map[string]any{
		"name":       plan.Name.ValueString(),
		"enabled":    plan.Enabled.ValueBool(),
		"autoEnable": plan.AutoEnable.ValueBool(),
		"config":     plan.settings(ctx, &resp.Diagnostics),
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var updated client.Channel
	if err := r.client.Patch(ctx, "/channels/"+id, state.ProjectID.ValueString(), body, &updated); err != nil {
		if client.IsNotFound(err) {
			resp.Diagnostics.AddError("Alert channel disappeared", fmt.Sprintf("alert channel %s was deleted outside Terraform; run terraform apply again to recreate it", id))
			return
		}
		apiError(&resp.Diagnostics, "updating alert channel "+id, err)
		return
	}
	prior := plan
	plan.fromAPI(ctx, &updated, &prior, &resp.Diagnostics)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *alertChannelResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state alertChannelModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Delete(ctx, "/channels/"+state.ID.ValueString(), state.ProjectID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "deleting alert channel "+state.ID.ValueString(), err)
	}
}

func (r *alertChannelResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithProject(ctx, req, resp)
}
