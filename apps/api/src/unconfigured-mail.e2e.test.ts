import { openDatabase } from "@montral/db-pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "no-provider-test-secret-local-only-123", BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN };

describe.skipIf(!url)("missing email provider on real PostgreSQL", () => {
  it("does not misreport an unsent email alert as delivered", async () => {
    setMailTransport(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createApp(openDatabase);
    const db = openDatabase(url!, { max: 2 });
    try {
      const signup = await app.fetch(new Request(ORIGIN + "/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email: `undelivered-${crypto.randomUUID()}@example.test`,
          name: "Synthetic", password: "correct horse battery" }),
      }), env as never);
      expect(signup.status).toBe(200);
      const cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      const post = async (path: string, body?: unknown) => {
        const response = await app.fetch(new Request(ORIGIN + "/api" + path, {
          method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), env as never);
        return { status: response.status, body: await response.json().catch(() => null) as any };
      };
      const created = await post("/channels", {
        name: "Unconfigured synthetic email", type: "email",
        config: { to: "synthetic-recipient@example.test" },
      });
      expect(created.status).toBe(201);
      const result = await post(`/channels/${created.body.id}/test`);
      expect(result.status).toBe(502);
      expect(result.body?.error).toBe("Email provider is not configured");
      const recorded = await db.query<{ status: string; error: string }>(
        "SELECT status, error FROM alert_delivery WHERE channel_id=$1 AND kind='test'", [created.body.id],
      );
      expect(recorded).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "failed", error: "Email provider is not configured" }),
      ]));
      expect(recorded.some(r => r.status === "sent")).toBe(false);
      // Neither the one-time verification link nor recipient addresses are in
      // fallback console logs. They are not substitute email delivery.
      const all = warn.mock.calls.flat().join(" ");
      expect(all).not.toContain("verify-email?token=");
      expect(all).not.toContain("synthetic-recipient@example.test");
    } finally {
      warn.mockRestore();
      await db.close(2);
    }
  }, 25_000);
});

describe.skipIf(!url)("channel test provider diagnostic privacy", () => {
  it("hides provider error details from both HTTP and audit", async () => {
    const app = createApp(openDatabase);
    const db = openDatabase(url!, { max: 2 });
    const marker = `private-provider-debug-${crypto.randomUUID()}`;
    try {
      const settings = { ...env, EMAIL_FROM: "alerts@example.test" };
      const post = async (cookie: string, path: string, body?: unknown) => {
        const res = await app.fetch(new Request(ORIGIN + "/api" + path, {
          method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }), settings as never);
        return { status: res.status, data: await res.json().catch(() => null) as any,
          cookie: res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ") };
      };
      const signup = await post("", "/auth/sign-up/email", { email: `provider-${crypto.randomUUID()}@example.test`, name: "Synthetic", password: "correct horse battery" });
      expect(signup.status).toBe(200);
      const channel = await post(signup.cookie, "/channels", { type: "email", name: "Synthetic email", config: { to: "synthetic-recipient@example.test" } });
      expect(channel.status).toBe(201);
      setMailTransport(async () => { throw new Error(marker); });
      const outcome = await post(signup.cookie, `/channels/${channel.data.id}/test`);
      expect(outcome.status).toBe(502);
      expect(outcome.data).toEqual({ error: "notification delivery failed" });
      const audit = await db.query<{ status: string; error: string }>(
        "SELECT status,error FROM alert_delivery WHERE channel_id=$1 AND kind='test'", [channel.data.id]);
      expect(audit).toContainEqual(expect.objectContaining({ status: "failed", error: "notification delivery failed" }));
      expect(JSON.stringify([outcome.data, audit])).not.toContain(marker);
    } finally { setMailTransport(undefined); await db.close(2); }
  });
});
