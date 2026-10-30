import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
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
    await database!.migrate();
    await montralEdition.migrate!(database!);
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
    return async (method: string, path: string, payload?: unknown) => {
      const response = await app.fetch(new Request(origin + "/api/hooks" + path, {
        method,
        headers: { origin, cookie: cookies, "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      }), env as never);
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
  }
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
    expect((await submit(invalid, "wrong")).status).toBe(404);
    const inbound = await submit(path, '{"event":"test","amount":120}');
    expect(inbound.status).toBe(202);
    const out = await a("GET", "/inboxes/" + id + "/events");
    expect(out.status).toBe(200);
    expect(out.body.events[0].body).toContain('"amount":120');
    expect(out.body.events[0].headers.authorization).toBeUndefined();
    expect(out.body.events[0].headers["x-event-type"]).toBe("test");
    expect((await submit(path, "x".repeat(33 * 1024))).status).toBe(413);
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
});
