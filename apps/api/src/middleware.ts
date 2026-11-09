import type { Repo, Scope } from "@montral/repo";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, RequestIdentity } from "./env";
import { currentSession } from "./auth";
import { verifyOAuthToken } from "./oauth";
import { credentialVia, isOwnerRole, oauthCredentialId, sessionVia, ssoRequirementOf } from "./sso-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Value of the `montral_project` cookie and the `x-project-id` header for the workspace-wide view. */
export const ALL_PROJECTS = "all";

/** Resolves the session and the active organization; 401 if there is none. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Cross-site request forgery guard for cookie sessions. SameSite=Lax cookies
 * still travel with requests from sibling subdomains (same site, different
 * origin), so an unsafe method authenticated by the session cookie must come
 * from the web app's own origin. Browsers always send Origin on such requests;
 * a client that sends neither Origin nor a cross-site Sec-Fetch-Site is not a
 * browser being forged, and API keys or OAuth tokens are not ambient
 * credentials, so neither is affected.
 */
export function crossOriginSessionWrite(c: Context<AppEnv>): boolean {
  if (SAFE_METHODS.has(c.req.method)) return false;
  const allowed = new Set([c.env.WEB_ORIGIN, new URL(c.req.url).origin].filter(Boolean));
  const origin = c.req.header("origin");
  if (origin) return origin === "null" || !allowed.has(origin);
  const site = c.req.header("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

export const requireOrg = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get("auth");
  const session = await currentSession(auth, c.req.raw.headers);
  if (session && crossOriginSessionWrite(c)) throw new HTTPException(403, { message: "Cross-origin request refused" });
  let userId = session?.user.id;
  let orgId = (session?.session as { activeOrganizationId?: string | null } | undefined)?.activeOrganizationId ?? undefined;

  let identity: RequestIdentity | undefined = session ? { kind: "session" } : undefined;
  let fromKey = false;
  let scope: Scope = null;
  let granted: AppEnv["Variables"]["workspaceGrant"] = null;
  if (!session) {
    // API-key access (Authorization: Bearer montral_… or x-api-key)
    const raw = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    // an agent authorized through OAuth (MCP): a signed JWT for our MCP resource
    const grant = raw ? await verifyOAuthToken(auth, c.env, raw) : null;
    // the signature is valid, but the user may have withdrawn the grant since: no consent on file, no access
    if (grant && !(grant.clientId && (await c.get("repo").hasOAuthConsent(grant.userId, grant.clientId)))) {
      throw new HTTPException(401, { message: "This authorization was revoked" });
    }
    if (grant) {
      const previewImport = c.req.method === "POST" && c.req.path === "/api/monitors/import/preview";
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !previewImport;
      if (!grant.scopes.includes(write ? "mcp:write" : "mcp:read") && !(write ? false : grant.scopes.includes("mcp:write"))) {
        throw new HTTPException(403, { message: `This token lacks the ${write ? "mcp:write" : "mcp:read"} scope` });
      }
      identity = { kind: "oauth", clientId: grant.clientId! };
      userId = grant.userId;
      fromKey = true;
      // an agent may be given several workspaces (or all of them): it says which one it works in per request
      const asked = c.req.header("x-workspace-id");
      if (grant.all) {
        granted = "all";
        orgId = asked;
      } else {
        granted = new Map(grant.workspaces.map((w) => [w.id, w.projects?.length ? w.projects.filter((p) => UUID.test(p)) : null]));
        orgId = asked ?? grant.workspaces[0]?.id;
        if (!orgId || !granted.has(orgId)) throw new HTTPException(403, { message: "This authorization does not include that workspace" });
        scope = granted.get(orgId) ?? null;
        if (scope && !scope.length) throw new HTTPException(403, { message: "This authorization has no valid projects" });
      }
    } else if (raw) {
      const res = await auth.api.verifyApiKey({ body: { key: raw } }).catch(() => null);
      if (res?.valid && res.key) {
        identity = { kind: "api-key", credentialId: res.key.id };
        userId = res.key.referenceId;
        fromKey = true;
        const meta = res.key.metadata as { organizationId?: string; projectIds?: unknown } | null;
        orgId = meta?.organizationId;
        // a key limited to some projects: only those, whatever the caller asks for
        if (Array.isArray(meta?.projectIds) && meta.projectIds.length) scope = meta.projectIds.filter((p): p is string => typeof p === "string" && UUID.test(p));
        if (scope && !scope.length) throw new HTTPException(403, { message: "API key has no valid projects" });
      }
    }
  }
  // identity is always set with userId; checking it here narrows its type for the principal below
  if (!userId || !identity) throw new HTTPException(401, { message: "Unauthorized" });

  const repo = c.get("repo");
  const asked = c.req.header("x-project-id") ?? cookieValue(c.req.header("cookie"), "montral_project");
  // "all" is the workspace-wide view: the project is then the usual fallback (a limited key: its first project)
  const allProjects = asked === ALL_PROJECTS;
  const wanted = (allProjects ? undefined : asked) ?? scope?.[0];
  // Sessions and grants can outlive membership; authorize the active workspace against current membership.
  if (orgId && !(await repo.isMember(userId, orgId))) throw new HTTPException(403, { message: "Not a member of this workspace" });
  if (!orgId) {
    orgId = (await repo.anyWorkspaceOf(userId)) ?? undefined;
    if (!orgId) throw new HTTPException(403, { message: "No workspace" });
  }
  // "Require SSO": a member other than an owner (the break-glass account) reaches the workspace only with what its own
  // SSO connection produced: a session it created, or an API key or agent authorization made from such a session.
  // Covers sessions and credentials from before the switch and from any other way of signing in.
  {
    const database = c.get("database");
    const q = <T,>(sql: string, params?: unknown[]) => database.query<T>(sql, params);
    const required = await ssoRequirementOf(q, orgId);
    if (required && !isOwnerRole(await repo.memberRole(userId, orgId))) {
      const ok = identity.kind === "session"
        ? await sessionVia(q, String((session?.session as { id?: unknown } | undefined)?.id ?? ""), required)
        : identity.kind === "api-key"
          ? await credentialVia(q, "api_key", identity.credentialId, required)
          : await credentialVia(q, "oauth", oauthCredentialId(userId, identity.clientId), required);
      if (!ok) throw new HTTPException(403, { message: "This workspace requires single sign-on. Sign out and use Sign in with SSO; API keys and agent authorizations must be created after signing in with SSO." });
    }
  }
  const projectId = await cachedProject(repo, orgId, wanted);
  if (scope && !scope.includes(projectId)) throw new HTTPException(403, { message: "API key has no access to this project" });
  c.set("projectId", projectId);
  c.set("allProjects", allProjects);
  c.set("projectScope", scope);
  // a key sees only its own workspace
  c.set("workspaceGrant", granted ?? (fromKey ? new Map([[orgId, scope]]) : null));
  c.set("userId", userId);
  c.set("orgId", orgId);
  c.set("requestPrincipal", Object.freeze({
    ...identity, userId, orgId, projectId, allProjects,
    projectScope: scope ? Object.freeze([...scope]) : null,
  }));
  await next();
});

/** True for workspace owners and admins (by session, API key or agent alike). */
export async function isManager(c: Context<AppEnv>): Promise<boolean> {
  const role = await c.get("repo").memberRole(c.get("userId"), c.get("orgId"));
  return role === "owner" || role === "admin";
}

/** Destructive and configuration-changing actions are for workspace owners and admins; a plain member gets 403. */
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await isManager(c))) throw new HTTPException(403, { message: "Only workspace owners and admins can do this" });
  await next();
});

/**
 * Writes to project-scoped routes need a project: in the "All projects" view the request would land in the fallback
 * project, which is never what the caller meant. Reads pass.
 */
export const rejectInAllProjects = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("allProjects") && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) throw new HTTPException(400, { message: "Choose a project" });
  await next();
});

/** What a list route reads: the active project, or every project the caller may see in the "All projects" view. */
export async function listedProjects(c: Context<AppEnv>): Promise<string | string[]> {
  if (!c.get("allProjects")) return c.get("projectId");
  return (await c.get("repo").listProjects(c.get("orgId"), c.get("projectScope"))).map((p) => p.id);
}

/** Path ids are uuids: anything else is simply not found (instead of a database error surfacing as a 500). */
export const uuidParams = createMiddleware<AppEnv>(async (c, next) => {
  for (const key of ["id", "sid"]) {
    const v = c.req.param(key);
    if (v !== undefined && !UUID.test(v)) return c.json({ error: "Not found" }, 404);
  }
  await next();
});

export function cookieValue(header: string | undefined, name: string) {
  const m = header?.split(/;\s*/).find((p) => p.startsWith(`${name}=`));
  if (!m) return undefined;
  try {
    return decodeURIComponent(m.slice(name.length + 1));
  } catch {
    // Project selection is optional, not an authentication credential. A
    // malformed percent escape/UTF-8 cookie must never turn a valid session
    // into an uncaught URIError (HTTP 500); use the normal project fallback.
    return undefined;
  }
}

// each lookup is a database round trip (~350ms to the origin): remember answers briefly per isolate
const projectCache = new Map<string, { id: string; until: number }>();
export const forgetProjects = (orgId: string) => {
  for (const k of projectCache.keys()) if (k.startsWith(orgId + "|")) projectCache.delete(k);
};
async function cachedProject(repo: Repo, orgId: string, wanted?: string) {
  const key = `${orgId}|${wanted ?? ""}`;
  const hit = projectCache.get(key);
  if (hit && hit.until > Date.now()) return hit.id;
  const id = await repo.resolveProject(orgId, wanted);
  projectCache.set(key, { id, until: Date.now() + 30_000 });
  return id;
}
