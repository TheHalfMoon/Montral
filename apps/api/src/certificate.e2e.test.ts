import { openDatabase } from "@montral/db-pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "certificate-monitor-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("certificate monitors through the API", () => {
  it("validates targets, bounds intervals, keeps one region and refuses Workers deployments", async () => {
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
      expect((await call("POST", "/auth/sign-up/email", { email: `certificate-${crypto.randomUUID()}@example.com`, name: "Certificate", password: "correct horse battery" })).status).toBe(200);

      const mon = await call("POST", "/monitors", { name: "TLS", type: "certificate", target: "1.1.1.1", intervalSec: 60, domainExpiryWarnDays: 14 });
      expect(mon).toMatchObject({ status: 201, body: { type: "certificate", target: "1.1.1.1", intervalSec: 3600, domainExpiryWarnDays: 14, regions: ["auto"] } });
      expect((await call("POST", "/monitors", { name: "Port", type: "certificate", target: "1.1.1.1:853", intervalSec: 172800 })).status).toBe(400); // over the schema maximum
      expect((await call("POST", "/monitors", { name: "Daily", type: "certificate", target: "1.1.1.1:853", intervalSec: 86400 })).body).toMatchObject({ intervalSec: 86400 });

      // malformed and private targets are refused, as for tcp
      expect(await call("POST", "/monitors", { name: "Url", type: "certificate", target: "https://1.1.1.1/path" })).toMatchObject({ status: 400, body: { error: "Target must be host or host:port" } });
      expect(await call("POST", "/monitors", { name: "Private", type: "certificate", target: "127.0.0.1:443" })).toMatchObject({ status: 400, body: { code: "target_not_allowed" } });
      expect((await call("POST", "/monitors", { name: "Remote", type: "certificate", target: "1.1.1.1", regions: ["us-east"] })).status).toBe(400);
      expect((await call("POST", "/monitors", { name: "Warn", type: "certificate", target: "1.1.1.1", domainExpiryWarnDays: 0 })).status).toBe(400);

      const path = `/monitors/${mon.body.id}`;
      expect(await call("PATCH", path, { intervalSec: 60, domainExpiryWarnDays: 45 })).toMatchObject({ status: 200, body: { intervalSec: 3600, domainExpiryWarnDays: 45 } });
      expect((await call("PATCH", path, { target: "10.0.0.1" })).status).toBe(400);

      // the import path applies the same bounds
      const preview = await call("POST", "/monitors/import/preview", { monitors: [{ sourceId: "c1", name: "Imported", type: "certificate", target: "1.1.1.1", intervalSec: 60 }] });
      expect(preview.body.report[0]).toMatchObject({ intervalSec: 3600, warnings: expect.arrayContaining(["Interval adjusted to the 1 hour to 1 day range for certificate checks"]) });

      // Workers have no node:tls: creating one there is refused with an explanation
      vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
      try {
        expect(await call("POST", "/monitors", { name: "Edge", type: "certificate", target: "1.1.1.1" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^Certificate checks need the self-hosted Node runtime/) } });
      } finally {
        vi.unstubAllGlobals();
      }
    } finally {
      await db.close(1);
    }
  });
});
