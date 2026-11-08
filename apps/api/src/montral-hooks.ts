import type { Database } from "@montral/repo";
import type { AppEnv } from "./env";
import { Hono } from "hono";
import { requireManager, rejectInAllProjects, uuidParams } from "./middleware";
import { allow } from "./ratelimit";
import { BlockedTarget, checkUserAgent, guardedFetch, readCapped, urlProblem } from "./netguard";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_BYTES = 32 * 1024;
const MAX_INBOXES = 10;
const listInbox = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const EVENT_PAGE = 50;
const REPLAY_TIMEOUT_MS = 10_000;
const REPLAY_RESPONSE_BYTES = 4 * 1024;
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
export async function readInboxCreation(request: Request, timeoutMs = INBOX_CREATE_READ_MS): Promise<{ oversized: boolean; value?: unknown }> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > INBOX_CREATE_MAX_BYTES) {
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
      if (value.byteLength > INBOX_CREATE_MAX_BYTES - size) return { oversized: true };
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
};

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
  await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_inbox_scope
    ON montral_hook_inbox (organization_id, project_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_hook_event (
    id uuid PRIMARY KEY, inbox_id uuid NOT NULL REFERENCES montral_hook_inbox(id) ON DELETE CASCADE,
    organization_id text NOT NULL, project_id text NOT NULL, method varchar(10) NOT NULL,
    content_type varchar(256), headers jsonb NOT NULL DEFAULT '{}'::jsonb, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_event_recent
    ON montral_hook_event (inbox_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS montral_hook_event_expiry
    ON montral_hook_event (created_at)`);
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
  return ["montral_hooks_v3"];
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
      `SELECT e.id,e.method,e.content_type,e.headers,e.body,e.created_at FROM montral_hook_event e WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ${EVENT_PAGE + 1}`, params,
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
    return removed.length ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
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
    const inboxId = c.req.param("id");
    const rows = await c.get("database").query<HookEvent>(
      "SELECT id,method,content_type,headers,body,created_at FROM montral_hook_event WHERE id=$1 AND inbox_id=$2 AND organization_id=$3 AND project_id=$4",
      [c.req.param("sid"), inboxId, c.get("orgId"), c.get("projectId")],
    );
    const event = rows[0];
    if (!event) return c.json({ error: "Not found" }, 404);
    if (!(await allow(c.get("repo"), `montral:hook-replay:${inboxId}`, 20, 60))) return c.json({ error: "Too many replays" }, 429);
    const refused = await urlProblem(parsed.data.url);
    if (refused) return c.json({ error: refused, code: "target_not_allowed" }, 400);
    const headers: Record<string, string> = { "user-agent": checkUserAgent(), "x-montral-replay": event.id };
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (name !== "user-agent" && typeof value === "string") headers[name] = value;
    }
    if (event.content_type) headers["content-type"] = event.content_type;
    const signal = AbortSignal.timeout(REPLAY_TIMEOUT_MS);
    const started = Date.now();
    try {
      const { res } = await guardedFetch(parsed.data.url, { method: event.method, headers, body: event.body, signal }, { follow: false });
      const text = await readCapped(res, REPLAY_RESPONSE_BYTES + 1, signal);
      return c.json({
        status: res.status,
        contentType: res.headers.get("content-type"),
        body: text.slice(0, REPLAY_RESPONSE_BYTES),
        truncated: text.length > REPLAY_RESPONSE_BYTES,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      if (error instanceof BlockedTarget) return c.json({ error: error.message, code: "target_not_allowed" }, 400);
      // Fixed messages only: network errors can echo internal addresses.
      if (signal.aborted) return c.json({ error: "The target did not answer within 10 seconds" }, 504);
      return c.json({ error: "Could not reach the target" }, 502);
    }
  });
  privateHooks.delete("/inboxes/:id", uuidParams, requireManager, async (c) => {
    const deleted = await c.get("database").query(
      "DELETE FROM montral_hook_inbox WHERE id=$1 AND organization_id=$2 AND project_id=$3 RETURNING id",
      [c.req.param("id"), c.get("orgId"), c.get("projectId")],
    );
    return deleted.length ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
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
    const found = await db.query<HookInbox>(
      "SELECT id,organization_id,project_id,token_hash FROM montral_hook_inbox WHERE id=$1", [id],
    );
    const inbox = found[0];
    if (!inbox || !sameHash(await fingerprint(token), inbox.token_hash)) return c.json({ error: "Not found" }, 404);
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
    // Re-check the secret and inbox under a row lock in the same transaction as
    // the INSERT and retention pruning. If it was deleted while we streamed the
    // body, return 404 instead of raising a foreign-key error or leaking data.
    const captured = await db.query<{ accepted: boolean }>(
      "SELECT montral_capture_hook_event($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS accepted",
      [id, await fingerprint(token), crypto.randomUUID(), c.req.method,
        (c.req.header("content-type") ?? "").slice(0, 256) || null,
        JSON.stringify(capturedHeaders(c.req.raw.headers)), payload],
    );
    if (!captured[0]?.accepted) return c.json({ error: "Not found" }, 404);
    return c.json({ received: true }, 202);
  });
  app.route("/api/hooks/receive", publicHooks);
}
