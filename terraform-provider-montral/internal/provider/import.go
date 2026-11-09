package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
)

// parseImportID accepts `<id>` or `<project_id>/<id>`. The project form is needed for objects the API lists per
// project (alert channels, maintenance windows) when they are not in the provider's default project.
func parseImportID(raw string) (project, id string, err error) {
	parts := strings.Split(strings.TrimSpace(raw), "/")
	switch {
	case len(parts) == 1 && uuidRE.MatchString(parts[0]):
		return "", parts[0], nil
	case len(parts) == 2 && uuidRE.MatchString(parts[0]) && uuidRE.MatchString(parts[1]):
		return parts[0], parts[1], nil
	}
	return "", "", fmt.Errorf("expected <id> or <project_id>/<id> (UUIDs), got %q", raw)
}

func importWithProject(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	project, id, err := parseImportID(req.ID)
	if err != nil {
		resp.Diagnostics.AddError("Invalid import ID", err.Error())
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), id)...)
	if project != "" {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("project_id"), project)...)
	}
}
