import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { auditChanges, recordAuditEvent } from "./audit";
import { currentSession } from "./auth";
import type { AppEnv, Bindings } from "./env";
import { limitedJsonBody } from "./json-body-budget";
import { crossOriginSessionWrite } from "./middleware";
import { allow, clientIp } from "./ratelimit";
import { isSuspensionReason, SUSPENSION_NOTE_MAX } from "./suspension";

/**
 * Operator (platform staff) control plane, mounted at /api/operator outside requireOrg. See docs/OPERATOR.md.
 *
 * Who is an operator: a user whose id is listed in MONTRAL_OPERATOR_USER_IDS, signed in with a browser session (never
 * an API key or an OAuth/MCP agent token), with two-factor authentication enabled. Everyone else gets the same 403,
 * whether or not they are signed in, so the API tells a non-operator nothing about workspaces or operators.
 *
 * What an operator can do: list and look up workspaces (name, slug, size, owner email, plan and usage, suspension) and
 * suspend or unsuspend one. Monitor targets, alert channels, incidents and member lists are not exposed here.
 */

/** The configured operator user ids; an empty or unset variable means there are no operators. */
export function operatorIds(env: Pick<Bindings, "MONTRAL_OPERATOR_USER_IDS"> | undefined): Set<string> {
  return new Set((env?.MONTRAL_OPERATOR_USER_IDS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= 200));
}

const ORG_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function encodeOperatorCursor(at: string, id: string): string {
  return b64url(`${at}|${id}`);
}
/** null for anything this API did not issue. */
export function decodeOperatorCursor(raw: string): { at: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(raw)) return null;
  try {
    const [at, id, ...rest] = atob(raw.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    return !rest.length && CURSOR_AT.test(at ?? "") && ORG_ID.test(id ?? "") ? { at, id } : null;
  } catch {
    return null;
  }
}

const deny = (c: Context) => {
  c.header("cache-control", "no-store");
  return c.json({ error: "Forbidden" }, 403);
};

/**
 * Admits platform operators only. Order matters: credentials other than a session are refused before anything is
 * looked up, and the per-address limit runs before the session lookup so the endpoint cannot be used to hammer auth.
 */
export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  const repo = c.get("repo");
  const ip = clientIp(c);
  if (!(await allow(repo, ip ? `operator:ip:${ip}` : "operator:ip:unknown", ip ? 120 : 600, 60))) return c.json({ error: "Too many requests, try again later" }, 429);
  // API keys and OAuth/MCP agent tokens travel in these headers: an operator request is a browser session or nothing
  if (c.req.header("authorization") !== undefined || c.req.header("x-api-key") !== undefined) return deny(c);
  const operators = operatorIds(c.env);
  if (!operators.size) return deny(c);
  const session = await currentSession(c.get("auth"), c.req.raw.headers);
  if (!session || !operators.has(session.user.id)) return deny(c);
  if (crossOriginSessionWrite(c)) return deny(c);
  // read fresh, not from the session's cookie cache: turning two-factor off ends operator access at once
  const [u] = await c.get("database").query<{ two_factor_enabled: boolean | null }>(`SELECT two_factor_enabled FROM "user" WHERE id = $1::text`, [session.user.id]);
  if (!u?.two_factor_enabled) return deny(c);
  if (!(await allow(repo, `operator:user:${session.user.id}`, 120, 60))) return c.json({ error: "Too many requests, try again later" }, 429);
  c.set("operatorId", session.user.id);
  await next();
});

type WorkspaceRow = {
  id: string; name: string; slug: string; created_at: Date | string; cursor_at: string;
  member_count: number; owner_email: string | null; monitor_count: number; suspended: boolean;
};

const WORKSPACE_COLUMNS = `o.id, o.name, o.slug, o.created_at,
  to_char(o.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at,
  (SELECT count(*)::int FROM member m WHERE m.organization_id = o.id) AS member_count,
  (SELECT u.email FROM member m JOIN "user" u ON u.id = m.user_id
     WHERE m.organization_id = o.id AND 'owner' = ANY (string_to_array(m.role, ','))
     ORDER BY m.created_at, m.user_id LIMIT 1) AS owner_email,
  (SELECT count(*)::int FROM monitor mo WHERE mo.organization_id = o.id) AS monitor_count,
  EXISTS (SELECT 1 FROM workspace_suspension s WHERE s.organization_id = o.id) AS suspended`;

const likeContains = (s: string) => "%" + s.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";

async function planOf(c: Context<AppEnv>, orgId: string): Promise<string | null> {
  try {
    return (await c.get("entitlements").plan(orgId))?.id ?? null;
  } catch {
    return null;
  }
}

const toWorkspace = async (c: Context<AppEnv>, r: WorkspaceRow) => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  createdAt: new Date(r.created_at).toISOString(),
  memberCount: Number(r.member_count),
  ownerEmail: r.owner_email,
  monitorCount: Number(r.monitor_count),
  suspended: !!r.suspended,
  plan: await planOf(c, r.id),
});

/** One server log line per operator action: who, what, which workspace and the reason, never the note. */
function logAction(operatorId: string, action: "suspend" | "unsuspend", orgId: string, reason: string | null) {
  console.log(`operator action: ${action} workspace=${orgId} operator=${operatorId}${reason ? ` reason=${reason}` : ""}`);
}

async function recordOperatorAudit(c: Context<AppEnv>, orgId: string, action: string, reason: string | null) {
  const database = c.get("database");
  try {
    // the customer reads this in their audit log; it names the operator role, not the person
    await recordAuditEvent((sql, params) => database.query(sql, params), {
      orgId,
      projectId: null,
      actor: { type: "system", id: null, label: "Montral operator" },
      action,
      targetType: "workspace",
      targetId: orgId,
      changes: reason ? auditChanges({ reason }) : null,
      ip: null,
    });
  } catch {
    console.error("operator audit event could not be recorded; private diagnostics suppressed");
  }
}

export const operatorApi = new Hono<AppEnv>()
  .use("*", requireOperator)
  .get("/workspaces", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > 100) return c.json({ error: "q must be at most 100 characters" }, 400);
    const limitRaw = Number(c.req.query("limit") ?? 50);
    const limit = Number.isInteger(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 50;
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodeOperatorCursor(rawCursor) : null;
    if (rawCursor && !cursor) return c.json({ error: "Invalid cursor" }, 400);
    const params: unknown[] = [];
    let where = "TRUE";
    if (q) {
      params.push(likeContains(q.toLowerCase()), q);
      where += ` AND (lower(o.name) LIKE $1::text OR lower(o.slug) LIKE $1::text OR o.id = $2::text
        OR EXISTS (SELECT 1 FROM member m JOIN "user" u ON u.id = m.user_id WHERE m.organization_id = o.id AND lower(u.email) LIKE $1::text))`;
    }
    if (cursor) {
      params.push(cursor.at, cursor.id);
      where += ` AND (o.created_at, o.id) < ($${params.length - 1}::timestamp, $${params.length}::text)`;
    }
    const rows = await c.get("database").query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM organization o WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit + 1}`,
      params,
    );
    const more = rows.length > limit;
    const shown = more ? rows.slice(0, limit) : rows;
    const last = shown[shown.length - 1];
    return c.json({
      workspaces: await Promise.all(shown.map((r) => toWorkspace(c, r))),
      next: more && last ? encodeOperatorCursor(last.cursor_at, last.id) : null,
    });
  })
  .get("/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    if (!ORG_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const database = c.get("database");
    const [row] = await database.query<WorkspaceRow>(`SELECT ${WORKSPACE_COLUMNS} FROM organization o WHERE o.id = $1::text`, [id]);
    if (!row) return c.json({ error: "Not found" }, 404);
    const [suspension] = await database.query<{ reason: string; note: string | null; suspended_by: string | null; suspended_at: Date | string }>(
      `SELECT reason, note, suspended_by, suspended_at FROM workspace_suspension WHERE organization_id = $1::text`, [id],
    );
    const e = c.get("entitlements");
    const [credits, emails] = await Promise.all([e.creditBalance(id).catch(() => null), e.emailBalance(id).catch(() => null)]);
    return c.json({
      ...(await toWorkspace(c, row)),
      suspension: suspension
        ? { reason: suspension.reason, note: suspension.note, suspendedBy: suspension.suspended_by, suspendedAt: new Date(suspension.suspended_at).toISOString() }
        : null,
      usage: { credits, emails },
    });
  })
  .post("/workspaces/:id/suspend", async (c) => {
    const id = c.req.param("id");
    if (!ORG_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const operatorId = c.get("operatorId")!;
    if (!(await allow(c.get("repo"), `operator:write:${operatorId}`, 30, 600))) return c.json({ error: "Too many requests, try again later" }, 429);
    const body = (await limitedJsonBody(c.req.raw, 4096)) as { reason?: unknown; note?: unknown } | null;
    if (!isSuspensionReason(body?.reason)) return c.json({ error: "reason must be one of abuse, payment, legal, operator" }, 400);
    const note = body.note === undefined || body.note === null ? null : body.note;
    if (note !== null && (typeof note !== "string" || note.length > SUSPENSION_NOTE_MAX)) return c.json({ error: `note must be text of at most ${SUSPENSION_NOTE_MAX} characters` }, 400);
    const trimmed = note?.trim() || null;
    const reason = body.reason;
    const done = await c.get("database").query<{ organization_id: string }>(
      `INSERT INTO workspace_suspension (organization_id, reason, note, suspended_by)
       SELECT o.id, $2::text, $3::text, $4::text FROM organization o WHERE o.id = $1::text
       ON CONFLICT (organization_id) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note, suspended_by = EXCLUDED.suspended_by
       RETURNING organization_id`,
      [id, reason, trimmed, operatorId],
    );
    if (!done.length) return c.json({ error: "Not found" }, 404);
    logAction(operatorId, "suspend", id, reason);
    await recordOperatorAudit(c, id, "workspace.suspend", reason);
    return c.json({ id, suspended: true, reason });
  })
  .post("/workspaces/:id/unsuspend", async (c) => {
    const id = c.req.param("id");
    if (!ORG_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const operatorId = c.get("operatorId")!;
    if (!(await allow(c.get("repo"), `operator:write:${operatorId}`, 30, 600))) return c.json({ error: "Too many requests, try again later" }, 429);
    const database = c.get("database");
    const [org] = await database.query<{ id: string }>(`SELECT id FROM organization WHERE id = $1::text`, [id]);
    if (!org) return c.json({ error: "Not found" }, 404);
    const removed = await database.query<{ reason: string }>(`DELETE FROM workspace_suspension WHERE organization_id = $1::text RETURNING reason`, [id]);
    // unsuspending a workspace that is not suspended changes nothing and records nothing
    if (removed.length) {
      logAction(operatorId, "unsuspend", id, null);
      await recordOperatorAudit(c, id, "workspace.unsuspend", removed[0].reason);
    }
    return c.json({ id, suspended: false });
  });
