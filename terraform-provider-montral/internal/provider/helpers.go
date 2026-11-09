package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	_ "time/tzdata" // IANA zones for recurrence validation, also on hosts without a zoneinfo database

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-framework/types/basetypes"

	"github.com/TheHalfMoon/Montral/terraform-provider-montral/internal/client"
)

type validatorString = validator.String

var uuidRE = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func uuidValidator() validator.String {
	return stringvalidator.RegexMatches(uuidRE, "must be a UUID")
}

// clientFrom is the shared Configure step of every resource and data source.
func clientFrom(providerData any, diags *diag.Diagnostics) *client.Client {
	if providerData == nil {
		return nil // the provider is not configured yet (validation runs before Configure)
	}
	c, ok := providerData.(*client.Client)
	if !ok {
		diags.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T; please report this provider bug", providerData))
		return nil
	}
	return c
}

// apiError turns a client error into a diagnostic that names the operation, the HTTP status and the API error code.
func apiError(diags *diag.Diagnostics, operation string, err error) {
	diags.AddError("Montral API error: "+operation, err.Error())
}

// --- value conversions -------------------------------------------------------------------------------------------

func strPtr(v types.String) *string {
	if v.IsNull() || v.IsUnknown() {
		return nil
	}
	s := v.ValueString()
	return &s
}

func strValue(p *string) types.String {
	if p == nil {
		return types.StringNull()
	}
	return types.StringValue(*p)
}

func stringList(ctx context.Context, v types.List, diags *diag.Diagnostics) []string {
	out := []string{}
	if v.IsNull() || v.IsUnknown() {
		return out
	}
	diags.Append(v.ElementsAs(ctx, &out, false)...)
	return out
}

func stringSet(ctx context.Context, v types.Set, diags *diag.Diagnostics) []string {
	out := []string{}
	if v.IsNull() || v.IsUnknown() {
		return out
	}
	diags.Append(v.ElementsAs(ctx, &out, false)...)
	sort.Strings(out)
	return out
}

func stringMap(ctx context.Context, v types.Map, diags *diag.Diagnostics) map[string]string {
	out := map[string]string{}
	if v.IsNull() || v.IsUnknown() {
		return out
	}
	diags.Append(v.ElementsAs(ctx, &out, false)...)
	return out
}

func listOf(values []string) types.List {
	elems := make([]attr.Value, 0, len(values))
	for _, s := range values {
		elems = append(elems, types.StringValue(s))
	}
	return types.ListValueMust(types.StringType, elems)
}

func setOf(values []string) types.Set {
	elems := make([]attr.Value, 0, len(values))
	for _, s := range values {
		elems = append(elems, types.StringValue(s))
	}
	return types.SetValueMust(types.StringType, elems)
}

func mapOf(values map[string]string) types.Map {
	elems := make(map[string]attr.Value, len(values))
	for k, s := range values {
		elems[k] = types.StringValue(s)
	}
	return types.MapValueMust(types.StringType, elems)
}

// --- instants -----------------------------------------------------------------------------------------------------

// parseInstant accepts RFC 3339 with a UTC offset (the API's ISO 8601 instants).
func parseInstant(s string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, strings.TrimSpace(s))
}

// sameInstant keeps the configured spelling of an instant when the API returns the same moment in another form
// (2026-12-01T03:00:00+01:00 and 2026-12-01T02:00:00.000Z are equal), so a refresh is not reported as drift.
func sameInstant(configured types.String, fromAPI string) types.String {
	if !configured.IsNull() && !configured.IsUnknown() {
		a, errA := parseInstant(configured.ValueString())
		b, errB := parseInstant(fromAPI)
		if errA == nil && errB == nil && a.Equal(b) {
			return configured
		}
	}
	// nothing configured (import): a canonical RFC 3339 spelling without trailing zero fractions
	if t, err := parseInstant(fromAPI); err == nil {
		return types.StringValue(t.UTC().Format(time.RFC3339Nano))
	}
	return types.StringValue(fromAPI)
}

// --- alert-channel settings -----------------------------------------------------------------------------------------

// channelSecretKeys mirrors SECRET_KEYS in apps/api/src/secrets.ts: settings Montral treats as credentials.
var channelSecretKeys = map[string]bool{"url": true, "secret": true, "botToken": true, "routingKey": true, "token": true, "topic": true, "userKey": true}

// channelDefaults are settings the API fills in when omitted; they are hidden from state unless configured.
var channelDefaults = map[string]map[string]string{"ntfy": {"priority": "3"}}

// splitChannelConfig divides the API's settings into plain and secret maps. A masked secret (a caller that may not
// read credentials) keeps what state already holds: Montral never returns it, so it cannot drift-detect it either.
func splitChannelConfig(channelType string, apiConfig map[string]any, priorPlain, priorSecret map[string]string) (map[string]string, map[string]string) {
	plain, secret := map[string]string{}, map[string]string{}
	for k, raw := range apiConfig {
		v, ok := raw.(string)
		if !ok {
			if raw == nil {
				continue
			}
			v = fmt.Sprint(raw)
		}
		if channelSecretKeys[k] {
			if strings.Contains(v, client.Mask) {
				if prev, ok := priorSecret[k]; ok {
					secret[k] = prev
				}
				continue
			}
			secret[k] = v
			continue
		}
		if d, ok := channelDefaults[channelType][k]; ok && d == v {
			if _, configured := priorPlain[k]; !configured {
				continue
			}
		}
		plain[k] = v
	}
	return plain, secret
}

// objectAsOptions converts nested objects strictly: every attribute must be known when the object is.
var objectAsOptions = basetypes.ObjectAsOptions{}
