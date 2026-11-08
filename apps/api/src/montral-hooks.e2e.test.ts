import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { fingerprint, pruneExpiredHookEvents } from "./montral-hooks";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};

describe.skipIf(!url)("Montral webhook production-path PostgreSQL E2E", () => {
  const database = url ? openDatabase(url, { max: 10 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  beforeAll(async () => {
    await migrateMontralSchema(database!, montralEdition);
  });
  afterAll(async () => { await database?.close(1); });
  async function account() {
    const email = `montral-webhooks-${crypto.randomUUID()}@example.com`;
    const res = await app.fetch(new Request(origin + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, name: "Webhook QA", password: "correct horse battery staple" }),
    }), env as never);
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    return async (method: string, path: string, payload?: unknown, extraEnv: Record<string, string> = {}) => {
      const response = await app.fetch(new Request(origin + "/api/hooks" + path, {
        method,
        headers: { origin, cookie: cookies, "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }), { ...env, ...extraEnv } as never);
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
  }
  const privateResponse = (res: Response) => {
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  };
  const submit = (path: string, payload: string) => app.fetch(
    new Request(origin + path, { method: "POST", headers: {
      "content-type": "application/json",
      authorization: "Bearer caller-confidential",
      "x-event-type": "test",
    }, body: payload }), env as never,
  );

  it("migrates, creates a secret receiver, rejects bad tokens, captures and isolates events", async () => {
    const a = await account();
    const b = await account();
    const create = await a("POST", "/inboxes", { name: "Billing mock" });
    expect(create.status).toBe(201);
    const { id, path } = create.body;
    expect(path).toMatch(/^\/api\/hooks\/receive\/[0-9a-f-]+\/[a-f0-9]{64}$/);
    expect((await a("GET", "/inboxes")).body.inboxes).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(JSON.stringify((await a("GET", "/inboxes")).body)).not.toContain(path.split("/").at(-1));
    expect((await b("GET", "/inboxes/" + id + "/events")).status).toBe(404);
    expect((await b("DELETE", "/inboxes/" + id)).status).toBe(404);
    const invalid = path.slice(0, -1) + (path.endsWith("0") ? "1" : "0");
    const denied = await submit(invalid, "wrong");
    expect(denied.status).toBe(404);
    privateResponse(denied);
    const inbound = await submit(path, '{"event":"test","amount":120}');
    expect(inbound.status).toBe(202);
    privateResponse(inbound);
    const out = await a("GET", "/inboxes/" + id + "/events");
    expect(out.status).toBe(200);
    expect(out.body.events[0].body).toContain('"amount":120');
    expect(out.body.events[0].headers.authorization).toBeUndefined();
    expect(out.body.events[0].headers["x-event-type"]).toBe("test");
    const tooLarge = await submit(path, "x".repeat(33 * 1024));
    expect(tooLarge.status).toBe(413);
    privateResponse(tooLarge);
    for (const bytes of [new Uint8Array([65, 0, 66]), new Uint8Array([0xc3, 0x28])]) {
      const invalid = await app.fetch(new Request(origin + path, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes as BodyInit,
      }), env as never);
      expect(invalid.status).toBe(422);
      privateResponse(invalid);
    }
    // A refused binary event must not corrupt the existing, valid text row.
    const afterInvalid = await a("GET", "/inboxes/" + id + "/events");
    expect(afterInvalid.body.events).toHaveLength(1);
    expect((await a("DELETE", "/inboxes/" + id)).status).toBe(204);
    expect((await submit(path, '{"event":"gone"}')).status).toBe(404);
    const remains = await database!.query<{ id: string }>("SELECT id FROM montral_hook_event WHERE inbox_id=$1", [id]);
    expect(remains).toHaveLength(0);
  });

  it("atomically limits concurrent inbox creation to ten for a single project", async () => {
    const a = await account();
    const attempts = await Promise.all(Array.from({ length: 16 }, (_, i) =>
      a("POST", "/inboxes", { name: `parallel ${i}` }),
    ));
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(10);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(6);
    expect((await a("GET", "/inboxes")).body.inboxes).toHaveLength(10);
  });

  it("keeps the per-inbox 250-event cap under real simultaneous PostgreSQL inserts", async () => {
    const a = await account();
    const created = await a("POST", "/inboxes", { name: "Burst resilience" });
    expect(created.status).toBe(201);
    const { id, path } = created.body as { id: string; path: string };
    const token = path.split("/").at(-1)!;
    const hash = await fingerprint(token);
    // Bypass the per-IP 120/min public endpoint limiter to isolate the
    // database correctness property. These are synthetic SQL calls only.
    const statuses = await Promise.all(Array.from({ length: 275 }, async (_, n) =>
      database!.query<{ accepted: boolean }>(
        "SELECT montral_capture_hook_event($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS accepted",
        [id, hash, crypto.randomUUID(), "POST", "text/plain", "{}", "burst-" + n],
      ),
    ));
    expect(statuses.every(rows => rows[0]?.accepted === true)).toBe(true);
    const retained = await database!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM montral_hook_event WHERE inbox_id=$1", [id],
    );
    expect(Number(retained[0]?.count)).toBe(250);
    const wrong = await database!.query<{ accepted: boolean }>(
      "SELECT montral_capture_hook_event($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS accepted",
      [id, await fingerprint("ff".repeat(32)), crypto.randomUUID(), "POST", "text/plain", "{}", "not-allowed"],
    );
    expect(wrong[0]?.accepted).toBe(false);
    expect(await database!.query("SELECT id FROM montral_hook_event WHERE inbox_id=$1", [id])).toHaveLength(250);
    expect((await a("DELETE", "/inboxes/" + id)).status).toBe(204);
    const raced = await database!.query<{ accepted: boolean }>(
      "SELECT montral_capture_hook_event($1::uuid,$2::text,$3::uuid,$4::text,$5::text,$6::jsonb,$7::text) AS accepted",
      [id, hash, crypto.randomUUID(), "POST", "text/plain", "{}", "deleted"],
    );
    expect(raced[0]?.accepted).toBe(false);
  });

  it("allows concurrent delivery/deletion without foreign-key errors or abandoned event bodies", async () => {
    const a = await account();
    const created = await a("POST", "/inboxes", { name: "Safe delete race" });
    const { id, path } = created.body as { id: string; path: string };
    const [delivery, deletion] = await Promise.all([
      submit(path, '{"synthetic":"race"}'), a("DELETE", "/inboxes/" + id),
    ]);
    expect([202, 404]).toContain(delivery.status);
    expect(deletion.status).toBe(204);
    expect(await database!.query("SELECT id FROM montral_hook_event WHERE inbox_id=$1", [id])).toHaveLength(0);
  });

  it("prunes expired data from idle inboxes without an incoming event", async () => {
    const a = await account();
    const created = await a("POST", "/inboxes", { name: "Idle" });
    const id = created.body.id as string;
    const eventId = crypto.randomUUID();
    await database!.query("INSERT INTO montral_hook_event(id,inbox_id,organization_id,project_id,method,content_type,headers,body,created_at) SELECT $1,id,organization_id,project_id,'POST','text/plain','{}'::jsonb,'expired',NOW() - INTERVAL '9 days' FROM montral_hook_inbox WHERE id=$2", [eventId, id]);
    expect(await database!.query("SELECT id FROM montral_hook_event WHERE id=$1", [eventId])).toHaveLength(1);
    const deleted = await pruneExpiredHookEvents(database!);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await database!.query("SELECT id FROM montral_hook_event WHERE id=$1", [eventId])).toHaveLength(0);
    expect((await a("GET", "/inboxes/" + id + "/events")).body.events).toHaveLength(0);
  });

  it("pages every retained event once in keyset order, filters safely and expires stale cursors", async () => {
    const a = await account();
    const b = await account();
    const id = (await a("POST", "/inboxes", { name: "Paging" })).body.id as string;
    // 120 events, 60 of them sharing one timestamp, so ordering must break ties by id.
    await database!.query(`INSERT INTO montral_hook_event(id,inbox_id,organization_id,project_id,method,content_type,headers,body,created_at)
      SELECT gen_random_uuid(), h.id, h.organization_id, h.project_id,
        CASE WHEN g % 4 = 0 THEN 'PUT' ELSE 'POST' END, 'application/json', '{}'::jsonb,
        CASE WHEN g = 7 THEN '{"n":7,"pct":"100%"}' ELSE '{"n":' || g || '}' END,
        CASE WHEN g <= 60 THEN NOW() - INTERVAL '1 hour' ELSE NOW() - (g || ' seconds')::interval END
      FROM montral_hook_inbox h, generate_series(1,120) g WHERE h.id=$1`, [id]);
    const seen: { id: string; created_at: string }[] = [];
    let before: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await a("GET", `/inboxes/${id}/events${before ? "?before=" + before : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.events.length).toBeLessThanOrEqual(50);
      seen.push(...res.body.events);
      before = res.body.next;
      if (!before) break;
    }
    expect(before).toBeNull();
    expect(seen).toHaveLength(120);
    expect(new Set(seen.map((e) => e.id)).size).toBe(120);
    for (let k = 1; k < seen.length; k++) expect(Date.parse(seen[k - 1].created_at)).toBeGreaterThanOrEqual(Date.parse(seen[k].created_at));
    const puts = await a("GET", `/inboxes/${id}/events?method=PUT`);
    expect(puts.body.events).toHaveLength(30);
    expect(puts.body.events.every((e: { method: string }) => e.method === "PUT")).toBe(true);
    // LIKE wildcards in the search term are literals, not patterns.
    const pct = await a("GET", `/inboxes/${id}/events?q=${encodeURIComponent("100%")}`);
    expect(pct.body.events.map((e: { body: string }) => e.body)).toEqual(['{"n":7,"pct":"100%"}']);
    expect((await a("GET", `/inboxes/${id}/events?q=_`)).body.events).toHaveLength(0);
    expect((await a("GET", `/inboxes/${id}/events?method=GET`)).status).toBe(400);
    expect((await a("GET", `/inboxes/${id}/events?before=not-a-uuid`)).status).toBe(400);
    expect((await a("GET", `/inboxes/${id}/events?unknown=1`)).status).toBe(400);
    expect((await a("GET", `/inboxes/${id}/events?before=${crypto.randomUUID()}`)).status).toBe(410);
    // Another workspace cannot page someone else's inbox, even with a valid cursor.
    expect((await b("GET", `/inboxes/${id}/events?before=${seen[10].id}`)).status).toBe(404);
  });

  it("deletes single events and replays them only to allowed targets, scoped to the inbox owner", async () => {
    const a = await account();
    const b = await account();
    const created = await a("POST", "/inboxes", { name: "Replay" });
    const { id, path } = created.body as { id: string; path: string };
    expect((await submit(path, '{"order":1}')).status).toBe(202);
    expect((await submit(path, '{"order":2}')).status).toBe(202);
    const listed = (await a("GET", `/inboxes/${id}/events`)).body.events as { id: string; body: string }[];
    expect(listed).toHaveLength(2);
    const [second, first] = listed;

    // Another workspace can neither delete nor replay, even with valid ids.
    expect((await b("DELETE", `/inboxes/${id}/events/${first.id}`)).status).toBe(404);
    expect((await b("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: "https://example.com/" })).status).toBe(404);
    // An event id from another inbox is not found under this one.
    const otherInbox = (await a("POST", "/inboxes", { name: "Other" })).body.id as string;
    expect((await a("DELETE", `/inboxes/${otherInbox}/events/${first.id}`)).status).toBe(404);
    expect((await a("DELETE", `/inboxes/${id}/events/not-a-uuid`)).status).toBe(404);

    // SSRF: loopback, private and metadata targets are refused without the operator opt-in.
    for (const url of ["http://127.0.0.1:9/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://localhost/"]) {
      const refused = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url });
      expect(refused.status, url).toBe(400);
      expect(refused.body.code, url).toBe("target_not_allowed");
    }
    for (const bad of [{ url: "file:///etc/passwd" }, { url: "ftp://example.com/" }, { url: "not a url" }, {}, { url: "https://example.com", extra: 1 }]) {
      expect((await a("POST", `/inboxes/${id}/events/${first.id}/replay`, bad)).status, JSON.stringify(bad)).toBe(400);
    }

    // ALLOW_PRIVATE_TARGETS lets monitors reach internal services, but replay
    // returns response bodies, so it alone must not open private targets.
    const monitorsOnly = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: "http://127.0.0.1:9/x" }, { ALLOW_PRIVATE_TARGETS: "true" });
    expect(monitorsOnly.status).toBe(400);
    expect(monitorsOnly.body.code).toBe("target_not_allowed");
    // The replay-specific opt-in still never reaches link-local or metadata addresses.
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://[::ffff:169.254.169.254]/", "http://100.100.100.200/", "http://[fe80::1]/"]) {
      const metadata = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url }, { MONTRAL_REPLAY_PRIVATE_TARGETS: "true" });
      expect(metadata.status, url).toBe(400);
      expect(metadata.body.code, url).toBe("target_not_allowed");
    }

    // With MONTRAL_REPLAY_PRIVATE_TARGETS (self-hosted dev), the request is resent to a local endpoint.
    let seen: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {};
    const sink = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen = { method: req.method, headers: req.headers, body };
        if (req.url === "/binary") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.alloc(100, 0xff)); return; }
        res.writeHead(req.url === "/redirect" ? 302 : 201, { "content-type": "text/plain", location: "http://169.254.169.254/" });
        // Multibyte text: truncation must count bytes, not characters.
        res.end("é".repeat(3000));
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
    try {
      const allowed = { MONTRAL_REPLAY_PRIVATE_TARGETS: "true" };
      const replayed = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: sinkUrl + "/hook" }, allowed);
      expect(replayed.status).toBe(200);
      expect(replayed.body).toMatchObject({ status: 201, contentType: "text/plain", truncated: true });
      expect(new TextEncoder().encode(replayed.body.body).byteLength).toBe(4096);
      expect(replayed.body.body).toBe("é".repeat(2048));
      expect(seen.method).toBe("POST");
      expect(seen.body).toBe(first.body);
      expect(seen.headers?.["content-type"]).toBe("application/json");
      expect(seen.headers?.["x-event-type"]).toBe("test");
      expect(seen.headers?.["x-montral-replay"]).toBe(first.id);
      // The sender's credential was never stored, so it cannot be replayed.
      expect(seen.headers?.authorization).toBeUndefined();
      // Truncation is decided on bytes received, not on decoded text.
      const binary = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: sinkUrl + "/binary" }, allowed);
      expect(binary.body).toMatchObject({ status: 200, truncated: false });
      // Redirects are reported, never followed.
      const redirected = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: sinkUrl + "/redirect" }, allowed);
      expect(redirected.body.status).toBe(302);
    } finally {
      await new Promise((r) => sink.close(r));
    }
    // A closed port is a fixed, non-revealing error.
    const unreachable = await a("POST", `/inboxes/${id}/events/${first.id}/replay`, { url: sinkUrl + "/gone" }, { MONTRAL_REPLAY_PRIVATE_TARGETS: "true" });
    expect(unreachable.status).toBe(502);
    expect(JSON.stringify(unreachable.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);

    expect((await a("DELETE", `/inboxes/${id}/events/${first.id}`)).status).toBe(204);
    expect((await a("DELETE", `/inboxes/${id}/events/${first.id}`)).status).toBe(404);
    const remaining = (await a("GET", `/inboxes/${id}/events`)).body.events as { id: string }[];
    expect(remaining.map((e) => e.id)).toEqual([second.id]);
  });
});
