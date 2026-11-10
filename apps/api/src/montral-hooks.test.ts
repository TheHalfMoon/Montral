import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { capturedHeaders, fingerprint, hookDelaySlots, mountMontralHooks, replayAddressForbidden, readInboxCreation, readPayload, sameHash, InvalidWebhookPayloadError } from "./montral-hooks";

function fixture(allowReceipt = true) {
  const inboxes: Array<{ id: string; organization_id: string; project_id: string; name: string; token_hash: string; response?: any }> = [];
  const events: Array<{ id: string; inbox_id: string; organization_id: string; project_id: string; body: string; headers: unknown; response_status?: number | null }> = [];
  const audits: Array<{ action: string; changes: unknown }> = [];
  let member = "owner";
  let projectId = "project-a";
  const closed: number[] = [];
  const db = {
    close: async () => { closed.push(Date.now()); },
    query: async (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> => {
      if (sql.includes("montral_create_hook_inbox")) {
        if (inboxes.filter(i => i.organization_id === args[1] && i.project_id === args[2]).length >= 10) return [{ id: null }];
        inboxes.push({ id: String(args[0]), organization_id: String(args[1]), project_id: String(args[2]), name: String(args[3]), token_hash: String(args[4]) });
        return [{ id: String(args[0]) }];
      }
      if (sql.startsWith("SELECT id,name,created_at")) return inboxes.filter((i) => i.organization_id === args[0] && i.project_id === args[1]).map((i) => ({ id: i.id, name: i.name, created_at: new Date() }));
      if (sql.startsWith("SELECT id FROM montral_hook_inbox")) return inboxes.filter((i) => i.id === args[0] && i.organization_id === args[1] && i.project_id === args[2]).map((i) => ({ id: i.id }));
      if (sql.startsWith("SELECT id,organization_id,project_id,token_hash")) return inboxes.filter((i) => i.id === args[0]).map((i) => ({ ...i, delay_ms: i.response?.delayMs ?? 0 }));
      if (sql.startsWith("SELECT response FROM montral_hook_inbox")) return inboxes.filter((i) => i.id === args[0] && i.organization_id === args[1] && i.project_id === args[2]).map((i) => ({ response: i.response ?? null }));
      if (sql.startsWith("UPDATE montral_hook_inbox SET response=")) {
        const inbox = inboxes.find((i) => i.id === args[0] && i.organization_id === args[1] && i.project_id === args[2]);
        if (!inbox) return [];
        inbox.response = sql.includes("response=NULL") ? null : JSON.parse(String(args[3]));
        return [{ id: inbox.id }];
      }
      if (sql.startsWith("UPDATE montral_hook_event SET response_status=")) {
        const event = events.find((e) => e.id === args[0] && e.inbox_id === args[2]);
        if (event) event.response_status = Number(args[1]);
        return [];
      }
      if (sql.includes("INSERT INTO audit_event")) { audits.push({ action: String(args[8]), changes: args[11] ? JSON.parse(String(args[11])) : null }); return []; }
      if (sql.includes("montral_capture_hook_event_v2")) {
        const inbox = inboxes.find(i => i.id === args[0] && i.token_hash === args[1]);
        if (!inbox) return [{ result: null }];
        const status = (inbox.response?.methods?.[String(args[3])] ?? inbox.response)?.status ?? 202;
        events.push({ id: String(args[2]), inbox_id: inbox.id, organization_id: inbox.organization_id, project_id: inbox.project_id,
          body: String(args[6]), headers: JSON.parse(String(args[5])), response_status: status });
        return [{ result: { status, response: inbox.response ?? null } }];
      }
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
      if (sql.startsWith("SELECT e.id,e.method,e.content_type,e.headers,e.body,e.created_at")) return events.filter((e) => e.inbox_id === args[0] && e.organization_id === args[1] && e.project_id === args[2]).map((e) => ({ ...e, method: "POST", content_type: "application/json", created_at: new Date() }));
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
  return { app, inboxes, events, audits, closed, setMember: (m: string) => { member = m; }, setProject: (p: string) => { projectId = p; } };
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

  it("bounds a one-byte inbox creation upload that stalls with a non-settling cancellation", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/hooks/inboxes", {
      method: "POST", body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await Promise.race([
      readInboxCreation(request, 30).then(() => "unexpected-accept", (error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve("still-stalled"), 160)),
    ]);
    expect(result).toBe("Inbox creation body read timeout");
    expect(canceled).toBe(true);
  });

  it("returns private HTTP 408 without creating any inbox when an authenticated upload stalls", async () => {
    const f = fixture();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"name":"stalled"')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/hooks/inboxes", {
      method: "POST", headers: { "content-type": "application/json" },
      body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await f.app.fetch(request);
    expect(response.status).toBe(408);
    expectPrivateHookHeaders(response);
    expect(await response.json()).toEqual({ error: "Inbox creation body read timeout" });
    expect(canceled).toBe(true);
    expect(f.inboxes).toHaveLength(0);
  }, 15_000);

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

describe("configurable receiver responses", () => {
  async function inbox(f: ReturnType<typeof fixture>) {
    const res = await f.app.request("/api/hooks/inboxes", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mock"}' });
    return await res.json() as { id: string; path: string };
  }
  const put = (f: ReturnType<typeof fixture>, id: string, body: unknown) => f.app.request(`/api/hooks/inboxes/${id}/response`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("answers captured requests with the configured status, headers and body, keeping privacy headers", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    expect(await (await f.app.request(`/api/hooks/inboxes/${id}/response`)).json()).toEqual({ response: null });
    const saved = await put(f, id, { status: 201, contentType: "application/json", body: '{"mock":true}', headers: [{ name: "X-Mock-Id", value: "m-1" }] });
    expect(saved.status).toBe(200);
    expectPrivateHookHeaders(saved);
    expect((await saved.json() as { response: { status: number } }).response.status).toBe(201);
    const res = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: '{"in":1}' });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"mock":true}');
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-mock-id")).toBe("m-1");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expectPrivateHookHeaders(res);
    expect(f.events.at(-1)).toMatchObject({ body: '{"in":1}', response_status: 201 });
    expect(f.audits.map((a) => a.action)).toContain("hook_inbox.response_update");
    const recorded = f.audits.find((a) => a.action === "hook_inbox.response_update")!.changes as { fields: string[]; values: Record<string, unknown> };
    expect(recorded.fields).toEqual(expect.arrayContaining(["status", "body", "headers"]));
    expect(recorded.values).toEqual({ status: 201 });
    expect(JSON.stringify(recorded)).not.toContain("m-1");
    expect(JSON.stringify(recorded)).not.toContain("mock");
  });

  it("uses per-method overrides, redirects with a location, and bodyless statuses", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    expect((await put(f, id, { status: 302, location: "https://example.com/next", methods: { PUT: { status: 204 }, PATCH: { status: 418, body: "teapot" } } })).status).toBe(200);
    // the audit shows each method's status and the redirect's host, never the full redirect URL or a body
    const recorded = f.audits.filter((a) => a.action === "hook_inbox.response_update").at(-1)!.changes as { values: Record<string, unknown> };
    expect(recorded.values).toEqual({ status: 302, putStatus: 204, patchStatus: 418, redirectHost: "example.com" });
    expect(JSON.stringify(recorded)).not.toContain("/next");
    expect(JSON.stringify(recorded)).not.toContain("teapot");
    const post = await f.app.request(path, { method: "POST", body: "a" });
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe("https://example.com/next");
    const putRes = await f.app.request(path, { method: "PUT", body: "b" });
    expect(putRes.status).toBe(204);
    expect(putRes.headers.get("content-type")).toBeNull();
    expect(await putRes.text()).toBe("");
    expectPrivateHookHeaders(putRes);
    const patch = await f.app.request(path, { method: "PATCH", body: "c" });
    expect(patch.status).toBe(418);
    expect(await patch.text()).toBe("teapot");
    expect(f.events.map((e) => e.response_status)).toEqual([302, 204, 418]);
  });

  it("refuses invalid configurations with 400 and stores nothing", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    for (const bad of [
      { status: 101 }, { status: 302, location: "javascript:alert(1)" }, { contentType: "text/html", body: "<script>1</script>" },
      { headers: [{ name: "Set-Cookie", value: "session=x" }] }, { headers: [{ name: "Access-Control-Allow-Origin", value: "*" }] },
      { headers: [{ name: "X-Test", value: "a\r\nSet-Cookie: b=1" }] }, { delayMs: 60_000 }, { unknown: true },
    ]) {
      const res = await put(f, id, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expectPrivateHookHeaders(res);
    }
    expect((await put(f, id, "{not json")).status).toBe(400);
    expect(f.inboxes[0].response).toBeUndefined();
    const res = await f.app.request(path, { method: "POST", body: "x" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: true });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("caps the configuration request size before parsing", async () => {
    const f = fixture();
    const { id } = await inbox(f);
    const res = await put(f, id, { body: "x".repeat(600 * 1024) });
    expect(res.status).toBe(413);
    expectPrivateHookHeaders(res);
  });

  it("keeps the fixed refusal answers whatever is configured", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 200, body: "configured", headers: [{ name: "X-Mock", value: "1" }] });
    const wrong = await f.app.request(path.slice(0, -1) + (path.endsWith("0") ? "1" : "0"), { method: "POST", body: "x" });
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get("x-mock")).toBeNull();
    const big = await f.app.request(path, { method: "POST", body: "x".repeat(33 * 1024) });
    expect(big.status).toBe(413);
    expect(big.headers.get("x-mock")).toBeNull();
    const bad = await f.app.request(path, { method: "POST", body: new Uint8Array([65, 0, 66]) as BodyInit });
    expect(bad.status).toBe(422);
    expect(bad.headers.get("x-mock")).toBeNull();
    for (const r of [wrong, big, bad]) expectPrivateHookHeaders(r);

    const limited = fixture(false);
    const other = await inbox(limited);
    await put(limited, other.id, { status: 200, body: "configured" });
    const throttled = await limited.app.request(other.path, { method: "POST", body: "x" });
    expect(throttled.status).toBe(429);
    expect(await throttled.text()).not.toContain("configured");
    expectPrivateHookHeaders(throttled);
  });

  it("resets to the default 202 and records the reset", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 500, body: "down" });
    expect((await f.app.request(path, { method: "POST", body: "x" })).status).toBe(500);
    const reset = await f.app.request(`/api/hooks/inboxes/${id}/response`, { method: "DELETE" });
    expect(reset.status).toBe(204);
    expect((await f.app.request(path, { method: "POST", body: "x" })).status).toBe(202);
    expect(f.audits.filter((a) => a.action === "hook_inbox.response_update")).toHaveLength(2);
    expect((await f.app.request(`/api/hooks/inboxes/00000000-0000-4000-8000-000000000000/response`, { method: "DELETE" })).status).toBe(404);
  });

  it("is manager-only and scoped to the inbox's project", async () => {
    const f = fixture();
    const { id } = await inbox(f);
    f.setMember("member");
    expect((await f.app.request(`/api/hooks/inboxes/${id}/response`)).status).toBe(403);
    expect((await put(f, id, { status: 201 })).status).toBe(403);
    expect((await f.app.request(`/api/hooks/inboxes/${id}/response`, { method: "DELETE" })).status).toBe(403);
    f.setMember("owner");
    f.setProject("project-b");
    expect((await f.app.request(`/api/hooks/inboxes/${id}/response`)).status).toBe(404);
    expect((await put(f, id, { status: 201 })).status).toBe(404);
    expect(f.inboxes[0].response).toBeUndefined();
  });

  it("delays the answer within bounds; beyond the inbox's slots it captures and answers at once, never refusing", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 201, body: "slow", delayMs: 600 });
    const started = Date.now();
    const first = await f.app.request(path, { method: "POST", body: "x" });
    expect(first.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    // Five slots per inbox: the sixth concurrent request is still captured and
    // gets the configured status and body, just without the delay.
    const before = f.events.length;
    const t0 = Date.now();
    const burst = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve(f.app.request(path, { method: "POST", body: "y" }))
      .then(async (r) => ({ r, text: await r.text(), ms: Date.now() - t0 }))));
    expect(burst.map((b) => b.r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(burst.every((b) => b.text === "slow")).toBe(true);
    expect(burst.filter((b) => b.ms >= 550)).toHaveLength(5);
    expect(burst.filter((b) => b.ms < 550)).toHaveLength(1);
    expect(f.events.length - before).toBe(6);
    expect(f.events.slice(before).every((e) => e.response_status === 201)).toBe(true);
    for (const b of burst) expectPrivateHookHeaders(b.r);
    // Slots are released afterwards.
    expect(hookDelaySlots.active({ inbox: id })).toBe(0);
  });

  it("serves XML bodies as attachments so a browser never renders them", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 200, contentType: "application/xml", body: '<svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>' });
    const res = await f.app.request(path, { method: "POST", body: "x" });
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="response.xml"');
    expectPrivateHookHeaders(res);
  });

  it("records the status actually sent when a stored configuration fails re-validation", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    f.inboxes[0].response = { status: 200, contentType: "text/html", body: "<b>x</b>", headers: [], delayMs: 0 };
    const res = await f.app.request(path, { method: "POST", body: "x" });
    expect(res.status).toBe(202);
    expect(f.events.at(-1)?.response_status).toBe(202);
    expect(id).toBeTruthy();
  });

  it("gives the request's database back before sleeping, and only once (no idle connection held through the delay)", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 201, body: "slow", delayMs: 600 });
    const before = f.closed.length;
    const started = Date.now();
    const res = await f.app.request(path, { method: "POST", body: "x" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("slow");
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    const closes = f.closed.slice(before);
    expect(closes).toHaveLength(1);
    // released right after capture, well before the delay ended
    expect(closes[0] - started).toBeLessThan(400);
    expect(f.events.at(-1)?.response_status).toBe(201);
  });

  it("keeps the database for an answer without a delay", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 201, body: "fast" });
    const before = f.closed.length;
    expect((await f.app.request(path, { method: "POST", body: "x" })).status).toBe(201);
    expect(f.closed.length - before).toBe(0);
  });

  it("stops waiting when the sender disconnects", async () => {
    const f = fixture();
    const { id, path } = await inbox(f);
    await put(f, id, { status: 200, delayMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = f.app.fetch(new Request("http://localhost" + path, { method: "POST", body: "x", signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await Promise.resolve(pending).catch(() => null);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.events).toHaveLength(1);
  });
});

describe("webhook replay address guard", () => {
  it("refuses link-local and cloud metadata addresses in every spelling", () => {
    for (const ip of ["169.254.169.254", "169.254.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "[::ffff:a9fe:a9fe]", "100.100.100.200", "fe80::1", "FEBF::1", "fd00:ec2::254", "0.0.0.0", "::", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe", "::ffff:6464:64c8"]) {
      expect(replayAddressForbidden(ip), ip).toBe(true);
    }
  });
  it("leaves ordinary private development addresses to the operator's opt-in", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.10", "::1", "fd12::1", "93.184.216.34"]) {
      expect(replayAddressForbidden(ip), ip).toBe(false);
    }
  });
});
