package provider

import (
	"context"
	"fmt"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &projectAlertingResource{}
	_ resource.ResourceWithImportState    = &projectAlertingResource{}
	_ resource.ResourceWithValidateConfig = &projectAlertingResource{}
)

// NewProjectAlertingResource is the montral_project_alerting resource.
func NewProjectAlertingResource() resource.Resource { return &projectAlertingResource{} }

type projectAlertingResource struct{ client *client.Client }

type projectAlertingModel struct {
	ID                  types.String `tfsdk:"id"`
	ProjectID           types.String `tfsdk:"project_id"`
	ReminderIntervalMin types.Int64  `tfsdk:"reminder_interval_min"`
	ReminderEmail       types.Bool   `tfsdk:"reminder_email"`
	Escalation          types.List   `tfsdk:"escalation"`
}

type escalationModel struct {
	ChannelIDs       types.Set   `tfsdk:"channel_ids"`
	EscalateAfterMin types.Int64 `tfsdk:"escalate_after_min"`
}

var escalationAttrTypes = map[string]attr.Type{"channel_ids": types.SetType{ElemType: types.StringType}, "escalate_after_min": types.Int64Type}

func (r *projectAlertingResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_project_alerting"
}

func (r *projectAlertingResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "Alert repeats and escalation levels of one project (Settings → Alerting). There is one per project: " +
			"creating it takes over the project's settings, and destroying it resets them (no repeats, no email repeats, no escalation). " +
			"Needs a workspace owner's or admin's API key.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "Same as `project_id`.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project_id": schema.StringAttribute{Required: true, MarkdownDescription: "Project UUID.",
				Validators:    []validator.String{uuidValidator()},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"reminder_interval_min": schema.Int64Attribute{Optional: true,
				MarkdownDescription: "Repeat an unacknowledged alert every 5, 10, 15, 30 or 60 minutes (at most 10 repeats); unset = no repeats.",
				Validators:          []validator.Int64{int64validator.OneOf(5, 10, 15, 30, 60)}},
			"reminder_email": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false),
				MarkdownDescription: "Repeats also go to email channels. Default false."},
			"escalation": schema.ListNestedAttribute{Optional: true,
				MarkdownDescription: "Up to 3 ordered levels: each notifies its channels when an incident is still unacknowledged that many minutes after it started. Each level must come later than the one before.",
				Validators:          []validator.List{listvalidator.SizeAtMost(3)},
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"channel_ids": schema.SetAttribute{ElementType: types.StringType, Required: true,
						MarkdownDescription: "1-5 alert channels (workspace channels or this project's).",
						Validators:          []validator.Set{setvalidator.SizeBetween(1, 5), setvalidator.ValueStringsAre(uuidValidator())}},
					"escalate_after_min": schema.Int64Attribute{Required: true, MarkdownDescription: "Minutes after the incident started (1-1440).",
						Validators: []validator.Int64{int64validator.Between(1, 1440)}},
				}},
			},
		},
	}
}

func (r *projectAlertingResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *projectAlertingResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m projectAlertingModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() || m.Escalation.IsNull() || m.Escalation.IsUnknown() {
		return
	}
	var levels []escalationModel
	resp.Diagnostics.Append(m.Escalation.ElementsAs(ctx, &levels, false)...)
	for i := 1; i < len(levels); i++ {
		a, b := levels[i-1].EscalateAfterMin, levels[i].EscalateAfterMin
		if !a.IsUnknown() && !b.IsUnknown() && b.ValueInt64() <= a.ValueInt64() {
			resp.Diagnostics.AddAttributeError(path.Root("escalation").AtListIndex(i).AtName("escalate_after_min"), "Invalid escalation",
				fmt.Sprintf("each escalation level must come later than the one before (%d is not after %d)", b.ValueInt64(), a.ValueInt64()))
		}
	}
}

func (m *projectAlertingModel) toAPI(ctx context.Context, diags *diag.Diagnostics) client.ProjectAlerting {
	out := client.ProjectAlerting{ReminderEmail: m.ReminderEmail.ValueBool(), Escalation: []client.EscalationStep{}}
	if !m.ReminderIntervalMin.IsNull() {
		v := m.ReminderIntervalMin.ValueInt64()
		out.ReminderIntervalMin = &v
	}
	if !m.Escalation.IsNull() && !m.Escalation.IsUnknown() {
		var levels []escalationModel
		diags.Append(m.Escalation.ElementsAs(ctx, &levels, false)...)
		for _, l := range levels {
			out.Escalation = append(out.Escalation, client.EscalationStep{ChannelIDs: stringSet(ctx, l.ChannelIDs, diags), EscalateAfterMin: l.EscalateAfterMin.ValueInt64()})
		}
	}
	return out
}

func (m *projectAlertingModel) fromAPI(project string, api *client.ProjectAlerting) {
	m.ID = types.StringValue(project)
	m.ProjectID = types.StringValue(project)
	if api.ReminderIntervalMin != nil {
		m.ReminderIntervalMin = types.Int64Value(*api.ReminderIntervalMin)
	} else {
		m.ReminderIntervalMin = types.Int64Null()
	}
	m.ReminderEmail = types.BoolValue(api.ReminderEmail)
	if len(api.Escalation) == 0 && m.Escalation.IsNull() {
		return
	}
	elems := make([]attr.Value, 0, len(api.Escalation))
	for _, s := range api.Escalation {
		ids := append([]string{}, s.ChannelIDs...)
		sort.Strings(ids)
		elems = append(elems, types.ObjectValueMust(escalationAttrTypes, map[string]attr.Value{
			"channel_ids":        setOf(ids),
			"escalate_after_min": types.Int64Value(s.EscalateAfterMin),
		}))
	}
	m.Escalation = types.ListValueMust(types.ObjectType{AttrTypes: escalationAttrTypes}, elems)
}

func (r *projectAlertingResource) put(ctx context.Context, m *projectAlertingModel, diags *diag.Diagnostics) {
	project := m.ProjectID.ValueString()
	body := m.toAPI(ctx, diags)
	if diags.HasError() {
		return
	}
	var saved client.ProjectAlerting
	if err := r.client.Put(ctx, "/projects/"+project+"/alerting", project, body, &saved); err != nil {
		apiError(diags, "saving alerting of project "+project, err)
		return
	}
	m.fromAPI(project, &saved)
}

func (r *projectAlertingResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan projectAlertingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *projectAlertingResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state projectAlertingModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	project := state.ProjectID.ValueString()
	if project == "" {
		project = state.ID.ValueString()
		state.ProjectID = state.ID
	}
	var api client.ProjectAlerting
	if err := r.client.Get(ctx, "/projects/"+project+"/alerting", project, &api); err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		apiError(&resp.Diagnostics, "reading alerting of project "+project, err)
		return
	}
	state.fromAPI(project, &api)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *projectAlertingResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan projectAlertingModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *projectAlertingResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state projectAlertingModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	project := state.ProjectID.ValueString()
	reset := client.ProjectAlerting{Escalation: []client.EscalationStep{}}
	if err := r.client.Put(ctx, "/projects/"+project+"/alerting", project, reset, nil); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "resetting alerting of project "+project, err)
	}
}

func (r *projectAlertingResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if !uuidRE.MatchString(req.ID) {
		resp.Diagnostics.AddError("Invalid import ID", "expected the project UUID, got "+req.ID)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), req.ID)...)
}
