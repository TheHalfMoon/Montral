import { openDatabase } from "@montral/db-pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "ping-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };
const SHAPE = "Target must be a hostname or IP address, without scheme, port or path";

describe.skipIf(!url)("ping monitors through the API", () => {
  it("stores the new enum value, validates targets, keeps one region and refuses Workers deployments", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
      if (r.headers.getSetCookie().length) cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return { status: r.status, body: await r.json().catch(() => null) as any };
    };
    try {
      expect((await call("POST", "/auth/sign-up/email", { email: `ping-${crypto.randomUUID()}@example.com`, name: "Ping", password: "correct horse battery" })).status).toBe(200);

      // the enum value from migration 0050 is accepted by PostgreSQL; ordinary intervals are kept
      const mon = await call("POST", "/monitors", { name: "Edge", type: "ping", target: "1.1.1.1", intervalSec: 60 });
      expect(mon).toMatchObject({ status: 201, body: { type: "ping", target: "1.1.1.1", intervalSec: 60, regions: ["auto"] } });
      expect(await call("POST", "/monitors", { name: "V6", type: "ping", target: "2606:4700:4700::1111" })).toMatchObject({ status: 201, body: { type: "ping" } });
      expect((await call("GET", `/monitors/${mon.body.id}`)).body).toMatchObject({ type: "ping", target: "1.1.1.1" });

      // malformed and private targets are refused, as for tcp
      for (const target of ["https://1.1.1.1", "1.1.1.1:80", "1.1.1.1/x", "-c 9 1.1.1.1", "a b"]) {
        expect(await call("POST", "/monitors", { name: "Bad", type: "ping", target }), target).toMatchObject({ status: 400, body: { error: SHAPE } });
      }
      for (const target of ["127.0.0.1", "::1", "10.0.0.1", "localhost"]) {
        expect(await call("POST", "/monitors", { name: "Private", type: "ping", target }), target).toMatchObject({ status: 400, body: { code: "target_not_allowed" } });
      }
      expect((await call("POST", "/monitors", { name: "Remote", type: "ping", target: "1.1.1.1", regions: ["us-east"] })).status).toBe(400);

      const path = `/monitors/${mon.body.id}`;
      expect(await call("PATCH", path, { target: "8.8.8.8" })).toMatchObject({ status: 200, body: { target: "8.8.8.8" } });
      expect((await call("PATCH", path, { target: "192.168.1.1" })).status).toBe(400);
      expect(await call("PATCH", path, { target: "8.8.8.8:53" })).toMatchObject({ status: 400, body: { error: SHAPE } });

      // an Uptime Kuma style ping record imports as a ping monitor
      const preview = await call("POST", "/monitors/import/preview", { monitors: [{ sourceId: "p1", name: "Kuma ping", type: "ping", hostname: "1.1.1.1", interval: 60 }] });
      expect(preview.status).toBe(200);
      expect(preview.body.report[0]).toMatchObject({ type: "ping" });
      expect(preview.body.report[0].error).toBeUndefined();

      // Workers cannot run processes: creating one there is refused with an explanation
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      try {
        expect(await call("POST", "/monitors", { name: "Edge", type: "ping", target: "1.1.1.1" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^Ping checks need the self-hosted Node runtime/) } });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      await db.close(1);
    }
  });
});
