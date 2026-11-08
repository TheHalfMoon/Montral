import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "json-assertion-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("monitor JSON assertions", () => {
  it("stores, validates, patches, clears and round-trips the assertion", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    try {
      const signup = await call("", "POST", "/auth/sign-up/email", { email: `json-${crypto.randomUUID()}@example.com`, name: "Json", password: "correct horse battery" });
      expect(signup.status).toBe(200);
      const cookie = signup.cookie;
      const orgId = (await call(cookie, "GET", "/me")).body.organization.id;
      const base = { name: "API health", type: "http", target: "https://1.1.1.1/health" };

      const plain = await call(cookie, "POST", "/monitors", base);
      expect(plain).toMatchObject({ status: 201, body: { jsonPath: null, jsonExpected: null, jsonMatch: "equals" } });
      const created = await call(cookie, "POST", "/monitors", { ...base, jsonPath: "$.data.items[0].state", jsonExpected: "ready" });
      expect(created).toMatchObject({ status: 201, body: { jsonPath: "$.data.items[0].state", jsonExpected: "ready", jsonMatch: "equals" } });
      const path = `/monitors/${created.body.id}`;

      for (const [bad, error] of [
        [{ ...base, jsonPath: "data[*]", jsonExpected: "x" }, /Invalid JSON path/],
        [{ ...base, jsonPath: Array(33).fill("a").join("."), jsonMatch: "exists" }, /deeper than 32/],
        [{ ...base, jsonPath: "status", jsonMatch: "contains" }, /jsonExpected is required/],
        [{ ...base, type: "tcp", target: "1.1.1.1:443", jsonPath: "status", jsonMatch: "exists" }, /HTTP monitors only/],
      ] as const) expect(await call(cookie, "POST", "/monitors", bad)).toMatchObject({ status: 400, body: { error: expect.stringMatching(error) } });
      expect((await call(cookie, "POST", "/monitors", { ...base, jsonMatch: "regex" })).status).toBe(400);

      // PATCH: named fields only, judged together with what is stored; a changed assertion is a new configuration
      const revision = (await db.repo.getMonitor(orgId, created.body.id, null))!.coverageRevision!;
      expect(await call(cookie, "PATCH", path, { jsonMatch: "contains", jsonExpected: "ead" })).toMatchObject({ status: 200, body: { jsonPath: "$.data.items[0].state", jsonMatch: "contains", jsonExpected: "ead" } });
      expect((await db.repo.getMonitor(orgId, created.body.id, null))!.coverageRevision).toBe(revision + 1);
      expect(await call(cookie, "PATCH", path, { name: "Renamed" })).toMatchObject({ status: 200, body: { jsonMatch: "contains" } });
      expect((await db.repo.getMonitor(orgId, created.body.id, null))!.coverageRevision).toBe(revision + 1);
      expect(await call(cookie, "PATCH", path, { jsonExpected: null })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/jsonExpected is required/) } });
      expect(await call(cookie, "PATCH", path, { jsonPath: "a..b" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Invalid JSON path/) } });
      expect(await call(cookie, "PATCH", path, { jsonMatch: "exists", jsonExpected: null })).toMatchObject({ status: 200, body: { jsonMatch: "exists", jsonExpected: null } });
      expect(await call(cookie, "PATCH", path, { jsonPath: null })).toMatchObject({ status: 200, body: { jsonPath: null } });
      expect(await call(cookie, "PATCH", path, { jsonPath: '["key with space"]', jsonMatch: "equals", jsonExpected: "42" })).toMatchObject({ status: 200, body: { jsonPath: '["key with space"]' } });

      const tcp = await call(cookie, "POST", "/monitors", { name: "Port", type: "tcp", target: "1.1.1.1:443" });
      expect(tcp.status).toBe(201);
      expect((await call(cookie, "PATCH", `/monitors/${tcp.body.id}`, { jsonPath: "status", jsonMatch: "exists" })).status).toBe(400);
      expect((await call(cookie, "PATCH", `/monitors/${tcp.body.id}`, { jsonPath: null, jsonExpected: null })).status).toBe(200);

      // export carries the assertion and import applies the same validation
      const exported = (await call(cookie, "GET", "/monitors/export")).body.monitors.find((m: any) => m.sourceId === created.body.id);
      expect(exported).toMatchObject({ jsonPath: '["key with space"]', jsonMatch: "equals", jsonExpected: "42" });
      const imported = await call(cookie, "POST", "/monitors/import", { source: "json-assertion-e2e", monitors: [
        { ...exported, sourceId: "copy" },
        { ...exported, sourceId: "broken", jsonPath: "a[-1]" },
      ] });
      expect(imported.body).toMatchObject({ created: 1, skipped: [{ index: 1, error: expect.stringMatching(/Invalid JSON path/) }] });
    } finally {
      await db.close(1);
    }
  });
});
