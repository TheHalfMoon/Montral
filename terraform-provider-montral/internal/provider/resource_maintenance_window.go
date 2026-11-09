package provider

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/objectplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &maintenanceWindowResource{}
	_ resource.ResourceWithImportState    = &maintenanceWindowResource{}
	_ resource.ResourceWithValidateConfig = &maintenanceWindowResource{}
)

// NewMaintenanceWindowResource is the montral_maintenance_window resource.
func NewMaintenanceWindowResource() resource.Resource { return &maintenanceWindowResource{} }

type maintenanceWindowResource struct{ client *client.Client }

type maintenanceWindowModel struct {
	ID         types.String `tfsdk:"id"`
	ProjectID  types.String `tfsdk:"project_id"`
	Name       types.String `tfsdk:"name"`
	StartsAt   types.String `tfsdk:"starts_at"`
	EndsAt     types.String `tfsdk:"ends_at"`
	MonitorIDs types.Set    `tfsdk:"monitor_ids"`
	Recurrence types.Object `tfsdk:"recurrence"`
	SeriesID   types.String `tfsdk:"series_id"`
}

type recurrenceModel struct {
	Frequency types.String `tfsdk:"frequency"`
	TimeZone  types.String `tfsdk:"time_zone"`
	Until     types.String `tfsdk:"until"`
}

var recurrenceAttrTypes = map[string]attr.Type{"frequency": types.StringType, "time_zone": types.StringType, "until": types.StringType}

func (r *maintenanceWindowResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_maintenance_window"
}

func (r *maintenanceWindowResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A scheduled maintenance window: monitors in it open no incidents and send no alerts, and status pages " +
			"announce it. Montral's API creates and deletes windows but does not edit them, so every change replaces the window. " +
			"A recurring window is a bounded daily or weekly series; destroying it cancels the whole series.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "UUID of the window (for a series, its first occurrence).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project_id": schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project UUID; defaults to the provider's project.",
				Validators:    []validator.String{uuidValidator()},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured(), stringplanmodifier.UseStateForUnknown()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Name shown in the dashboard, on status pages and in reminders (1-120 characters).",
				Validators:    []validator.String{stringvalidator.LengthBetween(1, 120)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"starts_at": schema.StringAttribute{Required: true, MarkdownDescription: "Start, RFC 3339 with offset (`2026-12-01T02:00:00Z`).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"ends_at": schema.StringAttribute{Required: true, MarkdownDescription: "End, RFC 3339 with offset, after `starts_at`. For a series it fixes each occurrence's duration (at most 24 hours).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"monitor_ids": schema.SetAttribute{ElementType: types.StringType, Optional: true, Computed: true,
				Default:             setdefault.StaticValue(setOf(nil)),
				MarkdownDescription: "Monitors of this project covered by the window (at most 500); empty (default) covers every monitor of the project.",
				Validators:          []validator.Set{setvalidator.SizeAtMost(500), setvalidator.ValueStringsAre(uuidValidator())},
				PlanModifiers:       []planmodifier.Set{setplanmodifier.RequiresReplace()}},
			"recurrence": schema.SingleNestedAttribute{Optional: true,
				MarkdownDescription: "Repeat the window daily or weekly at the first start's local time, until `until` (within 366 days of `starts_at`).",
				PlanModifiers:       []planmodifier.Object{objectplanmodifier.RequiresReplace()},
				Attributes: map[string]schema.Attribute{
					"frequency": schema.StringAttribute{Required: true, MarkdownDescription: "`daily` or `weekly`.",
						Validators: []validator.String{stringvalidator.OneOf("daily", "weekly")}},
					"time_zone": schema.StringAttribute{Required: true, MarkdownDescription: "IANA time zone such as `America/Toronto`, or `UTC`.",
						Validators: []validator.String{stringvalidator.LengthBetween(1, 100)}},
					"until": schema.StringAttribute{Required: true, MarkdownDescription: "Last allowed start (inclusive), RFC 3339 with offset."},
				}},
			"series_id": schema.StringAttribute{Computed: true, MarkdownDescription: "Series UUID of a recurring window.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
		},
	}
}

func (r *maintenanceWindowResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

// maintenanceProblems mirrors maintenanceCreateSchema in apps/api/src/routes/maintenance.ts. Empty strings are unknown.
func maintenanceProblems(startsAt, endsAt string, rec *recurrenceModel) []problem {
	var out []problem
	var start, end time.Time
	var errS, errE error = errUnknown, errUnknown
	if startsAt != "" {
		if start, errS = parseInstant(startsAt); errS != nil {
			out = append(out, problem{"starts_at", "must be an RFC 3339 instant with a UTC offset, such as 2026-12-01T02:00:00Z"})
		}
	}
	if endsAt != "" {
		if end, errE = parseInstant(endsAt); errE != nil {
			out = append(out, problem{"ends_at", "must be an RFC 3339 instant with a UTC offset, such as 2026-12-01T04:00:00Z"})
		}
	}
	both := errS == nil && errE == nil
	if both && !end.After(start) {
		out = append(out, problem{"ends_at", "the end must be after the start"})
	}
	if rec == nil {
		return out
	}
	if both && end.Sub(start) > 24*time.Hour {
		out = append(out, problem{"ends_at", "a recurring window may last at most 24 hours"})
	}
	if tz := rec.TimeZone; !tz.IsNull() && !tz.IsUnknown() {
		name := tz.ValueString()
		if _, err := time.LoadLocation(name); err != nil || name == "" || name == "Local" || (name != "UTC" && !strings.Contains(name, "/")) {
			out = append(out, problem{"recurrence", "time_zone must be an IANA time zone such as America/Toronto, or UTC"})
		}
	}
	if u := rec.Until; !u.IsNull() && !u.IsUnknown() {
		until, err := parseInstant(u.ValueString())
		switch {
		case err != nil:
			out = append(out, problem{"recurrence", "until must be an RFC 3339 instant with a UTC offset"})
		case errS == nil && (until.Before(start) || until.Sub(start) > 366*24*time.Hour):
			out = append(out, problem{"recurrence", "until must be within 366 days after starts_at"})
		}
	}
	return out
}

type unknownError struct{}

func (unknownError) Error() string { return "unknown" }

var errUnknown error = unknownError{}

func (r *maintenanceWindowResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m maintenanceWindowModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var rec *recurrenceModel
	if !m.Recurrence.IsNull() && !m.Recurrence.IsUnknown() {
		rec = &recurrenceModel{}
		resp.Diagnostics.Append(m.Recurrence.As(ctx, rec, objectAsOptions)...)
	}
	known := func(v types.String) string {
		if v.IsNull() || v.IsUnknown() {
			return ""
		}
		return v.ValueString()
	}
	for _, p := range maintenanceProblems(known(m.StartsAt), known(m.EndsAt), rec) {
		resp.Diagnostics.AddAttributeError(path.Root(p.Attribute), "Invalid maintenance window configuration", p.Message)
	}
}

func (m *maintenanceWindowModel) fromAPI(api *client.MaintenanceWindow) {
	m.ID = types.StringValue(api.ID)
	m.ProjectID = strValue(api.ProjectID)
	m.Name = types.StringValue(api.Name)
	m.StartsAt = sameInstant(m.StartsAt, api.StartsAt)
	m.EndsAt = sameInstant(m.EndsAt, api.EndsAt)
	m.MonitorIDs = setOf(api.MonitorIDs)
	m.SeriesID = strValue(api.SeriesID)
	if api.Recurrence == nil {
		m.Recurrence = types.ObjectNull(recurrenceAttrTypes)
		return
	}
	until := types.StringValue(api.Recurrence.Until)
	if !m.Recurrence.IsNull() && !m.Recurrence.IsUnknown() {
		if prev, ok := m.Recurrence.Attributes()["until"].(types.String); ok {
			until = sameInstant(prev, api.Recurrence.Until)
		}
	}
	m.Recurrence = types.ObjectValueMust(recurrenceAttrTypes, map[string]attr.Value{
		"frequency": types.StringValue(api.Recurrence.Frequency),
		"time_zone": types.StringValue(api.Recurrence.TimeZone),
		"until":     until,
	})
}

// maintenanceListCap is how many windows GET /maintenance returns at most (active and upcoming first, ended last).
const maintenanceListCap = 1000

// lookup is the outcome of reading one window.
type lookup int

const (
	found   lookup = iota
	gone           // the API says the window does not exist
	unknown        // it could not be told (an older server without GET /maintenance/:id, and a full list)
)

// find reads one window with GET /maintenance/:id. Servers from before that endpoint answer a plain-text 404 for it;
// the provider then falls back to the project's list, which is capped, so absence from a full list proves nothing.
func (r *maintenanceWindowResource) find(ctx context.Context, id, project string) (*client.MaintenanceWindow, lookup, error) {
	var w client.MaintenanceWindow
	err := r.client.Get(ctx, "/maintenance/"+id, project, &w)
	switch {
	case err == nil:
		return &w, found, nil
	case client.IsRouteMissing(err):
		// fall through to the list
	case client.IsNotFound(err):
		return nil, gone, nil
	default:
		return nil, unknown, err
	}
	var list []client.MaintenanceWindow
	if err := r.client.Get(ctx, "/maintenance", project, &list); err != nil {
		return nil, unknown, err
	}
	for i := range list {
		if list[i].ID == id {
			return &list[i], found, nil
		}
	}
	if len(list) >= maintenanceListCap {
		return nil, unknown, nil
	}
	return nil, gone, nil
}

func (r *maintenanceWindowResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan maintenanceWindowModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.MaintenanceWindow{
		Name:       plan.Name.ValueString(),
		StartsAt:   plan.StartsAt.ValueString(),
		EndsAt:     plan.EndsAt.ValueString(),
		MonitorIDs: stringSet(ctx, plan.MonitorIDs, &resp.Diagnostics),
	}
	if !plan.Recurrence.IsNull() && !plan.Recurrence.IsUnknown() {
		var rec recurrenceModel
		resp.Diagnostics.Append(plan.Recurrence.As(ctx, &rec, objectAsOptions)...)
		body.Recurrence = &client.MaintenanceRecurrence{Frequency: rec.Frequency.ValueString(), TimeZone: rec.TimeZone.ValueString(), Until: rec.Until.ValueString()}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.MaintenanceWindow
	if err := r.client.Post(ctx, "/maintenance", plan.ProjectID.ValueString(), body, &created); err != nil {
		apiError(&resp.Diagnostics, "creating maintenance window", err)
		return
	}
	plan.fromAPI(&created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *maintenanceWindowResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state maintenanceWindowModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	w, outcome, err := r.find(ctx, state.ID.ValueString(), state.ProjectID.ValueString())
	if err != nil {
		apiError(&resp.Diagnostics, "reading maintenance window "+state.ID.ValueString(), err)
		return
	}
	switch outcome {
	case gone:
		resp.State.RemoveResource(ctx)
		return
	case unknown:
		// never drop a window from state on an inconclusive answer: keep it and say why
		resp.Diagnostics.AddWarning("Maintenance window not refreshed",
			fmt.Sprintf("Window %s is not among the %d windows this Montral server lists, and the server has no GET /maintenance/:id to ask directly (upgrade it). The window is kept in state unchanged.", state.ID.ValueString(), maintenanceListCap))
		resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
		return
	}
	state.fromAPI(w)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update is never called with a change (every attribute replaces), but the framework requires it.
func (r *maintenanceWindowResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan maintenanceWindowModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *maintenanceWindowResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state maintenanceWindowModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	target := "/maintenance/" + state.ID.ValueString()
	if !state.SeriesID.IsNull() && state.SeriesID.ValueString() != "" {
		target = "/maintenance/series/" + state.SeriesID.ValueString()
	}
	if err := r.client.Delete(ctx, target, state.ProjectID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "deleting maintenance window "+state.ID.ValueString(), err)
	}
}

func (r *maintenanceWindowResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithProject(ctx, req, resp)
}
