import type { Context } from "hono";
import type { AppEnv } from "./env";

/**
 * Workspace suspension by a platform operator (docs/OPERATOR.md). A row in `workspace_suspension` stops the workspace:
 * API access (requireOrg), scheduled checks and alerts (the repo's claim queries), webhook capture and public status
 * pages. Nothing is deleted; removing the row restores everything.
 */
export const SUSPENSION_REASONS = ["abuse", "payment", "legal", "operator"] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export const SUSPENSION_NOTE_MAX = 500;

/** The error code clients can rely on (the message is for people). */
export const WORKSPACE_SUSPENDED = "workspace_suspended";

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Whether the workspace is suspended right now: one primary-key lookup, never cached. */
export async function workspaceSuspended(query: Query, orgId: string): Promise<boolean> {
  const rows = await query<{ one: number }>(`SELECT 1 AS one FROM workspace_suspension WHERE organization_id = $1::text`, [orgId]);
  return rows.length > 0;
}

/** The 403 every refused request in a suspended workspace gets. Says nothing about the reason or the operator's note. */
export function suspendedResponse(c: Context<AppEnv>) {
  c.header("cache-control", "no-store");
  return c.json({ error: "This workspace is suspended. Contact support.", code: WORKSPACE_SUSPENDED }, 403);
}

export function isSuspensionReason(v: unknown): v is SuspensionReason {
  return typeof v === "string" && (SUSPENSION_REASONS as readonly string[]).includes(v);
}

/** Whether any of these workspaces is suspended (ids as one comma-separated parameter; no array parameters). */
export async function anySuspended(query: Query, orgIds: (string | null | undefined)[]): Promise<boolean> {
  const ids = [...new Set(orgIds.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(",")))];
  if (!ids.length) return false;
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM workspace_suspension WHERE organization_id = ANY (string_to_array($1::text, ',')) LIMIT 1`, [ids.join(",")],
  );
  return rows.length > 0;
}

/**
 * Better Auth endpoints a member may still call while their workspace is suspended: reading it, leaving it, switching
 * away from it, and creating or joining-refusing other workspaces. Every other /organization/* call (invitations, renames,
 * roles, removal, deletion) and creating or changing API keys is refused for a suspended workspace (auth.ts before-hook).
 */
export const SUSPENSION_EXEMPT_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/organization/leave", "/organization/set-active", "/organization/list", "/organization/get-full-organization",
  "/organization/get-active-member", "/organization/get-active-member-role", "/organization/list-members",
  "/organization/check-slug", "/organization/create", "/organization/reject-invitation", "/organization/list-user-invitations",
  "/organization/get-invitation", "/organization/list-invitations", "/organization/has-permission",
]);
export const SUSPENSION_GUARDED_KEY_PATHS: ReadonlySet<string> = new Set(["/api-key/create", "/api-key/update"]);

export function suspensionGuardsAuthPath(path: string): boolean {
  return (path.startsWith("/organization/") && !SUSPENSION_EXEMPT_AUTH_PATHS.has(path)) || SUSPENSION_GUARDED_KEY_PATHS.has(path);
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The organization id inside an API key's stored metadata (a JSON object, possibly stored as JSON text twice). */
function keyOrg(raw: unknown): string | null {
  let v: unknown = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return str(obj(v)?.organizationId);
}

/**
 * The workspaces a guarded Better Auth call may act on, or "unresolved" when it names an invitation or a workspace slug
 * that does not exist (the caller refuses: fail closed).
 *
 * Better Auth acts on `body.organizationId || session.activeOrganizationId` and drops unknown fields after this hook
 * runs, so a decoy field must never stand in for the active workspace: the active workspace is always included unless
 * an explicit organizationId is given where Better Auth reads it (the body of a POST, the query string of a GET). An invitation or slug named in the call adds its workspace on top.
 */
export async function authCallWorkspaces(query: Query, call: { path: string; method?: string; body: unknown; query: unknown; activeOrgId: string | null }): Promise<string[] | "unresolved"> {
  const body = obj(call.body) ?? {};
  const args = obj(call.query) ?? {};
  const out: (string | null)[] = [];
  if (call.path === "/api-key/create") {
    out.push(str(obj(body.metadata)?.organizationId) ?? call.activeOrgId);
  } else if (call.path === "/api-key/update") {
    const keyId = str(body.keyId);
    if (keyId) {
      const [k] = await query<{ metadata: unknown }>(`SELECT metadata FROM apikey WHERE id = $1::text`, [keyId]);
      out.push(keyOrg(k?.metadata));
    }
    out.push(str(obj(body.metadata)?.organizationId), call.activeOrgId);
  } else {
    // Better Auth reads the explicit id from the body on POST routes and from the query string on GET routes; the
    // other place is ignored by it, so an id there is checked too but never stands in for the active workspace
    const read = (call.method ?? "POST").toUpperCase() === "GET" || (call.method ?? "").toUpperCase() === "HEAD";
    const explicit = read ? str(args.organizationId) : str(body.organizationId);
    const elsewhere = read ? str(body.organizationId) : str(args.organizationId);
    out.push(explicit ?? call.activeOrgId, elsewhere);
    const invitationId = str(body.invitationId) ?? str(args.invitationId);
    if (invitationId) {
      const [inv] = await query<{ organization_id: string }>(`SELECT organization_id FROM invitation WHERE id = $1::text`, [invitationId]);
      if (!inv) return "unresolved";
      out.push(inv.organization_id);
    }
    const slug = str(body.organizationSlug) ?? str(args.organizationSlug);
    if (slug) {
      const [org] = await query<{ id: string }>(`SELECT id FROM organization WHERE slug = $1::text`, [slug]);
      if (!org) return "unresolved";
      out.push(org.id);
    }
  }
  return [...new Set(out.filter((x): x is string => !!x))];
}
