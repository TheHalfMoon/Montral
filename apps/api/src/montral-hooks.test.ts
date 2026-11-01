import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { capturedHeaders, fingerprint, mountMontralHooks, readPayload, sameHash, InvalidWebhookPayloadError } from "./montral-hooks";

function fixture(allowReceipt = true) {
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
  const repo = { memberRole: async () => member, withinLimit: async () => allowReceipt };
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

/** Secret receiver paths must never be cacheable, indexable or referrable,
 * even for invalid tokens or rejected payloads (and private manager views). */
function expectPrivateHookHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
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
  it("does not wait for a stalled upstream cancel after the webhook body exceeds 32 KiB", async () => {
    let canceled = false;
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(16 * 1024).fill(65)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("https://example.invalid/receive", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      readPayload(request),
      new Promise<"stalled">(resolve => setTimeout(() => resolve("stalled"), 200)),
    ]);
    expect(outcome).toBeNull();
    expect(canceled).toBe(true);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("bounds a sender that drips a byte then stalls indefinitely, even if cancel never finishes", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([65])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("https://example.invalid/receive", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      readPayload(request, 30).then(() => "accepted", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-stalled"), 150)),
    ]);
    expect(outcome).toBe("Webhook payload read timeout");
    expect(canceled).toBe(true);
  });

  it("answers HTTP 408 with private headers and no stored event when a valid sender stalls", async () => {
    const f = fixture();
    const create = await f.app.request("/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Slow sender"}',
    });
    const { path } = await create.json() as { path: string };
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([65])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost" + path, {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await f.app.fetch(request);
    expect(response.status).toBe(408);
    expectPrivateHookHeaders(response);
    expect(await response.json()).toEqual({ error: "Webhook payload read timeout" });
    expect(canceled).toBe(true);
    expect(f.events).toHaveLength(0);
  }, 15_000);

  it("responds HTTP 413 without inserting events if a public webhook sender never completes cancellation", async () => {
    const f = fixture();
    const create = await f.app.request("/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Stalled sender"}',
    });
    const { path } = await create.json() as { path: string };
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024).fill(65)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost" + path, {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await Promise.race([
      f.app.fetch(request),
      new Promise<"stalled">(resolve => setTimeout(() => resolve("stalled"), 200)),
    ]);
    expect(response).not.toBe("stalled");
    const rejected = response as Response;
    expect(rejected.status).toBe(413);
    expectPrivateHookHeaders(rejected);
    expect(canceled).toBe(true);
    expect(f.events).toHaveLength(0);
  });

  it("rejects raw NUL and invalid UTF-8 before PostgreSQL can reject or corrupt a capture", async () => {
    const raw = (bytes: Uint8Array) => new Request("https://example.invalid", {
      method: "POST", body: new Blob([bytes as BlobPart]),
    });
    for (const data of [new Uint8Array([65, 0, 66]), new Uint8Array([0xc3, 0x28])]) {
      await expect(readPayload(raw(data))).rejects.toBeInstanceOf(InvalidWebhookPayloadError);
    }
    expect(await readPayload(raw(new TextEncoder().encode('{"emoji":"🛠"}')))).toBe('{"emoji":"🛠"}');
    const f = fixture();
    const create = await f.app.request("/api/hooks/inboxes", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"name":"UTF8 check"}' });
    const { path } = await create.json() as { path: string };
    for (const data of [new Uint8Array([65, 0, 66]), new Uint8Array([0xc3, 0x28])]) {
      const res = await f.app.request(path, { method: "POST", body: data as BodyInit });
      expect(res.status).toBe(422);
      expectPrivateHookHeaders(res);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    expect(f.events).toHaveLength(0);
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
    expectPrivateHookHeaders(wrong);
    const received = await f.app.request(value.path, { method: "POST", headers: { authorization: "secret", "content-type": "application/json" }, body: '{"hello":"world"}' });
    expect(received.status).toBe(202);
    expectPrivateHookHeaders(received);
    const response = await f.app.request(`/api/hooks/inboxes/${value.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expectPrivateHookHeaders(response);
    const payload = await response.json() as { events: Array<{ body: string; headers: Record<string, string> }> };
    expect(payload.events[0].body).toBe('{"hello":"world"}');
    expect(payload.events[0].headers.authorization).toBeUndefined();
    f.setProject("project-b");
    const denied = await f.app.request(`/api/hooks/inboxes/${value.id}/events`);
    expect(denied.status).toBe(404);
    const list = await f.app.request("/api/hooks/inboxes");
    expectPrivateHookHeaders(list);
    expect(await list.json()).toEqual({ inboxes: [] });
  });
  it("protects secret receiver paths on 413 and rate-limit 429, not only 202/404/422", async () => {
    const normal = fixture();
    const create = await normal.app.request("/api/hooks/inboxes", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"name":"Private response"}' });
    expectPrivateHookHeaders(create);
    const { path } = await create.json() as { path: string };
    const oversized = await normal.app.request(path, { method: "POST", body: "x".repeat(33 * 1024) });
    expect(oversized.status).toBe(413);
    expectPrivateHookHeaders(oversized);

    const blocked = fixture(false);
    const setup = await blocked.app.request("/api/hooks/inboxes", { method: "POST",
      headers: { "content-type": "application/json" }, body: '{"name":"Rate-limited"}' });
    const { path: blockedPath } = await setup.json() as { path: string };
    const throttled = await blocked.app.request(blockedPath, { method: "POST", body: "should not be stored" });
    expect(throttled.status).toBe(429);
    expectPrivateHookHeaders(throttled);
    expect(blocked.events).toHaveLength(0);
  });

  it("rejects oversized inbox creation JSON before parsing or writing any secret receiver", async () => {
    const f = fixture();
    const oversized = await f.app.request("/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", padding: "A".repeat(8 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "Payload too large" });
    expectPrivateHookHeaders(oversized);
    expect(f.inboxes).toHaveLength(0);
  });

  it("does not trust a forged short Content-Length when inbox body is actually oversized", async () => {
    const f = fixture();
    const oversized = await f.app.fetch(new Request("http://localhost/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "5" },
      body: JSON.stringify({ name: "test", padding: "x".repeat(8 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
    expectPrivateHookHeaders(oversized);
    expect(f.inboxes).toHaveLength(0);
  });

  it("never waits for a streaming inbox sender that stalls while canceling", async () => {
    const f = fixture();
    let canceled = false;
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(2048).fill(88)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await Promise.race([
      f.app.fetch(request),
      new Promise<"stalled">(resolve => setTimeout(() => resolve("stalled"), 250)),
    ]);
    expect(result).not.toBe("stalled");
    const response = result as Response;
    expect(response.status).toBe(413);
    expectPrivateHookHeaders(response);
    expect(canceled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(5);
    expect(f.inboxes).toHaveLength(0);
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
