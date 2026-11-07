import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "montral-e2e-only-secret-not-for-production",
  BETTER_AUTH_URL: origin,
  WEB_ORIGIN: origin,
};

describe.skipIf(!url)("cookie-session cross-origin write guard (PostgreSQL)", () => {
  const database = url ? openDatabase(url, { max: 4 }) : null;
  const app = createApp(openDatabase, { edition: montralEdition });
  beforeAll(async () => { await migrateMontralSchema(database!, montralEdition); });
  afterAll(async () => { await database?.close(1); });

  async function session() {
    const res = await app.fetch(new Request(origin + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: `montral-origin-${crypto.randomUUID()}@example.com`, name: "Origin QA", password: "correct horse battery staple" }),
    }), env as never);
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  }
  const call = (cookie: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    app.fetch(new Request(origin + "/api" + path, {
      method,
      headers: { cookie, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env as never);
  const incident = { title: "Origin guard probe" };
  const count = async (cookie: string) => ((await (await call(cookie, "GET", "/incidents", { origin: "https://evil.example" })).json()) as unknown[]).length;

  it("refuses session-cookie writes from another origin and leaves no row behind", async () => {
    const cookie = await session();
    const before = await count(cookie);
    // A sibling subdomain is same-site, so a Lax cookie is sent: the guard must catch it.
    for (const headers of [
      { origin: "https://status.localhost:8787" },
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const res = await call(cookie, "POST", "/incidents", headers, incident);
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(await call(cookie, "DELETE", "/hooks/inboxes/" + crypto.randomUUID(), { origin: "https://evil.example" }).then((r) => r.status)).toBe(403);
    expect(await count(cookie)).toBe(before);
  });

  it("allows the web app's own origin, non-browser clients, and reads from anywhere", async () => {
    const cookie = await session();
    expect((await call(cookie, "POST", "/incidents", { origin }, incident)).status).toBe(201);
    expect((await call(cookie, "POST", "/incidents", { "sec-fetch-site": "same-origin" }, incident)).status).toBe(201);
    // No Origin and no Sec-Fetch-Site: not a browser, so not a forgery vector (native app, scripts).
    expect((await call(cookie, "POST", "/incidents", {}, incident)).status).toBe(201);
    expect((await call(cookie, "GET", "/incidents", { origin: "https://evil.example" })).status).toBe(200);
  });
});
