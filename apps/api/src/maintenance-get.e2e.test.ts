import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "maintenance-get-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("GET /maintenance/:id", () => {
  it("returns one window even beyond the capped list, scoped to the workspace and a limited key's projects", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    const session = () => {
      // a cookie jar: a response that sets one cookie must not drop the session cookie
      const jar = new Map<string, string>();
      return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        const r = await app.fetch(new Request(`${origin}/api${path}`, { method, headers: { cookie, origin, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env as never);
        for (const c of r.headers.getSetCookie()) {
          const [pair] = c.split(";");
          const at = pair.indexOf("=");
          jar.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return { status: r.status, body: (await r.json().catch(() => null)) as any };
      };
    };
    const owner = session();
    const other = session();
    try {
      await owner("POST", "/auth/sign-up/email", { email: `mget-${crypto.randomUUID()}@example.com`, name: "Owner", password: "correct horse battery" });
      await other("POST", "/auth/sign-up/email", { email: `mget-${crypto.randomUUID()}@example.com`, name: "Other", password: "correct horse battery" });

      // a window that ended yesterday: the list puts ended windows after every active or upcoming one
      const day = 86400_000;
      const endedStart = Date.now() - 2 * day;
      const ended = await owner("POST", "/maintenance", { name: "Ended", startsAt: new Date(endedStart).toISOString(), endsAt: new Date(endedStart + 3600_000).toISOString() });
      expect(ended.status).toBe(201);

      // three daily series of 367 upcoming occurrences push it past the 1000-window cap of GET /maintenance
      const start = Date.now() + 3600_000;
      for (let i = 0; i < 3; i++) {
        const made = await owner("POST", "/maintenance", { name: `Series ${i}`, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 600_000).toISOString(), recurrence: { frequency: "daily", timeZone: "UTC", until: new Date(start + 366 * day).toISOString() } });
        expect(made.status).toBe(201);
      }
      const list = (await owner("GET", "/maintenance")).body as { id: string }[];
      expect(list).toHaveLength(1000);
      expect(list.some((w) => w.id === ended.body.id)).toBe(false);

      const one = await owner("GET", `/maintenance/${ended.body.id}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ id: ended.body.id, name: "Ended", projectId: ended.body.projectId, seriesId: null, recurrence: null });

      expect((await owner("GET", `/maintenance/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await owner("GET", "/maintenance/not-a-uuid")).status).toBe(404);
      // another workspace cannot read it
      expect((await other("GET", `/maintenance/${ended.body.id}`)).status).toBe(404);

      // a key limited to another project cannot read it; a key for its own project can
      const org = (await owner("GET", "/me")).body.organization.id as string;
      const second = (await owner("POST", "/projects", { name: "Second" })).body.id as string;
      const key = async (projectIds: string[]) => {
        const made = await owner("POST", "/auth/api-key/create", { name: "k", metadata: { organizationId: org, projectIds } });
        expect(made.status, JSON.stringify(made.body)).toBe(200);
        return made.body.key as string;
      };
      const viaKey = async (k: string) => {
        const r = await app.fetch(new Request(`${origin}/api/maintenance/${ended.body.id}`, { headers: { "x-api-key": k } }), env as never);
        return `${r.status} ${await r.text()}`;
      };
      const ownProject = await key([ended.body.projectId]);
      const otherProject = await key([second]);
      expect(await viaKey(ownProject)).toMatch(/^200 /);
      expect(await viaKey(otherProject)).toMatch(/^404 /);
    } finally {
      await db.close(1);
    }
  });
});
