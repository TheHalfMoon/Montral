import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env";
import { clientIp } from "./ratelimit";

/**
 * Workspace audit log: who changed what, when and from where. Rows live in `audit_event` (append-only, see migration
 * 0052). Routes call `audit()` after a mutation succeeded; recording is best effort and never fails the request.
 *
 * Privacy: `changes` holds the NAMES of the fields a request changed. A value is kept only for a short allowlist of
 * harmless settings (a name, a role, a visibility, a toggle). Passwords, tokens, API keys, channel settings (webhook
 * URLs, bot tokens), monitor targets, headers and bodies are never stored, whatever the field is called.
 */

export type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
export type AuditActorType = "user" | "api_key" | "system";
export type AuditValue = string | number | boolean | null;
export type AuditChanges = { fields: string[]; values?: Record<string, AuditValue> };
/** What was acted on. `projectId` undefined = the request's project; null = workspace-wide. */
export type AuditTarget = { type: string; id?: string | null; projectId?: string | null };
export type AuditActor = {
  type: AuditActorType;
  id: string | null;
  /** used as is when given; otherwise the user's email or the API key's name is looked up */
  label?: string | null;
  userId?: string | null;
  apiKeyId?: string | null;
  /** appended to the looked-up label, e.g. " via OAuth agent <client>" */
  labelSuffix?: string | null;
};

export type AuditEventInput = {
  orgId: string;
  projectId: string | null;
  actor: AuditActor;
  action: string;
  targetType: string;
  targetId: string | null;
  changes: AuditChanges | null;
  ip: string | null;
  /** only record when this user is (still) a member of orgId: for callers that did not go through requireOrg */
  requireMember?: string | null;
};

export type AuditEvent = {
  id: string;
  projectId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  changes: AuditChanges | null;
  ip: string | null;
  createdAt: string;
};

export const AUDIT_RETENTION_DEFAULT_DAYS = 365;
export const AUDIT_RETENTION_MIN_DAYS = 30;
export const AUDIT_RETENTION_MAX_DAYS = 3650;
/** Days audit events are kept: AUDIT_RETENTION_DAYS when it is a whole number from 30 to 3650, else 365. */
export function auditRetentionDays(env: Pick<Bindings, "AUDIT_RETENTION_DAYS"> | undefined): number {
  const n = Number(env?.AUDIT_RETENTION_DAYS);
  return Number.isInteger(n) && n >= AUDIT_RETENTION_MIN_DAYS && n <= AUDIT_RETENTION_MAX_DAYS ? n : AUDIT_RETENTION_DEFAULT_DAYS;
}

/** Most rows a single export returns. */
export const AUDIT_EXPORT_CAP = 100_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z_]+(\.[a-z_]+)+$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 30;
const MAX_VALUE_CHARS = 80;

/** Settings whose value is harmless to keep and useful to read back ("visibility: password", "role: admin"). */
export const SAFE_VALUE_FIELDS: ReadonlySet<string> = new Set([
  "name", "title", "slug", "type", "scope", "role", "status", "severity", "visibility", "theme",
  "enabled", "autoEnable", "paused", "showLatency", "hideBranding", "mcpEnabled", "publishPostmortem",
  "intervalSec", "timeoutMs", "failureThreshold", "recoveryThreshold", "uptimeOkPct", "uptimeWarnPct",
  "maintenanceReminderHours", "alertLogRetentionDays", "checkRetentionDays", "monthlyReport",
  "reminderIntervalMin", "domain", "method", "frequency", "count", "verified", "expiresInHours", "format", "reason",
  "timeZone", "repeatCount", "version", "level", "rotationType",
  "requireSso", "defaultRole",
  // webhook response overrides: the status per method and the host (never the full URL) a redirect points to
  "postStatus", "putStatus", "patchStatus", "redirectHost",
]);
/**
 * Defense in depth: a value is dropped when its field name looks like a credential or a destination, even if someone
 * later adds it to SAFE_VALUE_FIELDS by mistake.
 */
const SENSITIVE_NAME = /pass|secret|token|key|url|header|body|config|cookie|auth|credential|webhook|target|email|phone|message|hash|signature/i;

/** True when the value of this field may be written to the audit log. */
export const safeValueField = (name: string) => SAFE_VALUE_FIELDS.has(name) && !SENSITIVE_NAME.test(name);

/**
 * The audit summary of a change: the names of the fields `input` sets (any value, never stored) and, for allowlisted
 * fields only, their scalar values. `extra` adds values that are not in the request itself (e.g. the new role).
 */
export function auditChanges(input: Record<string, unknown> | null | undefined, extra: Record<string, unknown> = {}): AuditChanges {
  const source = input ?? {};
  const fields = [...new Set(Object.keys(source).filter((k) => source[k] !== undefined && FIELD.test(k)))].sort().slice(0, MAX_FIELDS);
  const values: Record<string, AuditValue> = {};
  for (const [k, v] of [...fields.map((f) => [f, source[f]] as const), ...Object.entries(extra)]) {
    if (!FIELD.test(k) || !safeValueField(k)) continue;
    if (v === null || typeof v === "boolean") values[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) values[k] = v;
    else if (typeof v === "string") values[k] = v.slice(0, MAX_VALUE_CHARS);
  }
  return Object.keys(values).length ? { fields, values } : { fields };
}

/** Who made this request: the signed-in user, the API key, or the user an OAuth agent acts for. */
export function auditActorOf(c: Context<AppEnv>): AuditActor {
  const p = c.get("requestPrincipal");
  if (p?.kind === "api-key") return { type: "api_key", id: p.credentialId, apiKeyId: p.credentialId };
  const userId = p?.userId ?? c.get("userId");
  if (p?.kind === "oauth") return { type: "user", id: userId, userId, labelSuffix: ` (via OAuth agent ${p.clientId.slice(0, 64)})` };
  return { type: "user", id: userId, userId };
}

/** Writes one event; throws on failure (use `audit()` from routes). */
export async function recordAuditEvent(query: Query, e: AuditEventInput): Promise<void> {
  if (!ACTION.test(e.action) || e.action.length > 64) throw new Error("invalid audit action");
  const projectId = e.projectId && UUID.test(e.projectId) ? e.projectId : null;
  const changes = e.changes ? boundChanges(e.changes) : null;
  await query(
    `INSERT INTO audit_event (organization_id, project_id, actor_type, actor_id, actor_label, action, target_type, target_id, changes, ip)
     SELECT $1::text, $2::uuid, $3::text, $4::text,
            left(coalesce($5::text, (SELECT email FROM "user" WHERE id = $6::text), (SELECT name FROM apikey WHERE id = $7::text)) || coalesce($8::text, ''), 320),
            $9::text, $10::text, $11::text, $12::jsonb, $13::text
     WHERE $14::text IS NULL OR EXISTS (SELECT 1 FROM member WHERE organization_id = $1::text AND user_id = $14::text)`,
    [
      e.orgId, projectId, e.actor.type, e.actor.id?.slice(0, 200) ?? null, e.actor.label?.slice(0, 320) ?? null, e.actor.userId ?? null,
      e.actor.apiKeyId ?? null, e.actor.labelSuffix ?? null, e.action, e.targetType.slice(0, 40), e.targetId?.slice(0, 200) ?? null,
      changes ? JSON.stringify(changes) : null, e.ip?.slice(0, 64) ?? null, e.requireMember ?? null,
    ],
  );
}

/** Keeps the stored summary well inside the column's 4 KiB check. */
function boundChanges(ch: AuditChanges): AuditChanges {
  const fields = ch.fields.filter((f) => FIELD.test(f)).slice(0, MAX_FIELDS);
  const out: AuditChanges = ch.values && Object.keys(ch.values).length ? { fields, values: ch.values } : { fields };
  return JSON.stringify(out).length > 3000 ? { fields } : out;
}

/**
 * Records an action of the current request. Best effort: the mutation already happened, so a failure here is logged
 * with a fixed message and never turns the response into an error.
 */
export async function audit(c: Context<AppEnv>, action: string, target: AuditTarget, changes?: AuditChanges | null): Promise<void> {
  try {
    const database = c.get("database");
    await recordAuditEvent((sql, params) => database.query(sql, params), {
      orgId: c.get("orgId"),
      projectId: target.projectId === undefined ? c.get("projectId") : target.projectId,
      actor: auditActorOf(c),
      action,
      targetType: target.type,
      targetId: target.id ?? null,
      changes: changes ?? null,
      ip: clientIp(c),
    });
  } catch {
    console.error("audit event could not be recorded; private diagnostics suppressed");
  }
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type AuditFilters = { action?: string; actorId?: string; targetType?: string; targetId?: string; from?: Date; to?: Date };
type Cursor = { at: string; id: string };

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const encodeCursor = (c: Cursor) => b64url(`${c.at}|${c.id}`);
/** null when the cursor is not one this API issued. */
export function decodeCursor(raw: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  try {
    const [at, id, ...rest] = atob(raw.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    return !rest.length && CURSOR_AT.test(at ?? "") && UUID.test(id ?? "") ? { at, id } : null;
  } catch {
    return null;
  }
}

/** Escapes LIKE wildcards so a filter is always a literal prefix. */
const likePrefix = (s: string) => s.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%";

type Row = {
  id: string; project_id: string | null; actor_type: AuditActorType; actor_id: string | null; actor_label: string | null; action: string;
  target_type: string; target_id: string | null; changes: AuditChanges | string | null; ip: string | null; created_at: Date | string; cursor_at: string;
};

const toEvent = (r: Row): AuditEvent => ({
  id: r.id,
  projectId: r.project_id,
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorLabel: r.actor_label,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  changes: typeof r.changes === "string" ? (JSON.parse(r.changes) as AuditChanges) : r.changes,
  ip: r.ip,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * One page of a workspace's events, newest first. Keyset pagination on (created_at, id) with the timestamp carried at
 * full microsecond precision, so pages never skip or repeat rows. Every query is bound to `orgId`: filters narrow it
 * and can never reach another workspace.
 */
export async function listAuditEvents(query: Query, orgId: string, f: AuditFilters, page: { limit: number; cursor?: Cursor | null }): Promise<{ events: AuditEvent[]; next: string | null }> {
  const params: unknown[] = [orgId];
  let where = "organization_id = $1::text";
  const add = (sql: (n: number) => string, v: unknown) => { params.push(v); where += ` AND ${sql(params.length)}`; };
  if (f.action) add((n) => `action LIKE $${n}::text`, likePrefix(f.action));
  if (f.actorId) add((n) => `actor_id = $${n}::text`, f.actorId);
  if (f.targetType) add((n) => `target_type = $${n}::text`, f.targetType);
  if (f.targetId) add((n) => `target_id = $${n}::text`, f.targetId);
  if (f.from) add((n) => `created_at >= $${n}::timestamptz`, f.from.toISOString());
  if (f.to) add((n) => `created_at < $${n}::timestamptz`, f.to.toISOString());
  if (page.cursor) {
    params.push(page.cursor.at, page.cursor.id);
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  const limit = Math.max(1, Math.min(1000, Math.floor(page.limit)));
  const rows = await query<Row>(
    `SELECT id, project_id, actor_type, actor_id, actor_label, action, target_type, target_id, changes, ip, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
     FROM audit_event WHERE ${where}
     ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT ${limit + 1}`,
    params,
  );
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const last = shown[shown.length - 1];
  return { events: shown.map(toEvent), next: more && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null };
}

// ── export ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = ["created_at", "id", "action", "actor_type", "actor_id", "actor_label", "target_type", "target_id", "project_id", "ip", "changes"] as const;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula is prefixed with an apostrophe: a cell starting with
 * = + - @, tab, carriage return or line feed, or with leading whitespace followed by = + - @ (spreadsheets trim it
 * first). Cells with a comma, quote or line break are quoted.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r\n]/.test(s) || /^\s*[=+\-@]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",") + "\r\n";

export const csvEventRow = (e: AuditEvent) =>
  csvRow([e.createdAt, e.id, e.action, e.actorType, e.actorId, e.actorLabel, e.targetType, e.targetId, e.projectId, e.ip, e.changes]);

/**
 * The matching events as a stream of CSV or JSON Lines, newest first, read page by page (never all in memory) and
 * capped at `cap` rows. `done` runs once however the stream ends (finished, failed or cancelled by the client).
 */
export function exportAuditEvents(query: Query, orgId: string, f: AuditFilters, format: "csv" | "jsonl", options: { cap?: number; pageSize?: number; done?: () => void } = {}): ReadableStream<Uint8Array> {
  const cap = options.cap ?? AUDIT_EXPORT_CAP;
  const pageSize = options.pageSize ?? 1000;
  const encoder = new TextEncoder();
  let sent = 0;
  let cursor: Cursor | null = null;
  let started = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    options.done?.();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (format === "csv") {
            controller.enqueue(encoder.encode(csvRow([...CSV_COLUMNS])));
            return;
          }
        }
        const left = cap - sent;
        if (left <= 0 || (sent > 0 && cursor === null)) {
          controller.close();
          finish();
          return;
        }
        const page = await listAuditEvents(query, orgId, f, { limit: Math.min(pageSize, left), cursor });
        sent += page.events.length;
        const text = page.events.map((e) => (format === "csv" ? csvEventRow(e) : JSON.stringify(e) + "\n")).join("");
        if (text) controller.enqueue(encoder.encode(text));
        cursor = page.next ? decodeCursor(page.next) : null;
        if (!cursor || !page.events.length) {
          controller.close();
          finish();
        }
      } catch {
        console.error("audit export failed; private diagnostics suppressed");
        controller.error(new Error("Audit export failed"));
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
}
