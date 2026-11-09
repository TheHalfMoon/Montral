import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { MANUAL_CHECKS_PER_WINDOW } from "./manual-check-gate";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("manual check limits", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
  async function workspace() {
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: `mcheck-${crypto.randomUUID()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return (method: string, path: string, body?: unknown) =>
      raw(`/api${path}`, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  it("a workspace gets a bounded number of manual checks per window; another workspace is unaffected", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const call = await workspace();
    // an unresolvable name fails fast without leaving the machine, so the loop measures the limit, not the network
    const created = await call("POST", "/monitors", { name: "Limit", type: "http", target: "https://montral-limit.invalid/" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    for (let i = 0; i < MANUAL_CHECKS_PER_WINDOW; i++) expect((await call("POST", `/monitors/${id}/check`, {})).status, `check ${i + 1}`).toBe(200);
    const refused = await call("POST", `/monitors/${id}/check`, {});
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ code: "manual_check_rate_limited" });

    const other = await workspace();
    const theirs = (await (await other("POST", "/monitors", { name: "Other", type: "http", target: "https://montral-limit.invalid/" })).json()) as { id: string };
    expect((await other("POST", `/monitors/${theirs.id}/check`, {})).status).toBe(200);
  }, 120_000);
});
