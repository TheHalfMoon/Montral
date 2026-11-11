import { releaseDatabase } from "./db-lifetime";
import type { Database } from "@montral/repo";
import type { AppEnv } from "./env";
import { Hono } from "hono";
import { requireManager, rejectInAllProjects, uuidParams } from "./middleware";
import { allow } from "./ratelimit";
import { audit, auditChanges } from "./audit";
import { BlockedTarget, checkUserAgent, guardedFetch, isWorkers } from "./netguard";
import { pinnedFetch } from "./pinnedfetch";
import { columnExists, relationExists } from "./schema-catalog";
import { boundedDelay, buildConfiguredResponse, DelaySlots, parseHookResponseConfig, RESPONSE_LIMITS, responseVariant, type HookResponseConfig } from "./montral-hook-response";
import { z } from "zod";
import { WORKSPACE_SUSPENDED } from "./suspension";
import type { Entitlements } from "./entitlements";
import { calendarMonthUtc, secondsUntil } from "./montral-metering";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_BYTES = 32 * 1024;
const MAX_INBOXES = 10;
const listInbox = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const EVENT_PAGE = 50;
const REPLAY_TIMEOUT_MS = 10_000;
const REPLAY_RESPONSE_BYTES = 4 * 1024;
/** Link-local and cloud metadata addresses: refused for replay in every configuration. */
export function replayAddressForbidden(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 embedded in IPv6 as the URL parser writes it: mapped (::ffff:a9fe:a9fe),
  // compatible (::a9fe:a9fe) and NAT64 (64:ff9b::a9fe:a9fe).
  const mapped = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return replayAddressForbidden(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y, z, w] = v4.slice(1).map(Number);
    return (x === 169 && y === 254) || (x === 100 && y === 100 && z === 100 && w === 200) || x === 0;
  }
  return /^fe[89ab][0-9a-f]:/.test(a) || a === "fd00:ec2::254" || a === "::";
}
/**
 * Replay's outbound request. By default only public addresses are reachable,
 * whatever ALLOW_PRIVATE_TARGETS says: that setting lets monitors check
 * internal services, but replay returns the response body to the caller, so
 * it would become a way to read internal pages. A self-hosted operator can
 * allow private development endpoints with MONTRAL_REPLAY_PRIVATE_TARGETS;
 * link-local and metadata addresses stay refused, and the connection is
 * pinned to the addresses that were checked.
 */
async function replayFetch(url: string, init: RequestInit, privateAllowed: boolean): Promise<Response> {
  if (!privateAllowed || isWorkers()) return (await guardedFetch(url, init, { follow: false, publicOnly: true })).res;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const literal = host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const dns = literal ? null : await import("node:dns/promises");
  const addresses = literal ? [host] : (await dns!.lookup(host, { all: true })).map((r) => r.address);
  if (!addresses.length || addresses.some(replayAddressForbidden)) throw new BlockedTarget();
  return pinnedFetch(url, { ...init, redirect: "manual" }, addresses);
}
/** At most `max` raw bytes as text, and whether the response was longer; decided on bytes, so binary bodies are not misreported. */
async function readReplayBody(res: Response, max: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(new DOMException("Response body read timed out", "TimeoutError"));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      const room = max - size;
      if (value.byteLength > room) { chunks.push(value.subarray(0, room)); size = max; truncated = true; break; }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // Best effort: a peer that never settles cancellation must not hold the request.
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  // stream: true leaves a multibyte character split by the cap undecoded instead of inventing U+FFFD.
  return { text: new TextDecoder().decode(bytes, { stream: truncated }), truncated };
}
const replayTarget = z.object({
  // zod still runs refinements after .url() fails, so parse defensively here.
  url: z.string().trim().max(2048).url().refine((u) => /^https?:$/.test(URL.parse(u)?.protocol ?? ""), "http or https only"),
}).strict();
const eventQuery = z.object({
  before: z.string().regex(UUID).optional(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
}).strict();
/** Inbox creation only needs a name (100 chars), not unlimited JSON input. */
const INBOX_CREATE_MAX_BYTES = 4 * 1024;
const INBOX_CREATE_READ_MS = 10_000;
export class InboxCreationTimeoutError extends Error {
  constructor() { super("Inbox creation body read timeout"); }
}
/** A single end-to-end read deadline prevents low-rate senders from holding
 * authenticated inbox-creation requests open indefinitely. The override exists
 * for deterministic test streams; mounted requests use the 10-second bound. */
export async function readInboxCreation(request: Request, timeoutMs = INBOX_CREATE_READ_MS, maxBytes = INBOX_CREATE_MAX_BYTES): Promise<{ oversized: boolean; value?: unknown }> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    return { oversized: true };
  }
  if (!request.body) return { oversized: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InboxCreationTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value.byteLength > maxBytes - size) return { oversized: true };
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A hostile upload can also refuse stream cancellation; do not await it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { oversized: false, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { oversized: false };
  }
}


export type HookInbox = {
  id: string; organization_id: string; project_id: string; name: string;
  token_hash: string; created_at: Date;
};
export type HookEvent = {
  id: string; inbox_id: string; organization_id: string; project_id: string;
  method: string; content_type: string | null; headers: Record<string,string>;
  body: string; created_at: Date;
  /** Status the receiver answered with; null for events captured before configurable responses. */
  response_status?: number | null;
};
/** Delayed responses in flight on this process; see DelaySlots. */
export const hookDelaySlots = new DelaySlots(5, 20, 200);

export const fingerprint = async (token: string) => {
  const bytes = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
};
export function sameHash(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function capturedHeaders(headers: Headers): Record<string, string> {
  const allowed = ["content-type", "user-agent", "x-request-id", "x-event-type", "x-github-event", "x-shopify-topic"];
  const out: Record<string,string> = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value) out[name] = value.slice(0, 300);
  }
  return out;
}
/** A body cannot be stored faithfully as PostgreSQL text (invalid UTF-8 or NUL). */
export class InvalidWebhookPayloadError extends Error {
  constructor() { super("Webhook payload must be valid UTF-8 text without NUL bytes"); }
}
export class WebhookPayloadTimeoutError extends Error {
  constructor() { super("Webhook payload read timeout"); }
}
const MAX_READ_MS = 10_000;

/** Bound both bytes and elapsed time. A sender can drip <32 KiB forever; the
 * deadline covers the whole stream, not each read. Timeout is injectable only
 * for deterministic regression tests; mounted endpoints use the production cap. */
export async function readPayload(request: Request, timeoutMs = MAX_READ_MS): Promise<string | null> {
  const size = Number(request.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WebhookPayloadTimeoutError()), timeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A sender can stall forever while handling cancellation. Never let an
    // over-budget or timed-out webhook keep the HTTP response open waiting for it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  // PostgreSQL text rejects U+0000. The default TextDecoder silently replaces
  // malformed UTF-8 with U+FFFD, corrupting forensic webhook captures.
  // Reject both explicitly: the caller gets a stable client error, not SQL 500.
  if (bytes.includes(0)) throw new InvalidWebhookPayloadError();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidWebhookPayloadError();
  }
}
export async function migrateMontralHooks(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS montral_hook_inbox (
    id uuid PRIMARY KEY, organization_id text NOT NULL, project_id text NOT NULL,
    name varchar(100) NOT NULL, token_hash char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  // CREATE INDEX IF NOT EXISTS takes a SHARE lock on the table (blocking
  // webhook captures until the edition transaction commits) even when the
  // index already exists. Consult the catalog so restarts take no table lock.
  if (!await relationExists(db, "montral_hook_inbox_scope")) {
    await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_inbox_scope
      ON montral_hook_inbox (organization_id, project_id)`);
  }
  // Configurable receiver response. ADD COLUMN IF NOT EXISTS would take ACCESS
  // EXCLUSIVE even when the column exists, so only a genuine upgrade runs it.
  // Inbox before event: the same order a capture locks them in.
  if (!await columnExists(db, "montral_hook_inbox", "response")) {
    await db.query(`ALTER TABLE montral_hook_inbox ADD COLUMN IF NOT EXISTS response jsonb`);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS montral_hook_event (
    id uuid PRIMARY KEY, inbox_id uuid NOT NULL REFERENCES montral_hook_inbox(id) ON DELETE CASCADE,
    organization_id text NOT NULL, project_id text NOT NULL, method varchar(10) NOT NULL,
    content_type varchar(256), headers jsonb NOT NULL DEFAULT '{}'::jsonb, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  if (!await columnExists(db, "montral_hook_event", "response_status")) {
    await db.query(`ALTER TABLE montral_hook_event ADD COLUMN IF NOT EXISTS response_status smallint`);
  }
  if (!await relationExists(db, "montral_hook_event_recent")) {
    await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_event_recent
      ON montral_hook_event (inbox_id, created_at DESC)`);
  }
  if (!await relationExists(db, "montral_hook_event_expiry")) {
    await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_event_expiry
      ON montral_hook_event (created_at)`);
  }
  // PL/pgSQL executes the count as a separate statement AFTER taking the advisory
  // transaction lock. A CTE count in a caller statement sees its pre-lock snapshot,
  // so competing requests can otherwise overrun the quota.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_create_hook_inbox(
      p_id uuid, p_org text, p_project text, p_name text, p_hash text
    ) RETURNS uuid LANGUAGE plpgsql AS $montral$
    DECLARE existing_count integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_org || ':' || p_project, 0));
      SELECT COUNT(*) INTO existing_count FROM montral_hook_inbox
        WHERE organization_id = p_org AND project_id = p_project;
      IF existing_count >= 10 THEN RETURN NULL; END IF;
      INSERT INTO montral_hook_inbox(id,organization_id,project_id,name,token_hash)
      VALUES (p_id,p_org,p_project,p_name,p_hash);
      RETURN p_id;
    END;
    $montral$
  `);
  // The inbox row lock serializes simultaneous receipts for this inbox,
  // including concurrent delete, without locking unrelated tenants/inboxes.
  // Insert + retention take effect atomically; no burst can leave >250 events.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_capture_hook_event(
      p_inbox uuid, p_hash text, p_event uuid, p_method text,
      p_content_type text, p_headers jsonb, p_body text
    ) RETURNS boolean LANGUAGE plpgsql AS $montral$
    DECLARE current_inbox record;
    BEGIN
      SELECT organization_id,project_id INTO current_inbox
      FROM montral_hook_inbox
      WHERE id=p_inbox AND token_hash=p_hash FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      INSERT INTO montral_hook_event(
        id,inbox_id,organization_id,project_id,method,content_type,headers,body
      ) VALUES (
        p_event,p_inbox,current_inbox.organization_id,current_inbox.project_id,
        p_method,p_content_type,p_headers,p_body
      );
      DELETE FROM montral_hook_event
      WHERE inbox_id=p_inbox AND (
        created_at < NOW() - INTERVAL '7 days'
        OR id IN (
          SELECT id FROM montral_hook_event
          WHERE inbox_id=p_inbox ORDER BY created_at DESC,id DESC OFFSET 250
        )
      );
      RETURN true;
    END;
    $montral$
  `);
  // v2 also reads the inbox's response configuration under the same row lock
  // and records the status it selects, so the stored status always matches
  // the configuration the receiver answers with, even while a manager edits it.
  // The 7-argument function above stays for replicas still running the old code.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_capture_hook_event_v2(
      p_inbox uuid, p_hash text, p_event uuid, p_method text,
      p_content_type text, p_headers jsonb, p_body text
    ) RETURNS jsonb LANGUAGE plpgsql AS $montral$
    DECLARE current_inbox record; chosen_status smallint;
    BEGIN
      SELECT organization_id,project_id,response INTO current_inbox
      FROM montral_hook_inbox
      WHERE id=p_inbox AND token_hash=p_hash FOR UPDATE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      chosen_status := COALESCE(
        (COALESCE(current_inbox.response->'methods'->p_method, current_inbox.response)->>'status')::smallint, 202);
      INSERT INTO montral_hook_event(
        id,inbox_id,organization_id,project_id,method,content_type,headers,body,response_status
      ) VALUES (
        p_event,p_inbox,current_inbox.organization_id,current_inbox.project_id,
        p_method,p_content_type,p_headers,p_body,chosen_status
      );
      DELETE FROM montral_hook_event
      WHERE inbox_id=p_inbox AND (
        created_at < NOW() - INTERVAL '7 days'
        OR id IN (
          SELECT id FROM montral_hook_event
          WHERE inbox_id=p_inbox ORDER BY created_at DESC,id DESC OFFSET 250
        )
      );
      RETURN jsonb_build_object('status', chosen_status, 'response', current_inbox.response);
    END;
    $montral$
  `);
  return ["montral_hooks_v4"];
}

/** Server-driven expiry, including idle inboxes; no user interaction is needed to evict old events. */
export async function pruneExpiredHookEvents(db: Database): Promise<number> {
  // Cleanup covers project/workspace removal, where the original domain tables have
  // a different key type from the webhook inbox's legacy textual project id.
  // Deleting the inbox cascades to its events. A deleted workspace cannot retain
  // webhook payloads indefinitely.
  await db.query(`
    DELETE FROM montral_hook_inbox AS i
    WHERE NOT EXISTS (SELECT 1 FROM organization AS o WHERE o.id = i.organization_id)
       OR NOT EXISTS (SELECT 1 FROM project AS p WHERE p.id::text = i.project_id
                      AND p.organization_id = i.organization_id)
  `);
  // Aggregate in SQL instead of returning every deleted event into Worker memory.
  const rows = await db.query<{ removed: string }>(`
    WITH expired AS (
      DELETE FROM montral_hook_event
      WHERE created_at < NOW() - INTERVAL '7 days'
      RETURNING 1
    ) SELECT COUNT(*)::text AS removed FROM expired
  `);
  return Number(rows[0]?.removed ?? 0);
}

export const WEBHOOK_QUOTA_EXHAUSTED = "webhook_quota_exhausted";
export const METERING_UNAVAILABLE = "metering_unavailable";
export type WebhookCharge =
  | { ok: true; charged: number }
  | { ok: false; status: 429 | 503; body: { error: string; code: string }; retryAfter?: number };

/**
 * One captured webhook request against the workspace's monthly webhook-event allowance, taken at `spentAt`.
 * Self-hosted (no `spendMeter`): nothing is counted. Exhausted: 429 with the seconds until the next calendar month
 * (UTC). A ledger or plan-catalog failure: 503 when the deployment is metered (failClosed), otherwise the capture goes
 * on uncounted. A malformed grant is never taken as permission.
 */
export async function chargeWebhookEvent(entitlements: Entitlements, organizationId: string, spentAt: Date): Promise<WebhookCharge> {
  if (!entitlements.spendMeter) return { ok: true, charged: 0 };
  let granted: number;
  try {
    granted = await entitlements.spendMeter(organizationId, "webhookEvents", 1, spentAt);
  } catch {
    console.error("webhook metering unavailable");
    if (!entitlements.failClosed) return { ok: true, charged: 0 };
    return { ok: false, status: 503, body: { error: "Usage metering is unavailable; nothing was captured. Try again shortly.", code: METERING_UNAVAILABLE }, retryAfter: 30 };
  }
  if (granted === 1) return { ok: true, charged: 1 };
  if (granted !== 0) console.error("webhook event allowance invalid");
  return {
    ok: false, status: 429,
    body: { error: "This workspace's webhook event allowance for the month is used up; nothing was captured.", code: WEBHOOK_QUOTA_EXHAUSTED },
    retryAfter: secondsUntil(calendarMonthUtc(spentAt).end, new Date()),
  };
}

export function mountMontralHooks({ app, authed }: { app: Hono<AppEnv>; authed: Hono<AppEnv> }) {
  const privateHooks = new Hono<AppEnv>();
  // One-time secret receiver URLs, inbox names and captured bodies are all
  // sensitive. Every success AND refusal must have the same privacy headers:
  // public webhooks may arrive through proxies, and errors are especially
  // likely to be retained by access-log/preview tooling.
  const hookPrivacy = async (c: import("hono").Context<AppEnv>, next: () => Promise<void>) => {
    c.header("cache-control", "private, no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    c.header("x-robots-tag", "noindex, nofollow");
    await next();
  };
  privateHooks.use("*", hookPrivacy);
  privateHooks.use("*", rejectInAllProjects);
  privateHooks.get("/inboxes", async (c) => {
    const rows = await c.get("database").query<Pick<HookInbox, "id"|"name"|"created_at">>(
      "SELECT id,name,created_at FROM montral_hook_inbox WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50",
      [c.get("orgId"), c.get("projectId")],
    );
    return c.json({ inboxes: rows });
  });
  privateHooks.post("/inboxes", requireManager, async (c) => {
    let incoming: Awaited<ReturnType<typeof readInboxCreation>>;
    try {
      incoming = await readInboxCreation(c.req.raw);
    } catch (error) {
      if (error instanceof InboxCreationTimeoutError) return c.json({ error: error.message }, 408);
      throw error;
    }
    if (incoming.oversized) return c.json({ error: "Payload too large" }, 413);
    const parsed = listInbox.safeParse(incoming.value);
    if (!parsed.success) return c.json({ error: "Invalid inbox name" }, 400);
    const db = c.get("database");
    const scope = [c.get("orgId"), c.get("projectId")];
    const id = crypto.randomUUID();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    // The database function acquires its lock THEN counts under a fresh statement
    // snapshot in the same transaction; this is safe with multiple Workers/Node
    // instances using independent PostgreSQL connections.
    const created = await db.query<{ id: string | null }>(
      "SELECT montral_create_hook_inbox($1::uuid,$2::text,$3::text,$4::text,$5::text) AS id",
      [id, ...scope, parsed.data.name, await fingerprint(token)],
    );
    if (!created[0]?.id) return c.json({ error: "Inbox limit reached" }, 409);
    // the secret receiver path is never recorded
    await audit(c, "hook_inbox.create", { type: "hook_inbox", id }, auditChanges({ name: parsed.data.name }));
    return c.json({ id, name: parsed.data.name, path: `/api/hooks/receive/${id}/${token}`, warning: "This secret URL is shown only once. Treat it like a password." }, 201);
  });
  privateHooks.get("/inboxes/:id/events", uuidParams, requireManager, async (c) => {
    const scope = [c.req.param("id"), c.get("orgId"), c.get("projectId")];
    const db = c.get("database");
    const inbox = await db.query<{ id:string }>(
      "SELECT id FROM montral_hook_inbox WHERE id=$1 AND organization_id=$2 AND project_id=$3", scope,
    );
    if (!inbox.length) return c.json({ error: "Not found" }, 404);
    // Up to 250 events are retained, so pages are keyset-ordered by
    // (created_at, id); the cursor is the last event id the caller saw.
    const filter = eventQuery.safeParse(c.req.query());
    if (!filter.success) return c.json({ error: "Invalid event filter" }, 400);
    const { before, method, q } = filter.data;
    const params: unknown[] = [...scope];
    let where = "e.inbox_id=$1 AND e.organization_id=$2 AND e.project_id=$3 AND e.created_at > NOW() - INTERVAL '7 days'";
    if (before) {
      // Read the cursor position once, at full microsecond precision as text,
      // so a concurrent eviction of the cursor row cannot turn the comparison
      // into NULL and silently end paging.
      const cursor = await db.query<{ at: string }>("SELECT created_at::text AS at FROM montral_hook_event WHERE id=$1 AND inbox_id=$2", [before, scope[0]]);
      // The cursor event was evicted by retention; the caller must start over.
      if (!cursor.length) return c.json({ error: "These events are no longer retained. Refresh the list." }, 410);
      params.push(cursor[0].at, before);
      where += ` AND (e.created_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    if (method) { params.push(method); where += ` AND e.method=$${params.length}`; }
    if (q) {
      params.push("%" + q.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%");
      where += ` AND (e.body ILIKE $${params.length} OR e.content_type ILIKE $${params.length} OR e.headers::text ILIKE $${params.length})`;
    }
    const rows = await db.query<HookEvent>(
      `SELECT e.id,e.method,e.content_type,e.headers,e.body,e.created_at,e.response_status FROM montral_hook_event e WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ${EVENT_PAGE + 1}`, params,
    );
    const more = rows.length > EVENT_PAGE;
    const events = more ? rows.slice(0, EVENT_PAGE) : rows;
    return c.json({ events, next: more ? events[events.length - 1].id : null });
  });
  // One captured event; `sid` so the shared UUID validation covers it too.
  privateHooks.delete("/inboxes/:id/events/:sid", uuidParams, requireManager, async (c) => {
    const removed = await c.get("database").query<{ id: string }>(
      "DELETE FROM montral_hook_event WHERE id=$1 AND inbox_id=$2 AND organization_id=$3 AND project_id=$4 RETURNING id",
      [c.req.param("sid"), c.req.param("id"), c.get("orgId"), c.get("projectId")],
    );
    if (!removed.length) return c.json({ error: "Not found" }, 404);
    await audit(c, "hook_event.delete", { type: "hook_event", id: c.req.param("sid") });
    return c.body(null, 204);
  });
  /**
   * Development replay: resend one captured request to a URL the manager
   * supplies. Outbound requests get the same SSRF protection as monitor
   * checks (private, loopback and metadata targets refused unless the
   * operator set ALLOW_PRIVATE_TARGETS; DNS pinned), redirects are not
   * followed, and only the stored allowlisted headers are sent. Nothing about
   * the replay is stored.
   */
  privateHooks.post("/inboxes/:id/events/:sid/replay", uuidParams, requireManager, async (c) => {
    let incoming: Awaited<ReturnType<typeof readInboxCreation>>;
    try {
      incoming = await readInboxCreation(c.req.raw);
    } catch (error) {
      if (error instanceof InboxCreationTimeoutError) return c.json({ error: error.message }, 408);
      throw error;
    }
    if (incoming.oversized) return c.json({ error: "Payload too large" }, 413);
    const parsed = replayTarget.safeParse(incoming.value);
    if (!parsed.success) return c.json({ error: "Provide an http(s) url to replay to" }, 400);
    // Replay sends requests from Montral's network; agents may not trigger it.
    if (c.get("requestPrincipal")?.kind === "oauth") return c.json({ error: "Replay is not available to authorized agents" }, 403);
    const inboxId = c.req.param("id");
    const rows = await c.get("database").query<HookEvent>(
      "SELECT id,method,content_type,headers,body,created_at FROM montral_hook_event WHERE id=$1 AND inbox_id=$2 AND organization_id=$3 AND project_id=$4",
      [c.req.param("sid"), inboxId, c.get("orgId"), c.get("projectId")],
    );
    const event = rows[0];
    if (!event) return c.json({ error: "Not found" }, 404);
    // Per inbox and per workspace, so more inboxes or projects do not multiply it.
    const repo = c.get("repo");
    if (!(await allow(repo, `montral:hook-replay:${inboxId}`, 20, 60)) || !(await allow(repo, `montral:hook-replay-org:${c.get("orgId")}`, 60, 60))
      || !(await allow(repo, `montral:hook-replay-user:${c.get("userId")}`, 60, 60))) {
      return c.json({ error: "Too many replays" }, 429);
    }
    const headers: Record<string, string> = { "user-agent": checkUserAgent(), "x-montral-replay": event.id };
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (name !== "user-agent" && typeof value === "string") headers[name] = value;
    }
    if (event.content_type) headers["content-type"] = event.content_type;
    const signal = AbortSignal.timeout(REPLAY_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await replayFetch(parsed.data.url, { method: event.method, headers, body: event.body, signal }, c.env.MONTRAL_REPLAY_PRIVATE_TARGETS === "true");
      const { text, truncated } = await readReplayBody(res, REPLAY_RESPONSE_BYTES, signal);
      // the replay URL (which can carry credentials) and the response are never recorded
      await audit(c, "hook_event.replay", { type: "hook_event", id: event.id }, auditChanges({ url: true }, { method: event.method }));
      return c.json({ status: res.status, contentType: res.headers.get("content-type"), body: text, truncated, durationMs: Date.now() - started });
    } catch (error) {
      if (error instanceof BlockedTarget) return c.json({ error: error.message, code: "target_not_allowed" }, 400);
      // Fixed messages only: network errors can echo internal addresses.
      if (signal.aborted) return c.json({ error: "The target did not answer within 10 seconds" }, 504);
      return c.json({ error: "Could not reach the target" }, 502);
    }
  });
  /**
   * What the public receiver answers for this inbox. Managers only for reads
   * too: a configured body or header may hold values the team treats as secret.
   * Refusals (404, 408, 413, 422, 429) never use it, and replay never does.
   */
  privateHooks.get("/inboxes/:id/response", uuidParams, requireManager, async (c) => {
    const rows = await c.get("database").query<{ response: HookResponseConfig | null }>(
      "SELECT response FROM montral_hook_inbox WHERE id=$1 AND organization_id=$2 AND project_id=$3",
      [c.req.param("id"), c.get("orgId"), c.get("projectId")],
    );
    if (!rows.length) return c.json({ error: "Not found" }, 404);
    return c.json({ response: rows[0].response ?? null });
  });
  privateHooks.put("/inboxes/:id/response", uuidParams, requireManager, async (c) => {
    let incoming: Awaited<ReturnType<typeof readInboxCreation>>;
    try {
      incoming = await readInboxCreation(c.req.raw, INBOX_CREATE_READ_MS, RESPONSE_LIMITS.maxRequestBytes);
    } catch (error) {
      if (error instanceof InboxCreationTimeoutError) return c.json({ error: "Request body read timeout" }, 408);
      throw error;
    }
    if (incoming.oversized) return c.json({ error: "Payload too large" }, 413);
    const parsed = parseHookResponseConfig(incoming.value);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const config = parsed.value;
    const updated = await c.get("database").query<{ id: string }>(
      "UPDATE montral_hook_inbox SET response=$4::jsonb WHERE id=$1 AND organization_id=$2 AND project_id=$3 RETURNING id",
      [c.req.param("id"), c.get("orgId"), c.get("projectId"), JSON.stringify(config)],
    );
    if (!updated.length) return c.json({ error: "Not found" }, 404);
    // Field names, statuses, the delay and the hosts redirects point to: bodies, header values and full redirect URLs
    // are never recorded. Each method's override has its own status, so a redirecting override is visible.
    const hosts = [config.location, ...Object.values(config.methods ?? {}).map((v) => v?.location)]
      .filter((l): l is string => !!l).map((l) => URL.parse(l)?.host ?? "").filter(Boolean);
    await audit(c, "hook_inbox.response_update", { type: "hook_inbox", id: c.req.param("id") }, auditChanges({
      status: config.status, contentType: config.contentType, delayMs: config.delayMs,
      body: config.body ? true : undefined, headers: config.headers.length ? true : undefined,
      location: config.location ? true : undefined, methods: config.methods ? true : undefined,
    }, {
      ...(config.methods?.POST ? { postStatus: config.methods.POST.status } : {}),
      ...(config.methods?.PUT ? { putStatus: config.methods.PUT.status } : {}),
      ...(config.methods?.PATCH ? { patchStatus: config.methods.PATCH.status } : {}),
      ...(hosts.length ? { redirectHost: [...new Set(hosts)].join(", ") } : {}),
    }));
    return c.json({ response: config });
  });
  privateHooks.delete("/inboxes/:id/response", uuidParams, requireManager, async (c) => {
    const updated = await c.get("database").query<{ id: string }>(
      "UPDATE montral_hook_inbox SET response=NULL WHERE id=$1 AND organization_id=$2 AND project_id=$3 RETURNING id",
      [c.req.param("id"), c.get("orgId"), c.get("projectId")],
    );
    if (!updated.length) return c.json({ error: "Not found" }, 404);
    await audit(c, "hook_inbox.response_update", { type: "hook_inbox", id: c.req.param("id") }, auditChanges({ reset: true }));
    return c.body(null, 204);
  });
  privateHooks.delete("/inboxes/:id", uuidParams, requireManager, async (c) => {
    const deleted = await c.get("database").query(
      "DELETE FROM montral_hook_inbox WHERE id=$1 AND organization_id=$2 AND project_id=$3 RETURNING id",
      [c.req.param("id"), c.get("orgId"), c.get("projectId")],
    );
    if (!deleted.length) return c.json({ error: "Not found" }, 404);
    await audit(c, "hook_inbox.delete", { type: "hook_inbox", id: c.req.param("id") });
    return c.body(null, 204);
  });
  authed.route("/hooks", privateHooks);

  const publicHooks = new Hono<AppEnv>();
  // The token is a bearer credential in a URL; protect 202, 404, 413, 422
  // and 429 responses uniformly, not only successful captures.
  publicHooks.use("*", hookPrivacy);
  publicHooks.on(["POST", "PUT", "PATCH"], "/:id/:token", async (c) => {
    const { id, token } = c.req.param();
    if (!UUID.test(id) || !TOKEN.test(token)) return c.json({ error: "Not found" }, 404);
    const db = c.get("database");
    const found = await db.query<HookInbox & { suspended: boolean }>(
      `SELECT id,organization_id,project_id,token_hash,
         EXISTS (SELECT 1 FROM workspace_suspension s WHERE s.organization_id=montral_hook_inbox.organization_id) AS suspended
       FROM montral_hook_inbox WHERE id=$1`, [id],
    );
    const inbox = found[0];
    if (!inbox || !sameHash(await fingerprint(token), inbox.token_hash)) return c.json({ error: "Not found" }, 404);
    // a workspace suspended by a platform operator captures nothing; only a sender holding the secret URL learns why
    if (inbox.suspended) return c.json({ error: "This workspace is suspended", code: WORKSPACE_SUSPENDED }, 403);
    if (!(await allow(c.get("repo"), `montral:hook:${id}`, 120, 60))) return c.json({ error: "Too many events" }, 429);
    let payload: string | null;
    try {
      payload = await readPayload(c.req.raw);
    } catch (error) {
      if (error instanceof InvalidWebhookPayloadError) return c.json({ error: error.message }, 422);
      if (error instanceof WebhookPayloadTimeoutError) return c.json({ error: error.message }, 408);
      throw error;
    }
    if (payload === null) return c.json({ error: "Payload too large (32 KiB)" }, 413);
    // A metered deployment charges one webhook event per capture BEFORE anything is stored: an exhausted allowance
    // (429 until the next period) or an unreachable ledger (503, fail closed) stores nothing.
    const entitlements = c.get("entitlements");
    const spentAt = new Date();
    const charge = await chargeWebhookEvent(entitlements, inbox.organization_id, spentAt);
    if (!charge.ok) {
      if (charge.retryAfter !== undefined) c.header("retry-after", String(charge.retryAfter));
      return c.json(charge.body, charge.status);
    }
    // a capture that then stores nothing (inbox deleted meanwhile, database error) gives its event back
    const giveBack = () => charge.charged > 0 ? entitlements.refundMeter?.(inbox.organization_id, "webhookEvents", charge.charged, spentAt).catch(() => console.error("webhook event refund failed")) : undefined;
    // Re-check the secret and inbox under a row lock in the same transaction as
    // the INSERT and retention pruning. If it was deleted while we streamed the
    // body, return 404 instead of raising a foreign-key error or leaking data.
    // The full response configuration comes back from the capture, read under that lock.
    const eventId = crypto.randomUUID();
    let captured: { result: { status: number; response: unknown } | null }[];
    try {
      captured = await db.query<{ result: { status: number; response: unknown } | null }>(
        "SELECT montral_capture_hook_event_v2($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS result",
        [id, await fingerprint(token), eventId, c.req.method,
          (c.req.header("content-type") ?? "").slice(0, 256) || null,
          JSON.stringify(capturedHeaders(c.req.raw.headers)), payload],
      );
    } catch (error) {
      await giveBack();
      throw error;
    }
    const result = captured[0]?.result;
    if (!result) {
      await giveBack();
      return c.json({ error: "Not found" }, 404);
    }
    const stored = typeof result.response === "string" ? JSON.parse(result.response) as unknown : result.response;
    const config = stored ? parseHookResponseConfig(stored) : null;
    const variant = config?.ok ? responseVariant(config.value, c.req.method) : null;
    // The event records what is actually sent. The SQL function's choice can
    // only differ for a stored configuration that fails validation here (the
    // default 202 is sent instead); correct the record before answering.
    const sent = variant ? variant.status : 202;
    if (Number(result.status) !== sent) {
      await db.query("UPDATE montral_hook_event SET response_status=$2 WHERE id=$1 AND inbox_id=$3", [eventId, sent, id]);
    }
    if (!config?.ok || !variant) return c.json({ received: true }, 202);
    if (config.value.delayMs > 0) {
      // Taken only now, after the body was read and the event stored. No free
      // slot (inbox, organization or process) means: answer at once, without
      // the delay. The delay never prevents capture.
      const release = hookDelaySlots.acquire(id, inbox.organization_id);
      if (release) {
        // nothing below reads the database: hand the connection back before sleeping, so held delays cannot exhaust
        // PostgreSQL connections (Workers opens one per request; Node's shared pool is unaffected)
        releaseDatabase(c);
        try { await boundedDelay(config.value.delayMs, c.req.raw.signal); } finally { release(); }
      }
    }
    const out = buildConfiguredResponse(variant);
    return out.body === null ? c.body(null, out.status as 204, out.headers) : c.body(out.body, out.status as 200, out.headers);
  });
  app.route("/api/hooks/receive", publicHooks);
}
