package provider

import (
	"context"
	"sort"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/listvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/mapvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/setvalidator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

var (
	_ resource.Resource                   = &monitorResource{}
	_ resource.ResourceWithImportState    = &monitorResource{}
	_ resource.ResourceWithValidateConfig = &monitorResource{}
)

// NewMonitorResource is the montral_monitor resource.
func NewMonitorResource() resource.Resource { return &monitorResource{} }

type monitorResource struct{ client *client.Client }

type monitorModel struct {
	ID                   types.String `tfsdk:"id"`
	ProjectID            types.String `tfsdk:"project_id"`
	Name                 types.String `tfsdk:"name"`
	Type                 types.String `tfsdk:"type"`
	Target               types.String `tfsdk:"target"`
	Method               types.String `tfsdk:"method"`
	RequestBody          types.String `tfsdk:"request_body"`
	Headers              types.Map    `tfsdk:"headers"`
	ExpectedStatus       types.Int64  `tfsdk:"expected_status"`
	ExpectedLocation     types.String `tfsdk:"expected_location"`
	IntervalSec          types.Int64  `tfsdk:"interval_sec"`
	TimeoutMs            types.Int64  `tfsdk:"timeout_ms"`
	FailureThreshold     types.Int64  `tfsdk:"failure_threshold"`
	RecoveryThreshold    types.Int64  `tfsdk:"recovery_threshold"`
	Regions              types.List   `tfsdk:"regions"`
	MinRegionsFailing    types.Int64  `tfsdk:"min_regions_failing"`
	Keyword              types.String `tfsdk:"keyword"`
	KeywordMode          types.String `tfsdk:"keyword_mode"`
	JSONPath             types.String `tfsdk:"json_path"`
	JSONExpected         types.String `tfsdk:"json_expected"`
	JSONMatch            types.String `tfsdk:"json_match"`
	WSMessage            types.String `tfsdk:"ws_message"`
	DNSRecordType        types.String `tfsdk:"dns_record_type"`
	DNSExpectedValue     types.String `tfsdk:"dns_expected_value"`
	DNSMatchMode         types.String `tfsdk:"dns_match_mode"`
	DomainExpiryWarnDays types.Int64  `tfsdk:"domain_expiry_warn_days"`
	GraceSec             types.Int64  `tfsdk:"grace_sec"`
	ChannelIDs           types.Set    `tfsdk:"channel_ids"`
	Tags                 types.List   `tfsdk:"tags"`
	SlowThresholdMs      types.Int64  `tfsdk:"slow_threshold_ms"`
	SlowAlertAfter       types.Int64  `tfsdk:"slow_alert_after"`
	DependsOnMonitorID   types.String `tfsdk:"depends_on_monitor_id"`
	EscalationPolicyID   types.String `tfsdk:"escalation_policy_id"`
	Paused               types.Bool   `tfsdk:"paused"`
	Status               types.String `tfsdk:"status"`
	HeartbeatToken       types.String `tfsdk:"heartbeat_token"`
	HeartbeatURL         types.String `tfsdk:"heartbeat_url"`
	CreatedAt            types.String `tfsdk:"created_at"`
}

func (r *monitorResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_monitor"
}

func nonEmpty() validator.String { return stringvalidator.LengthAtLeast(1) }

func (r *monitorResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		MarkdownDescription: "A Montral monitor: an HTTP(S) check (optionally with a keyword or JSON assertion), TCP, DNS, " +
			"heartbeat, ping, TLS certificate, domain expiry, WebSocket, PostgreSQL, MySQL or Redis check. Changing `type` " +
			"or `project_id` replaces the monitor.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{Computed: true, MarkdownDescription: "Monitor UUID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"project_id": schema.StringAttribute{Optional: true, Computed: true, MarkdownDescription: "Project UUID; defaults to the provider's project. Changing it replaces the monitor.",
				Validators:    []validator.String{uuidValidator()},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplaceIfConfigured(), stringplanmodifier.UseStateForUnknown()}},
			"name": schema.StringAttribute{Required: true, MarkdownDescription: "Display name (1-120 characters).",
				Validators: []validator.String{stringvalidator.LengthBetween(1, 120)}},
			"type": schema.StringAttribute{Required: true, MarkdownDescription: "Check protocol: `" + strings.Join(monitorTypes, "`, `") + "`. Keyword and JSON checks are `http` monitors with `keyword` or `json_path`. `ping` and `certificate` need the self-hosted Node runtime. Changing it replaces the monitor.",
				Validators:    []validator.String{stringvalidator.OneOf(monitorTypes...)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()}},
			"target": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString(""),
				MarkdownDescription: "http: absolute http(s) URL; websocket: ws(s):// URL; tcp: host:port; dns and ping: hostname; certificate: host or host:port; domain: registered domain; postgres/mysql/redis: connection URL; heartbeat: leave unset. Private addresses are refused unless the server sets `ALLOW_PRIVATE_TARGETS=true`.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2048)}},
			"method": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("GET"),
				MarkdownDescription: "HTTP method (`" + strings.Join(httpMethods, "`, `") + "`). Default `GET`.",
				Validators:          []validator.String{stringvalidator.OneOf(httpMethods...)}},
			"request_body": schema.StringAttribute{Optional: true, Sensitive: true,
				MarkdownDescription: "HTTP request body (up to 16384 bytes); not with GET or HEAD. Set Content-Type in `headers`.",
				Validators:          []validator.String{nonEmpty()}},
			"headers": schema.MapAttribute{ElementType: types.StringType, Optional: true, Computed: true, Sensitive: true,
				Default:             mapdefault.StaticValue(types.MapValueMust(types.StringType, nil)),
				MarkdownDescription: "HTTP (or WebSocket handshake) request headers. Sensitive: they often carry tokens.",
				Validators: []validator.Map{
					mapvalidator.KeysAre(stringvalidator.LengthBetween(1, 100)),
					mapvalidator.ValueStringsAre(stringvalidator.LengthAtMost(2000)),
				}},
			"expected_status": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(200),
				MarkdownDescription: "HTTP status that counts as healthy (100-599). An expected 3xx is checked without following the redirect. Default 200.",
				Validators:          []validator.Int64{int64validator.Between(100, 599)}},
			"expected_location": schema.StringAttribute{Optional: true,
				MarkdownDescription: "For an expected 3xx: the Location (full http(s) URL or a path starting with `/`) the redirect must point to.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(2048), stringvalidator.RegexMatches(locationRE, "must be a full http(s) URL or a path starting with /")}},
			"interval_sec": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(60),
				MarkdownDescription: "Seconds between checks (60-86400), or the expected heartbeat period. domain and certificate monitors: 3600-86400. Default 60.",
				Validators:          []validator.Int64{int64validator.Between(60, 86400)}},
			"timeout_ms": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(10000),
				MarkdownDescription: "Check timeout in milliseconds (1000-30000). Default 10000.",
				Validators:          []validator.Int64{int64validator.Between(1000, 30000)}},
			"failure_threshold": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(3),
				MarkdownDescription: "Consecutive failed checks before an incident opens and alerts escalate (1-10). Default 3.",
				Validators:          []validator.Int64{int64validator.Between(1, 10)}},
			"recovery_threshold": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(1),
				MarkdownDescription: "Consecutive successful checks before recovering (1-10). Default 1.",
				Validators:          []validator.Int64{int64validator.Between(1, 10)}},
			"regions": schema.ListAttribute{ElementType: types.StringType, Optional: true, Computed: true,
				Default:             listdefault.StaticValue(listOf([]string{"auto"})),
				MarkdownDescription: "Region ids to check from; `auto` (default) uses this deployment. Explicit regions need configured probes and work for http, tcp and websocket only.",
				Validators: []validator.List{listvalidator.SizeAtLeast(1), listvalidator.UniqueValues(),
					listvalidator.ValueStringsAre(stringvalidator.RegexMatches(regionRE, "must be a region id"))}},
			"min_regions_failing": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				MarkdownDescription: "Failed regions needed to mark a multi-region monitor down (0-20); 0 = a majority. Default 0.",
				Validators:          []validator.Int64{int64validator.Between(0, 20)}},
			"keyword": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Text the HTTP body (or the first WebSocket message) must contain, or must not contain with `keyword_mode = \"absent\"`.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(500)}},
			"keyword_mode": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("contains"),
				MarkdownDescription: "`contains` (default) or `absent`.",
				Validators:          []validator.String{stringvalidator.OneOf("contains", "absent")}},
			"json_path": schema.StringAttribute{Optional: true,
				MarkdownDescription: "HTTP only: path of one value in a JSON body, such as `status`, `$.data.items[0].state` or `[\"key with space\"]`.",
				Validators:          []validator.String{nonEmpty(), stringvalidator.LengthAtMost(200)}},
			"json_expected": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Text the value at `json_path` must equal or contain; required unless `json_match = \"exists\"`.",
				Validators:          []validator.String{stringvalidator.LengthAtMost(500)}},
			"json_match": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("equals"),
				MarkdownDescription: "`equals` (default), `contains` or `exists`.",
				Validators:          []validator.String{stringvalidator.OneOf("equals", "contains", "exists")}},
			"ws_message": schema.StringAttribute{Optional: true,
				MarkdownDescription: "WebSocket only: text sent after the handshake; a reply must arrive within the timeout.",
				Validators:          []validator.String{nonEmpty(), stringvalidator.LengthAtMost(2000)}},
			"dns_record_type": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("A"),
				MarkdownDescription: "DNS monitors: record type (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`). Default `A`.",
				Validators:          []validator.String{stringvalidator.OneOf("A", "AAAA", "CNAME", "MX", "TXT", "NS")}},
			"dns_expected_value": schema.StringAttribute{Optional: true,
				MarkdownDescription: "DNS monitors: an answer that must be present.",
				Validators:          []validator.String{nonEmpty(), stringvalidator.LengthAtMost(2000)}},
			"dns_match_mode": schema.StringAttribute{Optional: true, Computed: true, Default: stringdefault.StaticString("exact"),
				MarkdownDescription: "DNS monitors: `exact` (default) or `contains`.",
				Validators:          []validator.String{stringvalidator.OneOf("exact", "contains")}},
			"domain_expiry_warn_days": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(30),
				MarkdownDescription: "domain and certificate monitors: fail this many days (1-365) before expiry. Default 30.",
				Validators:          []validator.Int64{int64validator.Between(1, 365)}},
			"grace_sec": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				MarkdownDescription: "Heartbeat monitors: extra seconds (0-86400) after a deadline before a ping counts as missed. Default 0.",
				Validators:          []validator.Int64{int64validator.Between(0, 86400)}},
			"channel_ids": schema.SetAttribute{ElementType: types.StringType, Optional: true, Computed: true,
				MarkdownDescription: "Alert channel UUIDs this monitor notifies. Unset: Montral's choice (auto-enabled channels on creation) is kept and refreshed. Set: exactly these channels, auto-enabled ones included only if listed.",
				Validators:          []validator.Set{setvalidator.SizeAtMost(50), setvalidator.ValueStringsAre(uuidValidator())},
				PlanModifiers:       []planmodifier.Set{setplanmodifier.UseStateForUnknown()}},
			"tags": schema.ListAttribute{ElementType: types.StringType, Optional: true, Computed: true,
				Default:             listdefault.StaticValue(listOf(nil)),
				MarkdownDescription: "Dashboard labels (at most 20, each 1-32 characters without surrounding spaces).",
				Validators: []validator.List{listvalidator.SizeAtMost(20),
					listvalidator.ValueStringsAre(stringvalidator.RegexMatches(tagRE, "must be 1-32 characters without leading or trailing spaces"))}},
			"slow_threshold_ms": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(1500),
				MarkdownDescription: "Latency (100-60000 ms) above which a successful check counts as slow. Default 1500.",
				Validators:          []validator.Int64{int64validator.Between(100, 60000)}},
			"slow_alert_after": schema.Int64Attribute{Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				MarkdownDescription: "Consecutive slow checks (0-20) before a slow-response alert; 0 disables them. Default 0.",
				Validators:          []validator.Int64{int64validator.Between(0, 20)}},
			"depends_on_monitor_id": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Parent monitor UUID in the same project; while it is down this monitor opens no incidents.",
				Validators:          []validator.String{uuidValidator()}},
			"escalation_policy_id": schema.StringAttribute{Optional: true,
				MarkdownDescription: "Escalation policy (`montral_escalation_policy`, workspace-wide or this project's) that unacknowledged incidents follow instead of the project's escalation levels.",
				Validators:          []validator.String{uuidValidator()}},
			"paused": schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(false),
				MarkdownDescription: "Pause checks and alerts. Default false."},
			"status": schema.StringAttribute{Computed: true, MarkdownDescription: "Current state (`pending`, `up`, `down`, `paused`, ...). Informational; refreshed on every read."},
			"heartbeat_token": schema.StringAttribute{Computed: true, Sensitive: true, MarkdownDescription: "Heartbeat monitors: the secret token of the ping URL.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"heartbeat_url": schema.StringAttribute{Computed: true, Sensitive: true, MarkdownDescription: "Heartbeat monitors: the URL your job calls (GET or POST).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
			"created_at": schema.StringAttribute{Computed: true, MarkdownDescription: "Creation time (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()}},
		},
	}
}

func (r *monitorResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	r.client = clientFrom(req.ProviderData, &resp.Diagnostics)
}

func knownStr(v types.String) *string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	s := v.ValueString()
	return &s
}

func (r *monitorResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var m monitorModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	spec := monitorSpec{
		Type:           knownStr(m.Type),
		Target:         knownStr(m.Target),
		TargetUnknown:  m.Target.IsUnknown(),
		Method:         knownStr(m.Method),
		RequestBody:    knownStr(m.RequestBody),
		JSONPath:       knownStr(m.JSONPath),
		JSONExpected:   knownStr(m.JSONExpected),
		JSONExpUnknown: m.JSONExpected.IsUnknown(),
		JSONMatch:      knownStr(m.JSONMatch),
		RegionsUnknown: m.Regions.IsUnknown(),
		DNSConfigured:  !m.DNSRecordType.IsNull() || !m.DNSExpectedValue.IsNull() || !m.DNSMatchMode.IsNull(),
	}
	if m.Type.IsUnknown() {
		return
	}
	if !m.Regions.IsNull() && !m.Regions.IsUnknown() {
		spec.Regions = stringList(ctx, m.Regions, &resp.Diagnostics)
	}
	if !m.IntervalSec.IsNull() && !m.IntervalSec.IsUnknown() {
		v := m.IntervalSec.ValueInt64()
		spec.IntervalSec = &v
	} else if m.IntervalSec.IsNull() && spec.Type != nil && expiryTypes[*spec.Type] {
		v := int64(60) // the default would be out of range
		spec.IntervalSec = &v
	}
	for _, p := range spec.problems() {
		resp.Diagnostics.AddAttributeError(path.Root(p.Attribute), "Invalid monitor configuration", p.Message)
	}
}

// body is the JSON the API takes on create (withType) and update.
func (m *monitorModel) body(ctx context.Context, diags *diag.Diagnostics, withType bool) map[string]any {
	b := map[string]any{
		"name":                 m.Name.ValueString(),
		"target":               m.Target.ValueString(),
		"method":               m.Method.ValueString(),
		"requestBody":          strPtr(m.RequestBody),
		"headers":              stringMap(ctx, m.Headers, diags),
		"expectedStatus":       m.ExpectedStatus.ValueInt64(),
		"expectedLocation":     strPtr(m.ExpectedLocation),
		"intervalSec":          m.IntervalSec.ValueInt64(),
		"timeoutMs":            m.TimeoutMs.ValueInt64(),
		"failureThreshold":     m.FailureThreshold.ValueInt64(),
		"recoveryThreshold":    m.RecoveryThreshold.ValueInt64(),
		"regions":              stringList(ctx, m.Regions, diags),
		"minRegionsFailing":    m.MinRegionsFailing.ValueInt64(),
		"keyword":              strPtr(m.Keyword),
		"keywordMode":          m.KeywordMode.ValueString(),
		"jsonPath":             strPtr(m.JSONPath),
		"jsonExpected":         strPtr(m.JSONExpected),
		"jsonMatch":            m.JSONMatch.ValueString(),
		"wsMessage":            strPtr(m.WSMessage),
		"dnsRecordType":        m.DNSRecordType.ValueString(),
		"dnsExpectedValue":     strPtr(m.DNSExpectedValue),
		"dnsMatchMode":         m.DNSMatchMode.ValueString(),
		"domainExpiryWarnDays": m.DomainExpiryWarnDays.ValueInt64(),
		"graceSec":             m.GraceSec.ValueInt64(),
		"tags":                 stringList(ctx, m.Tags, diags),
		"slowThresholdMs":      m.SlowThresholdMs.ValueInt64(),
		"slowAlertAfter":       m.SlowAlertAfter.ValueInt64(),
		"dependsOnMonitorId":   strPtr(m.DependsOnMonitorID),
		"escalationPolicyId":   strPtr(m.EscalationPolicyID),
	}
	if withType {
		b["type"] = m.Type.ValueString()
	}
	if !m.ChannelIDs.IsNull() && !m.ChannelIDs.IsUnknown() {
		b["channelIds"] = stringSet(ctx, m.ChannelIDs, diags)
	}
	return b
}

// fromAPI copies the API's view into the model. prior is the state (or plan) the values are compared against: masked
// secrets keep their prior value, because Montral shows them only to workspace owners and admins.
func (m *monitorModel) fromAPI(api *client.Monitor, prior *monitorModel, baseURL string, ctx context.Context, diags *diag.Diagnostics) {
	m.ID = types.StringValue(api.ID)
	m.ProjectID = strValue(api.ProjectID)
	m.Name = types.StringValue(api.Name)
	m.Type = types.StringValue(api.Type)
	m.Target = types.StringValue(api.Target)
	m.Method = types.StringValue(api.Method)
	m.RequestBody = strValue(api.RequestBody)
	if api.RequestBody != nil && *api.RequestBody == client.Mask && prior != nil {
		m.RequestBody = prior.RequestBody
	}
	if api.RequestBody != nil && *api.RequestBody == "" {
		m.RequestBody = types.StringNull() // the API treats "" as no body
	}
	headers := map[string]string{}
	var priorHeaders map[string]string
	if prior != nil {
		priorHeaders = stringMap(ctx, prior.Headers, diags)
	}
	for k, v := range api.Headers {
		if v == client.Mask {
			if pv, ok := priorHeaders[k]; ok {
				headers[k] = pv
			}
			continue
		}
		headers[k] = v
	}
	m.Headers = mapOf(headers)
	m.ExpectedStatus = types.Int64Value(api.ExpectedStatus)
	m.ExpectedLocation = strValue(api.ExpectedLocation)
	m.IntervalSec = types.Int64Value(api.IntervalSec)
	m.TimeoutMs = types.Int64Value(api.TimeoutMs)
	m.FailureThreshold = types.Int64Value(api.FailureThreshold)
	recovery := api.RecoveryThreshold
	if recovery == 0 {
		recovery = 1
	}
	m.RecoveryThreshold = types.Int64Value(recovery)
	m.Regions = listOf(api.Regions)
	m.MinRegionsFailing = types.Int64Value(api.MinRegionsFailing)
	m.Keyword = strValue(api.Keyword)
	m.KeywordMode = types.StringValue(orDefault(api.KeywordMode, "contains"))
	m.JSONPath = strValue(api.JSONPath)
	m.JSONExpected = strValue(api.JSONExpected)
	m.JSONMatch = types.StringValue(orDefault(api.JSONMatch, "equals"))
	m.WSMessage = strValue(api.WSMessage)
	m.DNSRecordType = types.StringValue(orDefault(api.DNSRecordType, "A"))
	m.DNSExpectedValue = strValue(api.DNSExpectedValue)
	m.DNSMatchMode = types.StringValue(orDefault(api.DNSMatchMode, "exact"))
	warn := api.DomainExpiryWarnDays
	if warn == 0 {
		warn = 30
	}
	m.DomainExpiryWarnDays = types.Int64Value(warn)
	m.GraceSec = types.Int64Value(api.GraceSec)
	channels := append([]string{}, api.ChannelIDs...)
	sort.Strings(channels)
	m.ChannelIDs = setOf(channels)
	m.Tags = listOf(api.Tags)
	m.SlowThresholdMs = types.Int64Value(api.SlowThresholdMs)
	m.SlowAlertAfter = types.Int64Value(api.SlowAlertAfter)
	m.DependsOnMonitorID = strValue(api.DependsOnMonitorID)
	m.EscalationPolicyID = strValue(api.EscalationPolicyID)
	m.Paused = types.BoolValue(api.Status == "paused")
	m.Status = types.StringValue(api.Status)
	m.HeartbeatToken = strValue(api.HeartbeatToken)
	if api.HeartbeatToken != nil && *api.HeartbeatToken != "" {
		m.HeartbeatURL = types.StringValue(baseURL + "/api/heartbeat/" + *api.HeartbeatToken)
	} else {
		m.HeartbeatURL = types.StringNull()
	}
	m.CreatedAt = types.StringValue(api.CreatedAt)
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func (r *monitorResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan monitorModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	project := plan.ProjectID.ValueString()
	body := plan.body(ctx, &resp.Diagnostics, true)
	if resp.Diagnostics.HasError() {
		return
	}
	var created client.Monitor
	if err := r.client.Post(ctx, "/monitors", project, body, &created); err != nil {
		apiError(&resp.Diagnostics, "creating monitor", err)
		return
	}
	project = derefOr(created.ProjectID, project)
	// a new monitor also gets the project's auto-enabled channels: an explicit list is the whole list
	patch := map[string]any{}
	if !plan.ChannelIDs.IsNull() && !plan.ChannelIDs.IsUnknown() {
		want := stringSet(ctx, plan.ChannelIDs, &resp.Diagnostics)
		got := append([]string{}, created.ChannelIDs...)
		sort.Strings(got)
		if strings.Join(want, ",") != strings.Join(got, ",") {
			patch["channelIds"] = want
		}
	}
	if plan.Paused.ValueBool() {
		patch["paused"] = true
	}
	if len(patch) > 0 {
		if err := r.client.Patch(ctx, "/monitors/"+created.ID, project, patch, nil); err != nil {
			// the monitor exists: keep it in state so the next apply converges instead of creating a duplicate
			resp.State.SetAttribute(ctx, path.Root("id"), created.ID)
			apiError(&resp.Diagnostics, "updating new monitor "+created.ID, err)
			return
		}
	}
	r.readInto(ctx, created.ID, project, &plan, &resp.Diagnostics, func() {})
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

// readInto refreshes m from the API; onGone runs when the monitor no longer exists.
func (r *monitorResource) readInto(ctx context.Context, id, project string, m *monitorModel, diags *diag.Diagnostics, onGone func()) {
	var api client.Monitor
	if err := r.client.Get(ctx, "/monitors/"+id, project, &api); err != nil {
		if client.IsNotFound(err) {
			onGone()
			return
		}
		apiError(diags, "reading monitor "+id, err)
		return
	}
	prior := *m
	m.fromAPI(&api, &prior, r.client.BaseURL(), ctx, diags)
}

func (r *monitorResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state monitorModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	gone := false
	r.readInto(ctx, state.ID.ValueString(), state.ProjectID.ValueString(), &state, &resp.Diagnostics, func() { gone = true })
	if gone {
		resp.State.RemoveResource(ctx)
		return
	}
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *monitorResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state monitorModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	project := state.ProjectID.ValueString()
	body := plan.body(ctx, &resp.Diagnostics, false)
	// sending paused (even unchanged) resets the monitor's state, so only a change is sent
	if plan.Paused.ValueBool() != state.Paused.ValueBool() {
		body["paused"] = plan.Paused.ValueBool()
	}
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Patch(ctx, "/monitors/"+id, project, body, nil); err != nil {
		apiError(&resp.Diagnostics, "updating monitor "+id, err)
		return
	}
	plan.ID = state.ID
	r.readInto(ctx, id, project, &plan, &resp.Diagnostics, func() {
		resp.Diagnostics.AddError("Monitor disappeared", "monitor "+id+" was deleted while it was being updated")
	})
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *monitorResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state monitorModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.Delete(ctx, "/monitors/"+state.ID.ValueString(), state.ProjectID.ValueString()); err != nil && !client.IsNotFound(err) {
		apiError(&resp.Diagnostics, "deleting monitor "+state.ID.ValueString(), err)
	}
}

func (r *monitorResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	importWithProject(ctx, req, resp)
}

func derefOr(p *string, d string) string {
	if p == nil || *p == "" {
		return d
	}
	return *p
}
