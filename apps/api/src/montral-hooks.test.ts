import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { capturedHeaders, fingerprint, mountMontralHooks, readPayload, sameHash } from "./montral-hooks";

function fixture() {
  const inboxes: Array<{ id: string; organization_id: string; project_id: string; name: string; token_hash: string }> = [];
  const events: Array<{ id: string; inbox_id: string; organization_id: string; project_id: string; body: string; headers: unknown }> = [];
  let member = "owner";
  let projectId = "project-a";
  const db = {
    query: async (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> => {
      if (sql.includes("montral_create_hook_inbox")) {
        if (inboxes.filter(i => i.organization_id === args[1] && i.project_id === args[2]).length >= 10) return [{ id: null }];
        inboxes.push({ id: String(args[0]), organization_id: String(args[1]), project_id: String(args[2]), name: String(args[3]), token_hash: String(args[4]) });
        return [{ id: String(args[0]) }];
      }
      if (sql.startsWith("SELECT id,name,created_at")) return inboxes.filter((i) => i.organization_id === args[0] && i.project_id === args[1]).map((i) => ({ id: i.id, name: i.name, created_at: new Date() }));
      if (sql.startsWith("SELECT id FROM montral_hook_inbox")) return inboxes.filter((i) => i.id === args[0] && i.organization_id === args[1] && i.project_id === args[2]).map((i) => ({ id: i.id }));
      if (sql.startsWith("SELECT id,organization_id,project_id,token_hash")) return inboxes.filter((i) => i.id === args[0]);
      if (sql.includes("montral_capture_hook_event")) {
        const inbox = inboxes.find(i => i.id === args[0] && i.token_hash === args[1]);
        if (!inbox) return [{ accepted: false }];
        events.push({ id: String(args[2]), inbox_id: inbox.id,
          organization_id: inbox.organization_id, project_id: inbox.project_id,
          body: String(args[6]), headers: JSON.parse(String(args[5])) });
        const matching = events.filter(e => e.inbox_id === inbox.id);
        if (matching.length > 250) {
          const excess = new Set(matching.slice(0, matching.length - 250).map(e => e.id));
          for (let n = events.length - 1; n >= 0; n--) if (excess.has(events[n].id)) events.splice(n, 1);
        }
        return [{ accepted: true }];
      }
      if (sql.startsWith("SELECT id,method,content_type,headers,body,created_at")) return events.filter((e) => e.inbox_id === args[0] && e.organization_id === args[1] && e.project_id === args[2]).map((e) => ({ ...e, method: "POST", content_type: "application/json", created_at: new Date() }));
      if (sql.startsWith("DELETE FROM montral_hook_inbox")) {
        const i = inboxes.findIndex((r) => r.id === args[0] && r.organization_id === args[1] && r.project_id === args[2]);
        return i === -1 ? [] : [inboxes.splice(i, 1)[0]];
      }
      if (sql.startsWith("DELETE FROM montral_hook_event")) return [];
      throw new Error("Unexpected SQL: " + sql);
    },
  };
  const repo = { memberRole: async () => member, withinLimit: async () => true };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("repo", repo as never);
    c.set("database", db as never);
    c.set("orgId", "org-a");
    c.set("projectId", projectId);
    c.set("allProjects", false);
    c.set("userId", "user-a");
    await next();
  });
  const authed = new Hono<AppEnv>();
  mountMontralHooks({ app, authed });
  app.route("/api", authed);
  return { app, inboxes, events, setMember: (m: string) => { member = m; }, setProject: (p: string) => { projectId = p; } };
}

describe("Montral webhook security", () => {
  it("hashes secret tokens without exposing plaintext in stored data", async () => {
    const secret = "ab".repeat(32);
    expect((await fingerprint(secret)).length).toBe(64);
    expect(await fingerprint(secret)).not.toBe(secret);
    expect(sameHash(await fingerprint(secret), await fingerprint(secret))).toBe(true);
    expect(sameHash(await fingerprint(secret), await fingerprint("cd".repeat(32)))).toBe(false);
    expect(sameHash("bad", "bad")).toBe(false);
  });
  it("captures only safe headers, excluding authorization and cookies", () => {
    expect(capturedHeaders(new Headers({ authorization: "Bearer secret", cookie: "a=1", "x-event-type": "push", "content-type": "application/json" }))).toEqual({ "content-type": "application/json", "x-event-type": "push" });
  });
  it("rejects oversized bodies even without content-length", async () => {
    expect(await readPayload(new Request("https://example.invalid", { method: "POST", body: "a".repeat(33 * 1024) }))).toBeNull();
    expect(await readPayload(new Request("https://example.invalid", { method: "POST", body: "ok" }))).toBe("ok");
  });
  it("creates a scoped inbox, captures a signed event, and denies other project access", async () => {
    const f = fixture();
    const create = await f.app.request("/api/hooks/inboxes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Billing" }) });
    expect(create.status).toBe(201);
    const value = await create.json() as { id: string; path: string };
    expect(value.path).toMatch(/^\/api\/hooks\/receive\/[0-9a-f-]+\/[0-9a-f]{64}$/);
    expect(f.inboxes[0].token_hash).not.toBe(value.path.split("/").at(-1));
    const wrong = await f.app.request(value.path.slice(0, -1) + (value.path.endsWith("0") ? "1" : "0"), { method: "POST", body: "bad" });
    expect(wrong.status).toBe(404);
    const received = await f.app.request(value.path, { method: "POST", headers: { authorization: "secret", "content-type": "application/json" }, body: '{"hello":"world"}' });
    expect(received.status).toBe(202);
    const response = await f.app.request(`/api/hooks/inboxes/${value.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload = await response.json() as { events: Array<{ body: string; headers: Record<string, string> }> };
    expect(payload.events[0].body).toBe('{"hello":"world"}');
    expect(payload.events[0].headers.authorization).toBeUndefined();
    f.setProject("project-b");
    const denied = await f.app.request(`/api/hooks/inboxes/${value.id}/events`);
    expect(denied.status).toBe(404);
    const list = await f.app.request("/api/hooks/inboxes");
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ inboxes: [] });
  });
  it("requires workspace manager for inbox creation and reading sensitive event bodies", async () => {
    const f = fixture();
    f.setMember("member");
    const res = await f.app.request("/api/hooks/inboxes", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"unauthorized"}' });
    expect(res.status).toBe(403);
    const eventRead = await f.app.request("/api/hooks/inboxes/00000000-0000-4000-8000-000000000000/events");
    expect(eventRead.status).toBe(403);
  });
});
