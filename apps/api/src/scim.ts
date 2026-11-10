import { Hono, type Context } from "hono";
import { auditChanges, recordAuditEvent, type Query } from "./audit";
import { revokeKeysPinnedTo } from "./auth";
import type { AppEnv, Bindings } from "./env";
import { allow } from "./ratelimit";
import { clearRemoval, connectionById, isOwnerRole, recordRemoval, type SsoConnection } from "./sso-store";

/**
 * SCIM 2.0 (RFC 7643/7644) user provisioning for a workspace with single sign-on: the identity provider creates,
 * updates, deactivates and deletes people with a per-workspace bearer token.
 *
 * - Creating an active user for an address of the connection's verified domains lets single sign-on provision that
 *   person (once a token exists, a workspace provisions only people its provider assigned). An existing Montral account
 *   with a verified email in that domain becomes a member at once; otherwise the account is created at the first SSO
 *   sign-in, as without SCIM.
 * - Deactivating (active=false) or deleting ends the membership like a removal: the person's sessions are signed out,
 *   API keys pinned to the workspace are revoked, and single sign-on refuses them until the provider reactivates them (which makes an existing account a member again). The workspace owner cannot be deprovisioned.
 * - Users only; groups and bulk operations are not supported (ServiceProviderConfig says so).
 */

export const SCIM_TOKEN_PREFIX = "montral_scim_";
const TOKEN = /^montral_scim_[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCIM_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_PAGE = 200;
/** requests per token per 10 minutes; providers sync in bursts */
const RATE = 3000;

type Row = {
  id: string; organization_id: string; user_name: string; external_id: string | null; display_name: string | null;
  given_name: string | null; family_name: string | null; active: boolean; user_id: string | null; created_at: Date; updated_at: Date;
};
type Fields = { externalId?: string | null; displayName?: string | null; givenName?: string | null; familyName?: string | null; active?: boolean };

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const newScimToken = () => SCIM_TOKEN_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

class ScimError extends Error {
  constructor(readonly status: number, detail: string, readonly scimType?: string) { super(detail); }
}

const q = (c: Context<AppEnv>): Query => { const database = c.get("database"); return (sql, params) => database.query(sql, params); };
const json = (c: Context<AppEnv>, body: unknown, status = 200) => {
  c.header("content-type", "application/scim+json; charset=utf-8");
  return c.body(JSON.stringify(body), status as 200);
};
const baseUrl = (env: Bindings) => `${(env.BETTER_AUTH_URL || env.WEB_ORIGIN || "").replace(/\/+$/, "")}/api/scim/v2`;

const str = (v: unknown, max: number, what: string): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new ScimError(400, `${what} must be text of at most ${max} characters`, "invalidValue");
  return v.trim() || null;
};
/** SCIM booleans; Entra ID sends "True"/"False" strings in PATCH */
const bool = (v: unknown): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  throw new ScimError(400, "active must be a boolean", "invalidValue");
};
const userNameOf = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s || s.length > 254 || !EMAIL.test(s)) throw new ScimError(400, "userName must be the person's email address", "invalidValue");
  return s;
};

function resource(env: Bindings, r: Row) {
  const name: Record<string, string> = {};
  if (r.given_name) name.givenName = r.given_name;
  if (r.family_name) name.familyName = r.family_name;
  const formatted = [r.given_name, r.family_name].filter(Boolean).join(" ");
  if (formatted) name.formatted = formatted;
  return {
    schemas: [SCIM_USER],
    id: r.id,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    userName: r.user_name,
    ...(Object.keys(name).length ? { name } : {}),
    ...(r.display_name ? { displayName: r.display_name } : {}),
    emails: [{ value: r.user_name, type: "work", primary: true }],
    active: r.active,
    meta: { resourceType: "User", created: new Date(r.created_at).toISOString(), lastModified: new Date(r.updated_at).toISOString(), location: `${baseUrl(env)}/Users/${r.id}` },
  };
}

/** The workspace's SSO connection (SCIM is offered only with one); null when there is none. */
async function workspaceConnection(query: Query, env: Bindings, orgId: string): Promise<SsoConnection | null> {
  const [row] = await query<{ id: string }>(`SELECT id::text AS id FROM sso_connection WHERE organization_id = $1::text`, [orgId]);
  return row ? connectionById(query, env, row.id) : null;
}

async function verifiedAccount(query: Query, email: string): Promise<string | null> {
  // only an account whose owner proved the address: an unverified sign-up for someone else's address is never added
  const [u] = await query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email) = $1::text AND email_verified = true LIMIT 1`, [email]);
  return u?.id ?? null;
}

/**
 * Makes the stored wish real. Active: lift a block from an earlier deactivation and, for an existing verified account,
 * restore the membership (with the connection's default role). Inactive: end the membership like a removal.
 */
async function apply(query: Query, env: Bindings, orgId: string, row: Row): Promise<string | null> {
  const userId = row.user_id ?? (await verifiedAccount(query, row.user_name));
  if (row.active) {
    await clearRemoval(query, orgId, row.user_name);
    if (userId) {
      const conn = await workspaceConnection(query, env, orgId);
      await query(
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
         SELECT $1::text, $2::text, $3::text, $4::text, now()
          WHERE NOT EXISTS (SELECT 1 FROM member WHERE organization_id = $2::text AND user_id = $3::text)`,
        [crypto.randomUUID(), orgId, userId, conn?.defaultRole ?? "member"],
      );
    }
  } else if (userId) {
    const [m] = await query<{ role: string }>(`SELECT role FROM member WHERE organization_id = $1::text AND user_id = $2::text`, [orgId, userId]);
    if (m && isOwnerRole(m.role)) throw new ScimError(400, "The workspace owner cannot be deprovisioned over SCIM", "mutability");
    if (m) {
      // the block is written before the membership ends (as for a removal), so it can never be missing
      await recordRemoval(query, orgId, userId);
      await query(`DELETE FROM member WHERE organization_id = $1::text AND user_id = $2::text`, [orgId, userId]);
      // The SSO link stays (unlike a removal in the app): a link never adds anyone to a workspace, and an account made
      // by single sign-on has no other way to sign in, so reactivation must find it. The block above refuses JIT.
      await query(`DELETE FROM session WHERE user_id = $1::text`, [userId]);
      await revokeKeysPinnedTo(query, orgId, userId);
    }
  }
  if (userId && userId !== row.user_id) await query(`UPDATE scim_user SET user_id = $2::text WHERE id = $1::uuid`, [row.id, userId]);
  return userId;
}

async function audit(c: Context<AppEnv>, action: string, row: Row, values: Record<string, string | boolean>) {
  try {
    await recordAuditEvent(q(c), {
      orgId: row.organization_id, projectId: null, actor: { type: "system", id: null, label: "SCIM provisioning" }, action,
      targetType: "scim_user", targetId: row.id, changes: auditChanges({}, values), ip: null,
    });
  } catch {
    console.error("audit event could not be recorded; private diagnostics suppressed");
  }
}

function fieldsOf(body: Record<string, unknown>): Fields {
  const name = body.name && typeof body.name === "object" ? (body.name as Record<string, unknown>) : {};
  const out: Fields = {
    externalId: str(body.externalId, 255, "externalId"),
    displayName: str(body.displayName, 100, "displayName"),
    givenName: str(name.givenName, 100, "name.givenName"),
    familyName: str(name.familyName, 100, "name.familyName"),
  };
  if (body.active !== undefined) out.active = bool(body.active);
  return out;
}

async function load(query: Query, orgId: string, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new ScimError(404, "User not found");
  const [row] = await query<Row>(`SELECT * FROM scim_user WHERE id = $1::uuid AND organization_id = $2::text`, [id, orgId]);
  if (!row) throw new ScimError(404, "User not found");
  return row;
}

/** Writes changed fields; returns the new row and whether `active` changed. */
async function update(query: Query, row: Row, f: Fields): Promise<{ row: Row; activeChanged: boolean }> {
  const next = {
    external_id: f.externalId !== undefined ? f.externalId : row.external_id,
    display_name: f.displayName !== undefined ? f.displayName : row.display_name,
    given_name: f.givenName !== undefined ? f.givenName : row.given_name,
    family_name: f.familyName !== undefined ? f.familyName : row.family_name,
    active: f.active !== undefined ? f.active : row.active,
  };
  const [saved] = await query<Row>(
    `UPDATE scim_user SET external_id = $2::text, display_name = $3::text, given_name = $4::text, family_name = $5::text, active = $6::boolean, updated_at = now()
      WHERE id = $1::uuid RETURNING *`,
    [row.id, next.external_id, next.display_name, next.given_name, next.family_name, next.active],
  );
  return { row: saved, activeChanged: saved.active !== row.active };
}

/** RFC 7644 §3.5.2 PATCH, limited to what Montral stores; unknown paths (titles, phone numbers, …) are ignored. */
function patchFields(body: Record<string, unknown>, row: Row): Fields {
  if (!Array.isArray(body.schemas) || !body.schemas.includes(SCIM_PATCH)) throw new ScimError(400, "A PatchOp request is required", "invalidSyntax");
  const ops = body.Operations ?? body.operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 50) throw new ScimError(400, "Operations must list 1 to 50 operations", "invalidSyntax");
  const f: Fields = {};
  const set = (path: string, value: unknown, remove: boolean) => {
    switch (path.toLowerCase()) {
      case "active": if (remove) throw new ScimError(400, "active cannot be removed", "mutability"); f.active = bool(value); break;
      case "externalid": f.externalId = remove ? null : str(value, 255, "externalId"); break;
      case "displayname": f.displayName = remove ? null : str(value, 100, "displayName"); break;
      case "name.givenname": f.givenName = remove ? null : str(value, 100, "name.givenName"); break;
      case "name.familyname": f.familyName = remove ? null : str(value, 100, "name.familyName"); break;
      case "name":
        if (remove) { f.givenName = null; f.familyName = null; break; }
        if (value && typeof value === "object") {
          const n = value as Record<string, unknown>;
          if (n.givenName !== undefined) f.givenName = str(n.givenName, 100, "name.givenName");
          if (n.familyName !== undefined) f.familyName = str(n.familyName, 100, "name.familyName");
        }
        break;
      case "username":
        if (remove || userNameOf(value) !== row.user_name) throw new ScimError(400, "userName cannot be changed; delete the user and create the new address", "mutability");
        break;
      default: break;
    }
  };
  for (const raw of ops) {
    if (!raw || typeof raw !== "object") throw new ScimError(400, "Each operation must be an object", "invalidSyntax");
    const op = String((raw as { op?: unknown }).op ?? "").toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "op must be add, replace or remove", "invalidSyntax");
    const path = (raw as { path?: unknown }).path;
    const value = (raw as { value?: unknown }).value;
    if (typeof path === "string" && path) set(path, value, op === "remove");
    else if (op !== "remove" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) set(k, v, false);
    } else throw new ScimError(400, "An operation needs a path or an object value", "noTarget");
  }
  return f;
}

/** userName eq "…" and externalId eq "…", the filters identity providers use to find a user before creating one. */
function filterOf(raw: string | undefined): { column: "user_name" | "external_id"; value: string } | null {
  if (!raw) return null;
  const m = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  if (!m || raw.length > 600) throw new ScimError(400, "Only userName eq \"…\" and externalId eq \"…\" filters are supported", "invalidFilter");
  const value = m[2].replace(/\\(.)/g, "$1");
  return m[1].toLowerCase() === "username" ? { column: "user_name", value: value.trim().toLowerCase() } : { column: "external_id", value };
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "/docs/self-host#scim",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: MAX_PAGE },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "The SCIM token from the workspace's single sign-on settings", primary: true }],
};

const USER_SCHEMA = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
  id: SCIM_USER, name: "User", description: "A person in the workspace",
  attributes: [
    { name: "userName", type: "string", multiValued: false, required: true, caseExact: false, mutability: "immutable", returned: "default", uniqueness: "server" },
    { name: "externalId", type: "string", multiValued: false, required: false, caseExact: true, mutability: "readWrite", returned: "default", uniqueness: "none" },
    { name: "displayName", type: "string", multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none" },
    { name: "name", type: "complex", multiValued: false, required: false, mutability: "readWrite", returned: "default", subAttributes: [
      { name: "givenName", type: "string", multiValued: false, required: false, mutability: "readWrite", returned: "default" },
      { name: "familyName", type: "string", multiValued: false, required: false, mutability: "readWrite", returned: "default" },
    ] },
    { name: "emails", type: "complex", multiValued: true, required: false, mutability: "readOnly", returned: "default" },
    { name: "active", type: "boolean", multiValued: false, required: false, mutability: "readWrite", returned: "default" },
  ],
};

/** The public SCIM endpoints, mounted at /api/scim/v2. */
export const scimApi = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    const raw = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const fail = () => json(c, { schemas: [SCIM_ERROR], status: "401", detail: "A valid SCIM bearer token is required" }, 401);
    if (!TOKEN.test(raw)) return fail();
    const hash = await sha256Hex(raw);
    const [t] = await q(c)<{ id: string; organization_id: string }>(
      `UPDATE scim_token SET last_used_at = now() WHERE token_hash = $1::text AND revoked_at IS NULL RETURNING id::text AS id, organization_id`, [hash]);
    if (!t) return fail();
    if (!(await allow(c.get("repo"), `scim:${t.id}`, RATE, 600))) return json(c, { schemas: [SCIM_ERROR], status: "429", detail: "Too many requests, try again later" }, 429);
    c.set("orgId", t.organization_id);
    await next();
  })
  .onError((e, c) => {
    if (e instanceof ScimError) return json(c, { schemas: [SCIM_ERROR], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.message }, e.status);
    console.error("SCIM request failed; private diagnostics suppressed");
    return json(c, { schemas: [SCIM_ERROR], status: "500", detail: "Internal error" }, 500);
  })
  .get("/ServiceProviderConfig", (c) => json(c, SERVICE_PROVIDER_CONFIG))
  .get("/Schemas", (c) => json(c, { schemas: [SCIM_LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [USER_SCHEMA] }))
  .get("/Schemas/:id", (c) => (c.req.param("id") === SCIM_USER ? json(c, USER_SCHEMA) : json(c, { schemas: [SCIM_ERROR], status: "404", detail: "Schema not found" }, 404)))
  .get("/ResourceTypes", (c) => json(c, { schemas: [SCIM_LIST], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: SCIM_USER,
  }] }))
  .get("/Users", async (c) => {
    const filter = filterOf(c.req.query("filter"));
    const startIndex = Math.max(1, Number.parseInt(c.req.query("startIndex") ?? "1", 10) || 1);
    const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(c.req.query("count") ?? "100", 10) || 0));
    const where = filter ? `AND ${filter.column} = $2::text` : "";
    const args: unknown[] = [c.get("orgId"), ...(filter ? [filter.value] : [])];
    const [{ n }] = await q(c)<{ n: number }>(`SELECT count(*)::int AS n FROM scim_user WHERE organization_id = $1::text ${where}`, args);
    const rows = count === 0 ? [] : await q(c)<Row>(
      `SELECT * FROM scim_user WHERE organization_id = $1::text ${where} ORDER BY created_at, id LIMIT ${count} OFFSET ${startIndex - 1}`, args);
    return json(c, { schemas: [SCIM_LIST], totalResults: n, startIndex, itemsPerPage: rows.length, Resources: rows.map((r) => resource(c.env, r)) });
  })
  .get("/Users/:id", async (c) => json(c, resource(c.env, await load(q(c), c.get("orgId"), c.req.param("id")))))
  .post("/Users", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScimError(400, "The body must be a SCIM User", "invalidSyntax");
    const userName = userNameOf(body.userName);
    const f = fieldsOf(body);
    const orgId = c.get("orgId");
    const conn = await workspaceConnection(q(c), c.env, orgId);
    if (!conn) throw new ScimError(400, "Set up single sign-on for this workspace before provisioning users", "invalidValue");
    const domain = userName.slice(userName.lastIndexOf("@") + 1);
    if (!conn.domains?.includes(domain)) throw new ScimError(400, "The address is not in one of the workspace's verified single sign-on domains", "invalidValue");
    const [row] = await q(c)<Row>(
      `INSERT INTO scim_user (organization_id, user_name, external_id, display_name, given_name, family_name, active)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean)
       ON CONFLICT (organization_id, user_name) DO NOTHING RETURNING *`,
      [orgId, userName, f.externalId ?? null, f.displayName ?? null, f.givenName ?? null, f.familyName ?? null, f.active ?? true],
    );
    if (!row) throw new ScimError(409, "A user with this userName already exists", "uniqueness");
    try {
      await apply(q(c), c.env, orgId, row);
    } catch (e) {
      // the owner cannot be created as inactive: nothing is kept
      await q(c)(`DELETE FROM scim_user WHERE id = $1::uuid`, [row.id]);
      throw e;
    }
    await audit(c, "scim.user_create", row, { status: row.active ? "active" : "inactive" });
    return json(c, resource(c.env, await load(q(c), orgId, row.id)), 201);
  })
  .put("/Users/:id", async (c) => {
    const row = await load(q(c), c.get("orgId"), c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScimError(400, "The body must be a SCIM User", "invalidSyntax");
    if (body.userName !== undefined && userNameOf(body.userName) !== row.user_name) throw new ScimError(400, "userName cannot be changed; delete the user and create the new address", "mutability");
    // a replace: attributes left out are cleared, `active` defaults to true
    const f = fieldsOf(body);
    return json(c, resource(c.env, await save(c, row, { externalId: f.externalId ?? null, displayName: f.displayName ?? null, givenName: f.givenName ?? null, familyName: f.familyName ?? null, active: f.active ?? true })));
  })
  .patch("/Users/:id", async (c) => {
    const row = await load(q(c), c.get("orgId"), c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScimError(400, "The body must be a PatchOp", "invalidSyntax");
    return json(c, resource(c.env, await save(c, row, patchFields(body, row))));
  })
  .delete("/Users/:id", async (c) => {
    const row = await load(q(c), c.get("orgId"), c.req.param("id"));
    // ends the membership first (refused for the owner, then nothing is deleted)
    if (row.active) await apply(q(c), c.env, row.organization_id, { ...row, active: false });
    await q(c)(`DELETE FROM scim_user WHERE id = $1::uuid`, [row.id]);
    await audit(c, "scim.user_delete", row, { status: "deleted" });
    return c.body(null, 204);
  })
  .all("*", (c) => json(c, { schemas: [SCIM_ERROR], status: "404", detail: "Not supported" }, 404));

async function save(c: Context<AppEnv>, row: Row, f: Fields): Promise<Row> {
  // deactivating the owner is refused before anything is written
  if (f.active === false && row.active) await apply(q(c), c.env, row.organization_id, { ...row, active: false });
  const { row: saved, activeChanged } = await update(q(c), row, f);
  if (saved.active) await apply(q(c), c.env, saved.organization_id, saved);
  if (activeChanged) await audit(c, saved.active ? "scim.user_reactivate" : "scim.user_deactivate", saved, { status: saved.active ? "active" : "inactive" });
  return (await q(c)<Row>(`SELECT * FROM scim_user WHERE id = $1::uuid`, [row.id]))[0];
}

/**
 * What single sign-on may do for an address in a workspace: "allowed"; "inactive" (the provider deactivated the
 * person); "not_assigned" (SCIM is on, so only people the provider created may be provisioned, and this one was not).
 */
export async function scimGate(query: Query, orgId: string, email: string): Promise<"allowed" | "inactive" | "not_assigned"> {
  const [u] = await query<{ active: boolean }>(`SELECT active FROM scim_user WHERE organization_id = $1::text AND user_name = $2::text`, [orgId, email.toLowerCase()]);
  if (u) return u.active ? "allowed" : "inactive";
  const [t] = await query(`SELECT 1 AS one FROM scim_token WHERE organization_id = $1::text AND revoked_at IS NULL`, [orgId]);
  return t ? "not_assigned" : "allowed";
}

/** After single sign-on provisioned an account, remember it on the person's SCIM record. */
export async function linkScimUser(query: Query, orgId: string, email: string, userId: string) {
  await query(`UPDATE scim_user SET user_id = $3::text WHERE organization_id = $1::text AND user_name = $2::text AND user_id IS NULL`, [orgId, email.toLowerCase(), userId]);
}

// ── management, from the workspace owner's signed-in session (routes/sso.ts mounts it under /sso/scim) ───────────

export const scimAdmin = new Hono<AppEnv>()
  .get("/", async (c) => {
    const [t] = await q(c)<{ created_at: Date; last_used_at: Date | null }>(
      `SELECT created_at, last_used_at FROM scim_token WHERE organization_id = $1::text AND revoked_at IS NULL`, [c.get("orgId")]);
    const [counts] = await q(c)<{ active: number; inactive: number }>(
      `SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive FROM scim_user WHERE organization_id = $1::text`, [c.get("orgId")]);
    return c.json({ enabled: !!t, baseUrl: baseUrl(c.env), createdAt: t?.created_at ?? null, lastUsedAt: t?.last_used_at ?? null, users: counts });
  })
  .post("/token", async (c) => {
    const orgId = c.get("orgId");
    if (!(await workspaceConnection(q(c), c.env, orgId))) return c.json({ error: "Set up single sign-on before enabling SCIM provisioning", code: "sso_required" }, 409);
    const token = newScimToken();
    const replaced = await q(c)<{ id: string }>(`UPDATE scim_token SET revoked_at = now() WHERE organization_id = $1::text AND revoked_at IS NULL RETURNING id::text AS id`, [orgId]);
    await q(c)(`INSERT INTO scim_token (organization_id, token_hash, created_by) VALUES ($1::text, $2::text, $3::text)`, [orgId, await sha256Hex(token), c.get("userId")]);
    await recordAuditEvent(q(c), {
      orgId, projectId: null, actor: { type: "user", id: c.get("userId"), userId: c.get("userId") }, action: "scim.token_create",
      targetType: "scim_token", targetId: null, changes: auditChanges({}, { count: replaced.length }), ip: null,
    }).catch(() => console.error("audit event could not be recorded; private diagnostics suppressed"));
    return c.json({ token, baseUrl: baseUrl(c.env), replaced: replaced.length > 0, warning: "This token is shown only once. Store it in your identity provider." }, 201);
  })
  .delete("/token", async (c) => {
    const orgId = c.get("orgId");
    const gone = await q(c)<{ id: string }>(`UPDATE scim_token SET revoked_at = now() WHERE organization_id = $1::text AND revoked_at IS NULL RETURNING id::text AS id`, [orgId]);
    if (!gone.length) return c.json({ error: "SCIM provisioning is not enabled" }, 404);
    await recordAuditEvent(q(c), {
      orgId, projectId: null, actor: { type: "user", id: c.get("userId"), userId: c.get("userId") }, action: "scim.token_revoke",
      targetType: "scim_token", targetId: null, changes: auditChanges({}), ip: null,
    }).catch(() => console.error("audit event could not be recorded; private diagnostics suppressed"));
    return c.body(null, 204);
  });
