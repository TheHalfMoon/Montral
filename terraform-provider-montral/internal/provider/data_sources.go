package provider

import (
	"context"
	"fmt"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework-validators/datasourcevalidator"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

// ---- montral_project ------------------------------------------------------------------------------------------------

var (
	_ datasource.DataSource                     = &projectDataSource{}
	_ datasource.DataSourceWithConfigValidators = &projectDataSource{}
)

// NewProjectDataSource is the montral_project data source.
func NewProjectDataSource() datasource.DataSource { return &projectDataSource{} }

type projectDataSource struct{ client *client.Client }

type projectDataModel struct {
	ID             types.String `tfsdk:"id"`
	Name           types.String `tfsdk:"name"`
	OrganizationID types.String `tfsdk:"organization_id"`
	CreatedAt      types.String `tfsdk:"created_at"`
}

func (d *projectDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project"
}

func (d *projectDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Looks up a project of the API key's workspace by `id` or by `name`. With neither, returns the provider's project (or the key's default project).",
		Attributes: map[string]schema.Attribute{
			"id":              schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project UUID.", Validators: []validator.String{uuidValidator()}},
			"name":            schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project name (exact match; must be unique among the projects the key can see)."},
			"organization_id": schema.StringAttribute{Computed: true, MarkdownDescription: "Workspace id."},
			"created_at":      schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time (RFC 3339)."},
		},
	}
}

func (d *projectDataSource) ConfigValidators(_ context.Context) []datasource.ConfigValidator {
	return []datasource.ConfigValidator{datasourcevalidator.Conflicting(path.MatchRoot("id"), path.MatchRoot("name"))}
}

func (d *projectDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (d *projectDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m projectDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var list []client.Project
	if err := d.client.Get(ctx, "/projects", "", &list); err != nil {
		apiError(&resp.Diagnostics, "listing projects", err)
		return
	}
	wantID, wantName := m.ID.ValueString(), m.Name.ValueString()
	if wantID == "" && wantName == "" {
		// the project the API resolves for this key and provider configuration
		var me struct {
			ProjectID string `json:"projectId"`
		}
		if err := d.client.Get(ctx, "/me", "", &me); err != nil {
			apiError(&resp.Diagnostics, "reading the current project", err)
			return
		}
		wantID = me.ProjectID
	}
	var found []client.Project
	for _, p := range list {
		if (wantID != "" && p.ID == wantID) || (wantID == "" && p.Name == wantName) {
			found = append(found, p)
		}
	}
	switch len(found) {
	case 0:
		resp.Diagnostics.AddError("Project not found", fmt.Sprintf("no project with %s among the %d projects this API key can see", describe(wantID, wantName), len(list)))
		return
	case 1:
	default:
		resp.Diagnostics.AddError("Ambiguous project name", fmt.Sprintf("%d projects are named %q; look the project up by id instead", len(found), wantName))
		return
	}
	p := found[0]
	m.ID, m.Name = types.StringValue(p.ID), types.StringValue(p.Name)
	m.OrganizationID, m.CreatedAt = types.StringValue(p.OrganizationID), types.StringValue(p.CreatedAt)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}

func describe(id, name string) string {
	if id != "" {
		return "id " + id
	}
	return fmt.Sprintf("name %q", name)
}

// ---- montral_monitor ------------------------------------------------------------------------------------------------

var (
	_ datasource.DataSource                     = &monitorDataSource{}
	_ datasource.DataSourceWithConfigValidators = &monitorDataSource{}
)

// NewMonitorDataSource is the montral_monitor data source.
func NewMonitorDataSource() datasource.DataSource { return &monitorDataSource{} }

type monitorDataSource struct{ client *client.Client }

type monitorDataModel struct {
	ID                types.String `tfsdk:"id"`
	Name              types.String `tfsdk:"name"`
	ProjectID         types.String `tfsdk:"project_id"`
	Type              types.String `tfsdk:"type"`
	Target            types.String `tfsdk:"target"`
	Method            types.String `tfsdk:"method"`
	ExpectedStatus    types.Int64  `tfsdk:"expected_status"`
	IntervalSec       types.Int64  `tfsdk:"interval_sec"`
	TimeoutMs         types.Int64  `tfsdk:"timeout_ms"`
	FailureThreshold  types.Int64  `tfsdk:"failure_threshold"`
	RecoveryThreshold types.Int64  `tfsdk:"recovery_threshold"`
	Regions           types.List   `tfsdk:"regions"`
	ChannelIDs        types.Set    `tfsdk:"channel_ids"`
	Tags              types.List   `tfsdk:"tags"`
	Status            types.String `tfsdk:"status"`
	Paused            types.Bool   `tfsdk:"paused"`
	CreatedAt         types.String `tfsdk:"created_at"`
}

func (d *monitorDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_monitor"
}

func (d *monitorDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	str := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, MarkdownDescription: desc}
	}
	num := func(desc string) schema.Int64Attribute {
		return schema.Int64Attribute{Computed: true, MarkdownDescription: desc}
	}
	resp.Schema = schema.Schema{
		MarkdownDescription: "Looks up one monitor by `id`, or by `name` within a project (`project_id`, else the provider's project). Request headers and bodies are not exposed.",
		Attributes: map[string]schema.Attribute{
			"id":                 schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Monitor UUID.", Validators: []validator.String{uuidValidator()}},
			"name":               schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Monitor name (exact match; must be unique in the project)."},
			"project_id":         schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project to search by name in.", Validators: []validator.String{uuidValidator()}},
			"type":               str("Check protocol."),
			"target":             str("Target."),
			"method":             str("HTTP method."),
			"expected_status":    num("Expected HTTP status."),
			"interval_sec":       num("Seconds between checks."),
			"timeout_ms":         num("Check timeout in milliseconds."),
			"failure_threshold":  num("Consecutive failures before an incident."),
			"recovery_threshold": num("Consecutive successes before recovery."),
			"regions":            schema.ListAttribute{ElementType: types.StringType, Computed: true, MarkdownDescription: "Regions."},
			"channel_ids":        schema.SetAttribute{ElementType: types.StringType, Computed: true, MarkdownDescription: "Alert channels."},
			"tags":               schema.ListAttribute{ElementType: types.StringType, Computed: true, MarkdownDescription: "Tags."},
			"status":             str("Current state."),
			"paused":             schema.BoolAttribute{Computed: true, MarkdownDescription: "Whether checks are paused."},
			"created_at":         str("Creation time (RFC 3339)."),
		},
	}
}

func (d *monitorDataSource) ConfigValidators(_ context.Context) []datasource.ConfigValidator {
	return []datasource.ConfigValidator{datasourcevalidator.ExactlyOneOf(path.MatchRoot("id"), path.MatchRoot("name"))}
}

func (d *monitorDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	d.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (d *monitorDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var m monitorDataModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	project := m.ProjectID.ValueString()
	var mon client.Monitor
	if id := m.ID.ValueString(); id != "" {
		if err := d.client.Get(ctx, "/monitors/"+id, project, &mon); err != nil {
			apiError(&resp.Diagnostics, "reading monitor "+id, err)
			return
		}
	} else {
		var list []client.Monitor
		if err := d.client.Get(ctx, "/monitors", project, &list); err != nil {
			apiError(&resp.Diagnostics, "listing monitors", err)
			return
		}
		var found []client.Monitor
		for _, x := range list {
			if x.Name == m.Name.ValueString() {
				found = append(found, x)
			}
		}
		if len(found) != 1 {
			resp.Diagnostics.AddError("Monitor not found", fmt.Sprintf("expected exactly one monitor named %q in the project, found %d", m.Name.ValueString(), len(found)))
			return
		}
		mon = found[0]
	}
	m.ID, m.Name = types.StringValue(mon.ID), types.StringValue(mon.Name)
	m.ProjectID = strValue(mon.ProjectID)
	m.Type, m.Target, m.Method = types.StringValue(mon.Type), types.StringValue(mon.Target), types.StringValue(mon.Method)
	m.ExpectedStatus, m.IntervalSec, m.TimeoutMs = types.Int64Value(mon.ExpectedStatus), types.Int64Value(mon.IntervalSec), types.Int64Value(mon.TimeoutMs)
	m.FailureThreshold, m.RecoveryThreshold = types.Int64Value(mon.FailureThreshold), types.Int64Value(max(mon.RecoveryThreshold, 1))
	m.Regions, m.Tags = listOf(mon.Regions), listOf(mon.Tags)
	ids := append([]string{}, mon.ChannelIDs...)
	sort.Strings(ids)
	m.ChannelIDs = setOf(ids)
	m.Status, m.Paused, m.CreatedAt = types.StringValue(mon.Status), types.BoolValue(mon.Status == "paused"), types.StringValue(mon.CreatedAt)
	resp.Diagnostics.Append(resp.State.Set(ctx, &m)...)
}
