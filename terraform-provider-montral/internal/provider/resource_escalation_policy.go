package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &escalationPolicyResource{}
	_ resource.ResourceWithImportState    = &escalationPolicyResource{}
	_ resource.ResourceWithValidateConfig = &escalationPolicyResource{}
)

// NewEscalationPolicyResource is the montral_escalation_policy resource.
func NewEscalationPolicyResource() resource.Resource { return &escalationPolicyResource{} }

type escalationPolicyResource struct{ client *client.Client }

type escalationPolicyModel struct {
	ID          types.String `tfsdk:"id"`
	ProjectID   types.String `tfsdk:"project_id"`
	Name        types.String `tfsdk:"name"`
	RepeatCount types.Int64  `tfsdk:"repeat_count"`
	Steps       types.List   `tfsdk:"steps"`
	Version     types.Int64  `tfsdk:"version"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

type policyStepModel struct {
	TimeoutMin  types.Int64 `tfsdk:"timeout_min"`
	ChannelIDs  types.Set   `tfsdk:"channel_ids"`
	UserIDs     types.Set   `tfsdk:"user_ids"`
	ScheduleIDs types.Set   `tfsdk:"schedule_ids"`
}

var policyStepAttrTypes = map[string]attr.Type{
	"timeout_min":  types.Int64Type,
	"channel_ids":  types.SetType{ElemType: types.StringType},
	"user_ids":     types.SetType{ElemType: types.StringType},
	"schedule_ids": types.SetType{ElemType: types.StringType},
}

// wire format of apps/api/src/routes/oncall.ts
type apiPolicyStep struct {
	TimeoutMin  int64    `json:"timeoutMin"`
	ChannelIDs  []string `json:"channelIds"`
	UserIDs     []string `json:"userIds"`
	ScheduleIDs []string `json:"scheduleIds"`
}

type apiPolicy struct {
	ID          string          `json:"id"`
	ProjectID   *string         `json:"projectId"`
	Name        string          `json:"name"`
	Steps       []apiPolicyStep `json:"steps"`
	RepeatCount int64           `json:"repeatCount"`
	Version     int64           `json:"version"`
	CreatedAt   string          `json:"createdAt"`
}

var trimmedNameRE = regexp.MustCompile(`^\S(.*\S)?$`)

func (r *escalationPolicyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_escalation_policy"
}

func (r *escalationPolicyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	emptySet := setOf(nil)
	resp.Schema = schema.Schema{
		MarkdownDescription: "An escalation policy: ordered steps that notify alert channels, people and whoever is on call on a schedule, " +
			"each waiting `timeout_min` minutes for an acknowledgement before the next. Monitors use it through " +
			"`montral_monitor.escalation_policy_id`. Needs a workspace owner's or admin's API key. Edits use Montral's " +
			"optimistic concurrency (`version`): a policy changed by someone else since the last refresh is refused, and the next " +
			"plan shows the difference.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "Policy UUID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project_id": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Project the policy belongs to; unset = workspace-wide (usable by every project). Unlike other resources it does not default to the provider's project. A key limited to projects must set it. Changing it replaces the policy.",
				Validators:          []validator.String{uuidValidator()},
				PlanModifiers:       []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Name (1-80 characters, no surrounding spaces).",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 80), stringvalidator.RegexMatches(trimmedNameRE, "must not have surrounding spaces")}},
			"repeat_count": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				MarkdownDescription: "How many more times the steps run after the last one while nobody acknowledges (0-5). Default 0 (once).",
				Validators:          []validator.Int64{int64validator.Between(0, 5)}},
			"steps": schema.ListNestedAttribute{Required: true,
				MarkdownDescription: "1-10 ordered steps. Each needs at least one channel, person or schedule.",
				Validators:          []validator.List{listvalidator.SizeBetween(1, 10)},
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"timeout_min": schema.Int64Attribute{Required: true, MarkdownDescription: "Minutes (1-1440) to wait for an acknowledgement before the next step.",
						Validators: []validator.Int64{int64validator.Between(1, 1440)}},
					"channel_ids": schema.SetAttribute{ElementType: types.StringType, Optional: true, Computed: true, Default: setdefault.StaticValue(emptySet),
						MarkdownDescription: "Alert channels to notify (at most 10): workspace channels or the policy's project's.",
						Validators:          []validator.Set{setvalidator.SizeAtMost(10), setvalidator.ValueStringsAre(uuidValidator())}},
					"user_ids": schema.SetAttribute{ElementType: types.StringType, Optional: true, Computed: true, Default: setdefault.StaticValue(emptySet),
						MarkdownDescription: "Workspace members to notify directly (at most 20 user ids).",
						Validators:          []validator.Set{setvalidator.SizeAtMost(20), setvalidator.ValueStringsAre(stringvalidator.LengthBetween(1, 200))}},
					"schedule_ids": schema.SetAttribute{ElementType: types.StringType, Optional: true, Computed: true, Default: setdefault.StaticValue(emptySet),
						MarkdownDescription: "On-call schedules whose current on-call person is notified (at most 5).",
						Validators:          []validator.Set{setvalidator.SizeAtMost(5), setvalidator.ValueStringsAre(uuidValidator())}},
				}},
			},
			"version": schema.Int64Attribute{Computed: true, MarkdownDescription: "Montral's revision of the policy, bumped by every change; sent with updates and deletes."},
			"created_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
		},
	}
}

func (r *escalationPolicyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func (r *escalationPolicyResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m escalationPolicyModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() || m.Steps.IsNull() || m.Steps.IsUnknown() {
		return
	}
	var steps []policyStepModel
	resp.Diagnostics.Append(m.Steps.ElementsAs(ctx, &steps, false)...)
	for i, s := range steps {
		known, empty := true, true
		for _, set := range []types.Set{s.ChannelIDs, s.UserIDs, s.ScheduleIDs} {
			if set.IsUnknown() {
				known = false
			} else if !set.IsNull() && len(set.Elements()) > 0 {
				empty = false
			}
		}
		if known && empty {
			resp.Diagnostics.AddAttributeError(path.Root("steps").AtListIndex(i), "Invalid escalation policy",
				"each step needs at least one channel, person or schedule")
		}
	}
}

func (m *escalationPolicyModel) apiSteps(ctx context.Context, diags *diag.Diagnostics) []apiPolicyStep {
	var steps []policyStepModel
	diags.Append(m.Steps.ElementsAs(ctx, &steps, false)...)
	out := make([]apiPolicyStep, 0, len(steps))
	for _, s := range steps {
		out = append(out, apiPolicyStep{
			TimeoutMin:  s.TimeoutMin.ValueInt64(),
			ChannelIDs:  stringSet(ctx, s.ChannelIDs, diags),
			UserIDs:     stringSet(ctx, s.UserIDs, diags),
			ScheduleIDs: stringSet(ctx, s.ScheduleIDs, diags),
		})
	}
	return out
}

func sortedSet(values []string) types.Set {
	v := append([]string{}, values...)
	sort.Strings(v)
	return setOf(v)
}

func (m *escalationPolicyModel) fromAPI(p *apiPolicy) {
	m.ID = types.StringValue(p.ID)
	m.ProjectID = strValue(p.ProjectID)
	m.Name = types.StringValue(p.Name)
	m.RepeatCount = types.Int64Value(p.RepeatCount)
	m.Version = types.Int64Value(p.Version)
	m.CreatedAt = types.StringValue(p.CreatedAt)
	elems := make([]attr.Value, 0, len(p.Steps))
	for _, s := range p.Steps {
		elems = append(elems, types.ObjectValueMust(policyStepAttrTypes, map[string]attr.Value{
			"timeout_min":  types.Int64Value(s.TimeoutMin),
			"channel_ids":  sortedSet(s.ChannelIDs),
			"user_ids":     sortedSet(s.UserIDs),
			"schedule_ids": sortedSet(s.ScheduleIDs),
		}))
	}
	m.Steps = types.ListValueMust(types.ObjectType{AttrTypes: policyStepAttrTypes}, elems)
}

func (r *escalationPolicyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan escalationPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := map[string]any{
		"name":        plan.Name.ValueString(),
		"projectId":   strPtr(plan.ProjectID),
		"steps":       plan.apiSteps(ctx, &resp.Diagnostics),
		"repeatCount": plan.RepeatCount.ValueInt64(),
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var created apiPolicy
	// the header only picks the credential's project context; the policy's own project is in the body
	if err := r.client.Post(ctx, "/escalation-policies", plan.ProjectID.ValueString(), body, &created); err != nil {
		apiError(&resp.Diagnostics, "creating escalation policy", err)
		return
	}
	plan.fromAPI(&created)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *escalationPolicyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state escalationPolicyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	var p apiPolicy
	if err := r.client.Get(ctx, "/escalation-policies/"+state.ID.ValueString(), state.ProjectID.ValueString(), &p); err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		apiError(&resp.Diagnostics, "reading escalation policy "+state.ID.ValueString(), err)
		return
	}
	state.fromAPI(&p)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *escalationPolicyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state escalationPolicyModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	body := map[string]any{
		// the version read at refresh: a change made since then is refused (409 version_conflict), never overwritten
		"version":     state.Version.ValueInt64(),
		"name":        plan.Name.ValueString(),
		"steps":       plan.apiSteps(ctx, &resp.Diagnostics),
		"repeatCount": plan.RepeatCount.ValueInt64(),
	}
	if resp.Diagnostics.HasError() {
		return
	}
	var updated apiPolicy
	if err := r.client.Patch(ctx, "/escalation-policies/"+id, state.ProjectID.ValueString(), body, &updated); err != nil {
		apiError(&resp.Diagnostics, "updating escalation policy "+id, err)
		return
	}
	plan.fromAPI(&updated)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *escalationPolicyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state escalationPolicyModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	target := "/escalation-policies/" + state.ID.ValueString()
	if !state.Version.IsNull() && !state.Version.IsUnknown() {
		target += "?version=" + strconv.FormatInt(state.Version.ValueInt64(), 10)
	}
	if err := r.client.Delete(ctx, target, state.ProjectID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, fmt.Sprintf("deleting escalation policy %s", state.ID.ValueString()), err)
	}
}

func (r *escalationPolicyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if !uuidRE.MatchString(req.ID) {
		resp.Diagnostics.AddError("Invalid import ID", "expected the escalation policy UUID, got "+req.ID)
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}
