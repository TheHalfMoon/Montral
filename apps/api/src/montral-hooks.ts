import type { Database } from "@montral/repo";
import type { AppEnv } from "./env";
import { Hono } from "hono";
import { requireManager, rejectInAllProjects, uuidParams } from "./middleware";
import { allow } from "./ratelimit";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_BYTES = 32 * 1024;
const MAX_INBOXES = 10;
const listInbox = z.object({ name: z.string().trim().min(1).max(100) }).strict();

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
/** Bounded streamed read: does not allocate unbounded data from an arbitrary webhook sender. */
export async function readPayload(request: Request): Promise<string | null> {
  const size = Number(request.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return new TextDecoder().decode(bytes);
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
  return ["montral_hooks_v1"];
}

export function mountMontralHooks({ app, authed }: { app: Hono<AppEnv>; authed: Hono<AppEnv> }) {
  const privateHooks = new Hono<AppEnv>();
  privateHooks.use("*", rejectInAllProjects);
  privateHooks.get("/inboxes", async (c) => {
    const rows = await c.get("database").query<Pick<HookInbox, "id"|"name"|"created_at">>(
      "SELECT id,name,created_at FROM montral_hook_inbox WHERE organization_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50",
      [c.get("orgId"), c.get("projectId")],
    );
    return c.json({ inboxes: rows });
  });
  privateHooks.post("/inboxes", requireManager, async (c) => {
    const parsed = listInbox.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid inbox name" }, 400);
    const db = c.get("database");
    const scope = [c.get("orgId"), c.get("projectId")];
    const [{ count }] = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM montral_hook_inbox WHERE organization_id=$1 AND project_id=$2", scope,
    );
    if (Number(count) >= MAX_INBOXES) return c.json({ error: "Inbox limit reached" }, 402);
    const id = crypto.randomUUID();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    await db.query(
      "INSERT INTO montral_hook_inbox(id,organization_id,project_id,name,token_hash) VALUES($1,$2,$3,$4,$5)",
      [id, ...scope, parsed.data.name, await fingerprint(token)],
    );
    c.header("cache-control", "no-store");
    return c.json({ id, name: parsed.data.name, path: `/api/hooks/receive/${id}/${token}`, warning: "This secret URL is shown only once. Treat it like a password." }, 201);
  });
  privateHooks.get("/inboxes/:id/events", uuidParams, async (c) => {
    const scope = [c.req.param("id"), c.get("orgId"), c.get("projectId")];
    const db = c.get("database");
    const inbox = await db.query<{ id:string }>(
      "SELECT id FROM montral_hook_inbox WHERE id=$1 AND organization_id=$2 AND project_id=$3", scope,
    );
    if (!inbox.length) return c.json({ error: "Not found" }, 404);
    const rows = await db.query<HookEvent>(
      "SELECT id,method,content_type,headers,body,created_at FROM montral_hook_event WHERE inbox_id=$1 AND organization_id=$2 AND project_id=$3 AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 50", scope,
    );
    return c.json({ events: rows });
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
    const payload = await readPayload(c.req.raw);
    if (payload === null) return c.json({ error: "Payload too large (32 KiB)" }, 413);
    await db.query(
      "INSERT INTO montral_hook_event(id,inbox_id,organization_id,project_id,method,content_type,headers,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
      [crypto.randomUUID(), id, inbox.organization_id, inbox.project_id, c.req.method,
        (c.req.header("content-type") ?? "").slice(0, 256) || null,
        JSON.stringify(capturedHeaders(c.req.raw.headers)), payload],
    );
    // Retain a bounded recent window and discard expired events without a second scheduler.
    await db.query(
      "DELETE FROM montral_hook_event WHERE inbox_id=$1 AND (created_at < NOW() - INTERVAL '7 days' OR id IN (SELECT id FROM montral_hook_event WHERE inbox_id=$1 ORDER BY created_at DESC OFFSET 250))", [id],
    );
    c.header("cache-control", "no-store");
    return c.json({ received: true }, 202);
  });
  app.route("/api/hooks/receive", publicHooks);
}
