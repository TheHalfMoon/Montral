import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Runs only when TEST_DATABASE_URL points at a database (shared with the other end-to-end tests).
const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "cron" };

describe.skipIf(!url)("request hardening", () => {
  const app = createApp(openDatabase);
  const raw = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env as never);

  it("404s malformed ids and keeps a paused heartbeat monitor paused", async () => {
    await raw("/internal/migrate", { method: "POST", headers: { "x-cron-secret": "cron" } });
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `hard-${Date.now()}@example.com`, password: "correct horse battery", name: "Ada" }),
    });
    expect(su.status).toBe(200);
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    for (const path of ["/monitors/nope", "/channels/nope", "/status-pages/nope", "/incidents/nope", "/maintenance/nope"]) {
      expect([path, (await call("GET", path)).status]).toEqual([path, 404]);
    }
    expect((await call("PATCH", "/monitors/nope", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/channels/nope")).status).toBe(404);

    const hb = (await call("POST", "/monitors", { name: "Cron", type: "heartbeat", intervalSec: 3600 })).body;
    expect(hb.heartbeatToken).toBeTruthy();
    expect((await raw(`/api/heartbeat/${hb.heartbeatToken}`)).status).toBe(200);
    const before = (await call("GET", `/monitors/${hb.id}`)).body;
    expect(before.status).toBe("up");
    expect(new Date(before.nextCheckAt).getTime()).toBeGreaterThan(Date.now() + 3000_000);
    for (const body of [{}, { region: "auto" }]) {
      expect(await call("POST", `/monitors/${hb.id}/check`, body)).toMatchObject({ status: 400, body: { code: "regions_not_supported" } });
    }
    const after = (await call("GET", `/monitors/${hb.id}`)).body;
    expect(after.status).toBe("up");
    expect(after.nextCheckAt).toBe(before.nextCheckAt);
    expect(after.results).toEqual(before.results);
    expect((await call("GET", "/incidents")).body).toEqual([]);
    expect((await call("PATCH", `/monitors/${hb.id}`, { paused: true })).body.status).toBe("paused");
    const ping = await raw(`/api/heartbeat/${hb.heartbeatToken}`);
    expect(ping.status).toBe(200);
    expect((await call("GET", `/monitors/${hb.id}`)).body.status).toBe("paused");
  });

  it("refuses oversized auth email body before forwarding to provider", async () => {
    const response = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "large@example.test", name: "x".repeat(32 * 1024), password: "synthetic" }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Payload too large" });
  });

  it("rejects a stalled public email-auth request with no-store HTTP 408 before provider handling", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"email":"slow@example.test"')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const response = await app.fetch(new Request(ORIGIN + "/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body, duplex: "half",
    } as RequestInit & { duplex: "half" }), env as never);
    expect(response.status).toBe(408);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "Authentication body read timeout" });
    expect(canceled).toBe(true);
  }, 15_000);

  it("limits repeated signups for one email even without a trusted client address", async () => {
    const email = `signup-throttle-${crypto.randomUUID()}@example.test`;
    const attempt = () => raw("/api/auth/sign-up/email", { method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9",
        "cf-connecting-ip": "8.8.8.8" },
      body: JSON.stringify({ email, name: "Synthetic QA", password: "invalid" }),
    });
    const codes = [];
    for (let n = 0; n < 4; n++) codes.push((await attempt()).status);
    expect(codes.slice(0, 3)).not.toContain(429);
    expect(codes[3]).toBe(429);
  });

  it("shows an owner the channel credentials, accepts them back unchanged, and rate limits sign-in per address", async () => {
    const email = `hard2-${Date.now()}@example.com`;
    const su = await raw("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
    });
    const cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await raw(`/api${path}`, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    const hook = "https://hooks.slack.com/services/T000/B000/abcdef";
    const created = (await call("POST", "/channels", { type: "slack", name: "Ops", config: { url: hook } })).body;
    expect(created.config.url).toBe(hook); // owners see it
    const renamed = await call("PATCH", `/channels/${created.id}`, { name: "Ops 2", config: { url: hook } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Ops 2");

    // the limit counts attempts per address, whether or not the password is right
    const attempt = () =>
      raw("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `Nobody-${email}`, password: "wrong password" }) });
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 15).every((s) => s !== 429)).toBe(true);
    expect(statuses[16]).toBe(429);
  });
});
