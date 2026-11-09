import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { hookDelaySlots } from "./montral-hooks";

/**
 * Configurable webhook receiver responses through the mounted app on real
 * PostgreSQL: the configured status, headers and body reach the sender, the
 * privacy headers cannot be displaced, refusals keep their fixed answers,
 * header injection is impossible (at the API and from a tampered row), delays
 * are bounded and per-inbox concurrency limited without blocking other
 * inboxes, only managers of the owning workspace may change it, the change is
 * audited without values, replay ignores it, and a no-op re-migration takes
 * no blocking table lock.
 */
const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-hook-response-e2e-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};
const BLOCKING_MODES = "'ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock'";

type Res = { status: number; body: any; text: string; headers: Headers; cookie: string };

describe.skipIf(!url)("Montral configurable webhook responses (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 10 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  const q = <T,>(sql: string, params?: unknown[]) => database!.query<T>(sql, params);
  beforeAll(async () => { await migrateMontralSchema(database!, montralEdition); });
  afterAll(async () => { await database?.close(1); });

  async function call(path: string, init: { method?: string; body?: unknown; cookie?: string; env?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { origin, "content-type": "application/json" };
    if (init.cookie) headers.cookie = init.cookie;
    const r = await app.fetch(new Request(origin + path, {
      method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    }), { ...env, ...init.env } as never);
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body, text, headers: r.headers, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  }
  async function signUp(name: string) {
    const email = `hook-response-${name}-${crypto.randomUUID()}@example.com`;
    const r = await call("/api/auth/sign-up/email", { method: "POST", body: { email, name, password: "correct horse battery staple" } });
    expect(r.status).toBe(200);
    await q(`update "user" set email_verified = true where id = $1`, [r.body.user.id]);
    const login = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "correct horse battery staple" } });
    expect(login.status).toBe(200);
    const me = await call("/api/me", { cookie: login.cookie });
    return { email, id: r.body.user.id as string, cookie: login.cookie, orgId: me.body.organization.id as string };
  }
  async function memberOf(owner: Awaited<ReturnType<typeof signUp>>) {
    const u = await signUp("member");
    const invite = await call("/api/auth/organization/invite-member", { method: "POST", cookie: owner.cookie, body: { organizationId: owner.orgId, email: u.email, role: "member" } });
    expect(invite.status).toBe(200);
    expect((await call("/api/auth/organization/accept-invitation", { method: "POST", cookie: u.cookie, body: { invitationId: invite.body.id } })).status).toBe(200);
    const active = await call("/api/auth/organization/set-active", { method: "POST", cookie: u.cookie, body: { organizationId: owner.orgId } });
    expect(active.status).toBe(200);
    return { ...u, cookie: active.cookie || u.cookie };
  }
  async function inbox(cookie: string, name: string) {
    const created = await call("/api/hooks/inboxes", { method: "POST", cookie, body: { name } });
    expect(created.status).toBe(201);
    return created.body as { id: string; path: string };
  }
  const send = async (path: string, body: string | Uint8Array = '{"synthetic":true}', method = "POST"): Promise<Response> => app.fetch(new Request(origin + path, {
    method, headers: { "content-type": "application/json", "x-event-type": "synthetic.test" }, body: body as BodyInit,
  }), env as never);
  const privateHeaders = (res: Response | Res) => {
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  };

  it("returns the configured status, headers and body with privacy headers, and records the status on the event", async () => {
    const owner = await signUp("owner");
    const { id, path } = await inbox(owner.cookie, "Mock provider");
    expect((await call(`/api/hooks/inboxes/${id}/response`, { cookie: owner.cookie })).body).toEqual({ response: null });
    // Default stays 202 until configured.
    const before = await send(path);
    expect(before.status).toBe(202);
    expect(await before.json()).toEqual({ received: true });

    const saved = await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: {
      status: 201, contentType: "application/json", body: '{"id":"evt_mock","ok":true}',
      headers: [{ name: "X-Mock-Id", value: "mock-123" }, { name: "Retry-After", value: "5" }],
      methods: { PUT: { status: 409, contentType: "text/plain", body: "conflict" } },
    } });
    expect(saved.status).toBe(200);
    privateHeaders(saved);
    expect((await call(`/api/hooks/inboxes/${id}/response`, { cookie: owner.cookie })).body.response).toMatchObject({ status: 201, delayMs: 0 });

    const res = await send(path);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"id":"evt_mock","ok":true}');
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-mock-id")).toBe("mock-123");
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("set-cookie")).toBeNull();
    privateHeaders(res);
    const put = await send(path, "{}", "PUT");
    expect(put.status).toBe(409);
    expect(await put.text()).toBe("conflict");
    privateHeaders(put);

    const events = (await call(`/api/hooks/inboxes/${id}/events`, { cookie: owner.cookie })).body.events as { method: string; response_status: number | null }[];
    expect(events.map((e) => [e.method, e.response_status])).toEqual([["PUT", 409], ["POST", 201], ["POST", 202]]);

    // Audit: field names and the status only; body text, header values never stored.
    const audits = await q<{ changes: { fields: string[]; values?: Record<string, unknown> } }>(
      "SELECT changes FROM audit_event WHERE organization_id=$1 AND action='hook_inbox.response_update' AND target_id=$2", [owner.orgId, id]);
    expect(audits).toHaveLength(1);
    expect(audits[0].changes.fields).toEqual(expect.arrayContaining(["status", "body", "headers", "methods", "contentType", "delayMs"]));
    expect(audits[0].changes.values).toEqual({ status: 201 });
    expect(JSON.stringify(audits)).not.toMatch(/mock-123|evt_mock|conflict/);

    // Reset goes back to the default and is audited too.
    expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "DELETE", cookie: owner.cookie })).status).toBe(204);
    const after = await send(path);
    expect(after.status).toBe(202);
    expect(after.headers.get("x-mock-id")).toBeNull();
    const all = await q("SELECT 1 FROM audit_event WHERE organization_id=$1 AND action='hook_inbox.response_update' AND target_id=$2", [owner.orgId, id]);
    expect(all).toHaveLength(2);
  });

  it("keeps fixed refusal answers and makes header injection impossible, even from a tampered row", async () => {
    const owner = await signUp("refusals");
    const { id, path } = await inbox(owner.cookie, "Refusals");
    expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: { status: 200, body: "configured", headers: [{ name: "X-Mock", value: "1" }] } })).status).toBe(200);
    const wrong = await send(path.slice(0, -1) + (path.endsWith("0") ? "1" : "0"));
    expect(wrong.status).toBe(404);
    const big = await send(path, "x".repeat(33 * 1024));
    expect(big.status).toBe(413);
    const malformed = await send(path, new Uint8Array([0xc3, 0x28]));
    expect(malformed.status).toBe(422);
    for (const r of [wrong, big, malformed]) {
      privateHeaders(r);
      expect(r.headers.get("x-mock")).toBeNull();
      expect(await r.text()).not.toContain("configured");
    }

    for (const bad of [
      { headers: [{ name: "X-Test", value: "a\r\nSet-Cookie: injected=1" }] },
      { headers: [{ name: "X-Test\r\nSet-Cookie", value: "injected=1" }] },
      { headers: [{ name: "Set-Cookie", value: "injected=1" }] },
      { headers: [{ name: "Access-Control-Allow-Origin", value: "*" }] },
      { headers: [{ name: "Cache-Control", value: "public, max-age=31536000" }] },
      { status: 302, location: "https://example.com/\r\nSet-Cookie: injected=1" },
      { status: 101 }, { contentType: "text/html", body: "<script>alert(1)</script>" }, { delayMs: 10_001 },
    ]) {
      const refused = await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: bad });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    // A row written outside the API (older release, manual edit) is re-validated at send time:
    // anything the API would refuse falls back to the default answer, never to raw headers.
    await q(`UPDATE montral_hook_inbox SET response=$2::jsonb WHERE id=$1`, [id, JSON.stringify({
      status: 200, contentType: "text/html", body: "<b>x</b>", delayMs: 0,
      headers: [
        { name: "X-Bad", value: "a\r\nSet-Cookie: injected=1" }, { name: "Set-Cookie", value: "injected=1" },
        { name: "Cache-Control", value: "public" }, { name: "X-Fine", value: "ok" },
      ],
    })]);
    const tampered = await send(path);
    expect(tampered.status).toBe(202);
    expect(await tampered.json()).toEqual({ received: true });
    expect(tampered.headers.get("set-cookie")).toBeNull();
    expect(tampered.headers.get("x-bad")).toBeNull();
    expect(tampered.headers.get("content-type")).toContain("application/json");
    privateHeaders(tampered);
    // The event records what was actually sent (202), not the stored status (200).
    const [latest] = (await call(`/api/hooks/inboxes/${id}/events`, { cookie: owner.cookie })).body.events as { response_status: number }[];
    expect(latest.response_status).toBe(202);
    const stored = await q<{ response_status: number }>(
      "SELECT response_status FROM montral_hook_event WHERE inbox_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1", [id]);
    expect(stored[0].response_status).toBe(202);
  });

  it("never serves an XML body as a renderable document", async () => {
    const owner = await signUp("xml");
    const { id, path } = await inbox(owner.cookie, "XML mock");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://evil.example/"><text y="20">Sign in</text></a></svg>';
    for (const contentType of ["application/xml", "text/xml"]) {
      expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: { contentType, body: svg } })).status).toBe(200);
      const res = await send(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(`${contentType}; charset=utf-8`);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="response.xml"');
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      privateHeaders(res);
    }
    for (const contentType of ["text/html", "image/svg+xml", "application/xhtml+xml"]) {
      expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: { contentType, body: svg } })).status, contentType).toBe(400);
    }
  });

  it("bounds delays per organization without denying capture, and never blocks other inboxes or organizations", async () => {
    const DELAY = 3000;
    const noisy = await signUp("delay-noisy");
    const quiet = await signUp("delay-quiet");
    const noisyInboxes = await Promise.all(Array.from({ length: 5 }, (_, i) => inbox(noisy.cookie, `Slow ${i}`)));
    const fast = await inbox(noisy.cookie, "Fast");
    const quietInbox = await inbox(quiet.cookie, "Quiet slow");
    for (const { id } of noisyInboxes) {
      expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: noisy.cookie, body: { status: 201, body: "slow", delayMs: DELAY } })).status).toBe(200);
    }
    expect((await call(`/api/hooks/inboxes/${fast.id}/response`, { method: "PUT", cookie: noisy.cookie, body: { status: 200, body: "fast" } })).status).toBe(200);
    expect((await call(`/api/hooks/inboxes/${quietInbox.id}/response`, { method: "PUT", cookie: quiet.cookie, body: { status: 202, body: "quiet", delayMs: DELAY } })).status).toBe(200);

    const started = Date.now();
    const timed = (p: Promise<Response>) => p.then(async (r) => ({ status: r.status, text: await r.text(), ms: Date.now() - started }));
    // 25 concurrent delayed requests from one organization: its cap is 20 per process.
    const noisyOnes = noisyInboxes.flatMap(({ path }) => Array.from({ length: 5 }, () => timed(send(path))));
    // Once the noisy organization holds its slots, another inbox and another organization still work.
    await new Promise((r) => setTimeout(r, 800));
    expect(hookDelaySlots.active({ org: noisy.orgId })).toBe(20);
    const other = await timed(send(fast.path));
    expect(other.status).toBe(200);
    expect(other.text).toBe("fast");
    expect(other.ms).toBeLessThan(DELAY - 200);
    const quietStart = Date.now();
    const quietRes = await send(quietInbox.path);
    expect(quietRes.status).toBe(202);
    expect(await quietRes.text()).toBe("quiet");
    expect(Date.now() - quietStart).toBeGreaterThanOrEqual(DELAY - 100); // the other organization's delay is honoured

    const results = await Promise.all(noisyOnes);
    // Nobody is refused: all 25 are captured and get the configured status and body;
    // 20 waited, the 5 beyond the organization cap were answered at once.
    expect(results.map((r) => r.status)).toEqual(Array(25).fill(201));
    expect(results.every((r) => r.text === "slow")).toBe(true);
    expect(results.filter((r) => r.ms >= DELAY - 100)).toHaveLength(20);
    expect(results.filter((r) => r.ms < DELAY - 100)).toHaveLength(5);
    expect(Math.max(...results.map((r) => r.ms))).toBeLessThan(10_000 + DELAY);
    const stored = await q<{ n: number; s: number }>(
      "SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE response_status=201)::int AS s FROM montral_hook_event WHERE inbox_id::text = ANY(string_to_array($1::text, ','))",
      [noisyInboxes.map((i) => i.id).join(",")]);
    expect(stored[0]).toEqual({ n: 25, s: 25 });
    expect(hookDelaySlots.active({ org: noisy.orgId })).toBe(0);
    expect(hookDelaySlots.active({ org: quiet.orgId })).toBe(0);
  }, 60_000);


  it("lets only managers of the owning workspace read or change it", async () => {
    const owner = await signUp("manager");
    const member = await memberOf(owner);
    const stranger = await signUp("stranger");
    const { id, path } = await inbox(owner.cookie, "Scoped");
    for (const [method, body] of [["GET", undefined], ["PUT", { status: 500 }], ["DELETE", undefined]] as const) {
      expect((await call(`/api/hooks/inboxes/${id}/response`, { method, cookie: member.cookie, body })).status, `member ${method}`).toBe(403);
      expect((await call(`/api/hooks/inboxes/${id}/response`, { method, cookie: stranger.cookie, body })).status, `stranger ${method}`).toBe(404);
    }
    expect((await q<{ response: unknown }>("SELECT response FROM montral_hook_inbox WHERE id=$1", [id]))[0].response).toBeNull();
    expect((await send(path)).status).toBe(202);
    expect(await q("SELECT 1 FROM audit_event WHERE action='hook_inbox.response_update' AND target_id=$1", [id])).toHaveLength(0);
  });

  it("replay sends the stored request and reports the target's answer, never the configured response", async () => {
    const owner = await signUp("replay");
    const { id, path } = await inbox(owner.cookie, "Replay");
    expect((await call(`/api/hooks/inboxes/${id}/response`, { method: "PUT", cookie: owner.cookie, body: { status: 503, body: "configured-down", headers: [{ name: "X-Mock", value: "1" }] } })).status).toBe(200);
    expect((await send(path, '{"order":7}')).status).toBe(503);
    const [event] = (await call(`/api/hooks/inboxes/${id}/events`, { cookie: owner.cookie })).body.events as { id: string; response_status: number }[];
    expect(event.response_status).toBe(503);
    let seen: { headers?: IncomingHttpHeaders; body?: string } = {};
    const sink = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { seen = { headers: req.headers, body }; res.writeHead(201, { "content-type": "text/plain" }); res.end("sink-ok"); });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    try {
      const target = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/hook`;
      const replayed = await call(`/api/hooks/inboxes/${id}/events/${event.id}/replay`, { method: "POST", cookie: owner.cookie, body: { url: target }, env: { MONTRAL_REPLAY_PRIVATE_TARGETS: "true" } });
      expect(replayed.status).toBe(200);
      expect(replayed.body).toMatchObject({ status: 201, body: "sink-ok" });
      expect(seen.body).toBe('{"order":7}');
      expect(seen.headers?.["x-mock"]).toBeUndefined();
      expect(JSON.stringify(replayed.body)).not.toContain("configured-down");
    } finally {
      await new Promise((r) => sink.close(r));
    }
    // Replay stores nothing: still one event.
    expect((await call(`/api/hooks/inboxes/${id}/events`, { cookie: owner.cookie })).body.events).toHaveLength(1);
  });

  it("a no-op edition re-migration takes no table lock that blocks captures or configuration writes", async () => {
    const held = await database!.migrateEdition!(async (tx) => {
      await montralEdition.migrate!(tx);
      return tx.query<{ relname: string; mode: string }>(`
        SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
          AND c.relname IN ('montral_hook_inbox','montral_hook_event') AND l.mode IN (${BLOCKING_MODES})`);
    });
    expect(held).toEqual([]);
    const columns = await q<{ item: string }>(`
      SELECT table_name || '.' || column_name AS item FROM information_schema.columns
      WHERE table_schema = current_schema() AND ((table_name='montral_hook_inbox' AND column_name='response')
        OR (table_name='montral_hook_event' AND column_name='response_status'))`);
    expect(columns.map((c) => c.item).sort()).toEqual(["montral_hook_event.response_status", "montral_hook_inbox.response"]);
  });
});
