import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { auditChanges, recordAuditEvent } from "./audit";
import type { AppEnv, Bindings } from "./env";
import { limitedJsonBody, strictJsonObjectBody } from "./json-body-budget";
import { crossOriginSessionWrite } from "./middleware";
import { operatorMfaSatisfied } from "./operator-mfa";
import { allow, clientIp } from "./ratelimit";
import { availableRegions, isRegionConfigured, resetProbeRegionCache } from "./probes";
import { AUTO, REGION_ID } from "./regions";
import type { ProbeRegionState } from "@montral/repo";
import { isSuspensionReason, SUSPENSION_NOTE_MAX } from "./suspension";

/**
 * Operator (platform staff) control plane, mounted at /api/operator outside requireOrg. See docs/OPERATOR.md.
 *
 * Who is an operator: a user whose id is listed in MONTRAL_OPERATOR_USER_IDS, signed in with a browser session (never
 * an API key or an OAuth/MCP agent token), with two-factor authentication enabled. Everyone else gets the same 403,
 * whether or not they are signed in, so the API tells a non-operator nothing about workspaces or operators.
 *
 * What an operator can do: list and look up workspaces (name, slug, size, owner email, plan and usage, suspension) and
 * suspend or unsuspend one; list probe regions with their health and drain or undrain one. Monitor targets, alert
 * channels, incidents and member lists are not exposed here.
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

const OPERATOR_AUDIT_CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
/** A keyset cursor over two distinct, existing append-only audit sources. */
export function encodePlatformAuditCursor(at: string, source: "workspace" | "probe", id: string): string {
  return b64url(JSON.stringify([at, source, id]));
}
export function decodePlatformAuditCursor(raw: string): { at: string; source: "workspace" | "probe"; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [at, source, id] = parsed;
    const parsedTime = typeof at === "string" && OPERATOR_AUDIT_CURSOR_AT.test(at)
      ? Date.parse(at.slice(0, 19) + "Z") : NaN;
    if (!Number.isFinite(parsedTime) || new Date(parsedTime).toISOString().slice(0, 19) !== at.slice(0, 19)
      || (source !== "workspace" && source !== "probe")
      || typeof id !== "string"
      || (source === "workspace" ? !UUID.test(id) : !/^[1-9]\d{0,18}$/.test(id))) return null;
    return { at, source, id };
  } catch { return null; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deny = (c: Context) => {
  c.header("cache-control", "no-store");
  return c.json({ error: "Forbidden" }, 403);
};

/**
 * Admits platform operators only. Order matters: credentials other than a session are refused before anything is
 * looked up; a known client address is limited before the session lookup, and every session is limited after it (a
 * deployment without a trusted proxy cannot tell addresses apart, and one shared bucket would let anyone lock
 * operators out).
 *
 * The session is read from the database, never from the 5-minute cookie cache, so a revoked session or a disabled
 * second factor ends operator access at once. It must have been created by a second-factor sign-in (operator-mfa.ts).
 */
export const requireOperator = createMiddleware<AppEnv>(async (c, next) => {
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  const repo = c.get("repo");
  const ip = clientIp(c);
  if (ip && !(await allow(repo, `operator:ip:${ip}`, 120, 60))) return c.json({ error: "Too many requests, try again later" }, 429);
  // API keys and OAuth/MCP agent tokens travel in these headers: an operator request is a browser session or nothing
  if (c.req.header("authorization") !== undefined || c.req.header("x-api-key") !== undefined) return deny(c);
  const operators = operatorIds(c.env);
  if (!operators.size) return deny(c);
  const session = (await c.get("auth").api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true } }).catch(() => null)) as
    { user: { id: string }; session: { id: string } } | null;
  if (!session?.user?.id || !session.session?.id) return deny(c);
  if (!(await allow(repo, `operator:session:${session.session.id}`, 120, 60))) return c.json({ error: "Too many requests, try again later" }, 429);
  if (!operators.has(session.user.id)) return deny(c);
  if (crossOriginSessionWrite(c)) return deny(c);
  const database = c.get("database");
  if (!(await operatorMfaSatisfied((sql, params) => database.query(sql, params), session.user.id, session.session.id))) return deny(c);
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

/** A probe that has not answered for this long, without being seen failing either, is reported as "unknown". */
export const PROBE_SILENT_AFTER_MS = 15 * 60_000;
export const PROBE_DRAIN_NOTE_MAX = 200;

/** One region's line in the operator view: configuration, drain flag, last-seen health and how many monitors use it. */
export function probeRegionView(id: string, name: string | null, state: ProbeRegionState | undefined, monitors: number, now = Date.now()) {
  const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
  const status = state?.drained ? "drained"
    : state?.unreachableSince ? "unreachable"
    : state?.lastAnswerAt && now - new Date(state.lastAnswerAt).getTime() <= PROBE_SILENT_AFTER_MS ? "up"
    : "unknown";
  return {
    id, name: name ?? id, configured: name !== null, status, monitors,
    drained: state?.drained ?? false, drainedAt: iso(state?.drainedAt), drainedBy: state?.drainedBy ?? null, drainNote: state?.drainNote ?? null,
    lastUndrainedAt: iso(state?.lastUndrainedAt), lastUndrainedBy: state?.lastUndrainedBy ?? null,
    lastAnswerAt: iso(state?.lastAnswerAt), lastUnreachableAt: iso(state?.lastUnreachableAt),
    lastUnreachableReason: state?.lastUnreachableReason ?? null, unreachableSince: iso(state?.unreachableSince),
  };
}

function logProbeAction(operatorId: string, action: "drain" | "undrain", region: string) {
  console.log(`operator action: ${action} region=${region} operator=${operatorId}`);
}

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Runs a suspension change and its audit event together: in one transaction when the backend has them, so a failed
 * audit write rolls the change back; otherwise the callers write the audit event before the change.
 */
async function atomically<T>(c: Context<AppEnv>, work: (query: Query) => Promise<T>): Promise<T> {
  const database = c.get("database");
  if (database.transaction) return database.transaction((scoped) => work((sql, params) => scoped.query(sql, params)));
  return work((sql, params) => database.query(sql, params));
}

/** The customer reads this in their own audit log; it names the operator role, not the person. Throws on failure. */
function recordOperatorAudit(query: Query, orgId: string, action: string, reason: string) {
  return recordAuditEvent(query, {
    orgId,
    projectId: null,
    actor: { type: "system", id: null, label: "Montral operator" },
    action,
    targetType: "workspace",
    targetId: orgId,
    changes: auditChanges({ reason }),
    ip: null,
  });
}

export const operatorApi = new Hono<AppEnv>()
  .use("*", requireOperator)
  /** Read-only, bounded unified platform timeline from existing operator actions.
   * Other customer audit rows and private operator notes are excluded entirely.
   * No new writer or migration: source actions stay committed transactionally.
   */
  .get("/audit", async (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: "limit must be between 1 and 100" }, 400);
    const source = c.req.query("source") ?? "all";
    if (source !== "all" && source !== "workspace" && source !== "probe")
      return c.json({ error: "source must be all, workspace or probe" }, 400);
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > 100) return c.json({ error: "q must be at most 100 characters" }, 400);
    const rawCursor = c.req.query("cursor");
    const cursor = rawCursor ? decodePlatformAuditCursor(rawCursor) : null;
    if (rawCursor && !cursor) return c.json({ error: "Invalid cursor" }, 400);
    const params: unknown[] = [];
    const filters: string[] = [];
    if (source !== "all") {
      params.push(source);
      filters.push(`source = $${params.length}::text`);
    }
    if (q) {
      params.push(likeContains(q.toLowerCase()));
      filters.push(`lower(target) LIKE $${params.length}::text`);
    }
    if (cursor) {
      params.push(cursor.at, cursor.source, cursor.id);
      const n = params.length;
      filters.push(`(created_at AT TIME ZONE 'UTC', source, id) < ($${n - 2}::timestamp, $${n - 1}::text, $${n}::text)`);
    }
    params.push(limit + 1);
    const rows = await c.get("database").query<{
      source: "workspace" | "probe"; id: string; action: string; target: string;
      operator_id: string | null; reason: string | null;
      created_at: Date | string; cursor_at: string;
    }>(`
      WITH actions AS (
        SELECT 'workspace'::text AS source, a.id::text AS id,
          a.action, a.organization_id::text AS target,
          NULL::text AS operator_id, a.changes->'values'->>'reason' AS reason,
          a.created_at
        FROM audit_event a
        WHERE a.actor_type='system' AND a.actor_label='Montral operator'
          AND a.target_type='workspace' AND a.target_id=a.organization_id
          AND a.action IN ('workspace.suspend','workspace.unsuspend')
        UNION ALL
        SELECT 'probe'::text AS source, p.id::text AS id,
          ('probe.' || p.action)::text AS action, p.region::text AS target,
          p.operator_id::text AS operator_id, NULL::text AS reason, p.created_at
        FROM probe_region_drain_event p
        WHERE p.action IN ('drain','undrain')
      )
      SELECT source,id,action,target,operator_id,reason,created_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at
      FROM actions
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY created_at DESC, source DESC, id DESC LIMIT $${params.length}::int
    `, params);
    const more = rows.length > limit;
    const shown = more ? rows.slice(0, limit) : rows;
    const last = shown[shown.length - 1];
    return c.json({ events: shown.map((r) => ({
      source: r.source, id: r.id, action: r.action, target: r.target,
      // Workspace operator identity was never stored in its customer audit log.
      operatorId: r.operator_id, reason: r.reason,
      createdAt: new Date(r.created_at).toISOString(),
    })), next: more && last ? encodePlatformAuditCursor(last.cursor_at, last.source, last.id) : null });
  })
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
  // The workspace audit already records operator suspensions as system actions with a safe reason.
  // Operators can read this narrow history without disclosing private notes or identity in customer logs.
  // This is not a unified platform audit; only existing retained workspace actions are included.
  .get("/workspaces/:id/suspension-history", async (c) => {
    const id = c.req.param("id");
    if (!ORG_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return c.json({ error: "limit must be between 1 and 50" }, 400);
    const db = c.get("database");
    const [org] = await db.query<{ id: string }>("SELECT id FROM organization WHERE id = $1::text", [id]);
    if (!org) return c.json({ error: "Not found" }, 404);
    const rows = await db.query<{ id: string; action: string; reason: string | null; created_at: Date | string }>(
      `SELECT id, action, changes->'values'->>'reason' AS reason, created_at
         FROM audit_event
        WHERE organization_id = $1::text AND target_type = 'workspace' AND target_id = $1::text
          AND actor_type = 'system' AND actor_label = 'Montral operator'
          AND action IN ('workspace.suspend', 'workspace.unsuspend')
        ORDER BY created_at DESC, id DESC LIMIT $2::int`,
      [id, limit],
    );
    return c.json({
      workspaceId: id,
      events: rows.map((row) => ({
        id: row.id, action: row.action, reason: row.reason,
        createdAt: new Date(row.created_at).toISOString(),
      })),
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
    // the audit event and the suspension commit together (or not at all)
    const done = await atomically(c, async (query) => {
      const [org] = await query<{ id: string }>(`SELECT id FROM organization WHERE id = $1::text FOR UPDATE`, [id]);
      if (!org) return false;
      await recordOperatorAudit(query, id, "workspace.suspend", reason);
      await query(
        `INSERT INTO workspace_suspension (organization_id, reason, note, suspended_by) VALUES ($1::text, $2::text, $3::text, $4::text)
         ON CONFLICT (organization_id) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note, suspended_by = EXCLUDED.suspended_by`,
        [id, reason, trimmed, operatorId],
      );
      return true;
    });
    if (!done) return c.json({ error: "Not found" }, 404);
    logAction(operatorId, "suspend", id, reason);
    return c.json({ id, suspended: true, reason });
  })
  .post("/workspaces/:id/unsuspend", async (c) => {
    const id = c.req.param("id");
    if (!ORG_ID.test(id)) return c.json({ error: "Not found" }, 404);
    const operatorId = c.get("operatorId")!;
    if (!(await allow(c.get("repo"), `operator:write:${operatorId}`, 30, 600))) return c.json({ error: "Too many requests, try again later" }, 429);
    const outcome = await atomically(c, async (query) => {
      const [org] = await query<{ id: string }>(`SELECT id FROM organization WHERE id = $1::text`, [id]);
      if (!org) return "missing" as const;
      const [current] = await query<{ reason: string }>(`SELECT reason FROM workspace_suspension WHERE organization_id = $1::text FOR UPDATE`, [id]);
      // unsuspending a workspace that is not suspended changes nothing and records nothing
      if (!current) return "unchanged" as const;
      await recordOperatorAudit(query, id, "workspace.unsuspend", current.reason);
      await query(`DELETE FROM workspace_suspension WHERE organization_id = $1::text`, [id]);
      return "lifted" as const;
    });
    if (outcome === "missing") return c.json({ error: "Not found" }, 404);
    if (outcome === "lifted") logAction(operatorId, "unsuspend", id, null);
    return c.json({ id, suspended: false });
  })
  // Probe regions: the configured ones (PROBE_REGIONS) and any with stored state that is no longer configured.
  .get("/probes", async (c) => {
    const repo = c.get("repo");
    if (!repo.probeRegionStates) return c.json({ error: "Probe region state is not available on this backend" }, 501);
    const [states, counts] = await Promise.all([repo.probeRegionStates(), repo.monitorsPerRegion?.() ?? Promise.resolve({} as Record<string, number>)]);
    const byId = new Map(states.map((st) => [st.region, st] as const));
    const configured = availableRegions().filter((r) => r.id !== AUTO);
    const stale = states.filter((st) => !configured.some((r) => r.id === st.region)).map((st) => st.region);
    return c.json({
      auto: { monitors: counts[AUTO] ?? 0 },
      regions: [
        ...configured.map((r) => probeRegionView(r.id, r.name, byId.get(r.id), counts[r.id] ?? 0)),
        ...stale.map((id) => probeRegionView(id, null, byId.get(id), counts[id] ?? 0)),
      ],
    });
  })
  // An MFA-verified platform operator can inspect an append-only history of drain / undrain actions.
  // Customer roles and API keys are rejected by the requireOperator gate above.
  .get("/probes/:id/audit", async (c) => {
    const id = c.req.param("id");
    if (!REGION_ID.test(id) || id === AUTO) return c.json({ error: "Not found" }, 404);
    const repo = c.get("repo");
    if (!repo.probeRegionDrainEvents) return c.json({ error: "Probe region audit is not available on this backend" }, 501);
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: "limit must be between 1 and 100" }, 400);
    const events = await repo.probeRegionDrainEvents(id, limit);
    return c.json({ region: id, events: events.map((event) => ({ ...event, createdAt: new Date(event.createdAt).toISOString() })) });
  })
  // A drained region is not asked by the scheduler (within DRAIN_TTL_MS on every server); monitors that list it
  // confirm from their other regions or this location. Only a configured region can be drained; any can be undrained.
  .post("/probes/:id/drain", async (c) => {
    const id = c.req.param("id");
    if (!REGION_ID.test(id) || id === AUTO || !isRegionConfigured(id)) return c.json({ error: "Not found" }, 404);
    const repo = c.get("repo");
    if (!repo.setProbeRegionDrain) return c.json({ error: "Probe region state is not available on this backend" }, 501);
    const operatorId = c.get("operatorId")!;
    if (!(await allow(repo, `operator:write:${operatorId}`, 30, 600))) return c.json({ error: "Too many requests, try again later" }, 429);
    // a malformed or non-object body is refused, never read as "no note"
    const body = await strictJsonObjectBody(c.req.raw, 2048);
    const note = body.note === undefined || body.note === null ? null : body.note;
    if (note !== null && (typeof note !== "string" || note.length > PROBE_DRAIN_NOTE_MAX)) return c.json({ error: `note must be text of at most ${PROBE_DRAIN_NOTE_MAX} characters` }, 400);
    await repo.setProbeRegionDrain(id, { drained: true, by: operatorId, note: note?.trim() || null });
    resetProbeRegionCache();
    logProbeAction(operatorId, "drain", id);
    return c.json({ id, drained: true });
  })
  .post("/probes/:id/undrain", async (c) => {
    const id = c.req.param("id");
    if (!REGION_ID.test(id) || id === AUTO) return c.json({ error: "Not found" }, 404);
    const repo = c.get("repo");
    if (!repo.setProbeRegionDrain) return c.json({ error: "Probe region state is not available on this backend" }, 501);
    const operatorId = c.get("operatorId")!;
    if (!(await allow(repo, `operator:write:${operatorId}`, 30, 600))) return c.json({ error: "Too many requests, try again later" }, 429);
    // undrain takes no fields, but a malformed or oversized body is still refused rather than ignored
    await strictJsonObjectBody(c.req.raw, 2048);
    await repo.setProbeRegionDrain(id, { drained: false, by: operatorId, note: null });
    resetProbeRegionCache();
    logProbeAction(operatorId, "undrain", id);
    return c.json({ id, drained: false });
  });
