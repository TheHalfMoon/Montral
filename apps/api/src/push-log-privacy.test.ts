import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { configureApns } from "./apns";
import { push } from "./routes/push";

/** Client device registration must not expose errors from DB-backed automatic channel setup. */
describe("push auto-channel log privacy", () => {
  it("keeps the device registration successful without logging credentials on channel setup failure", async () => {
    const privateToken = "a".repeat(64);
    const secret = `synthetic-channel-secret-${crypto.randomUUID()}`;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    configureApns({ APNS_KEY: "test-local-only", APNS_KEY_ID: "key", APNS_TEAM_ID: "team", APNS_BUNDLE_ID: "app.example.test" });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("userId", "test-user");
      c.set("repo", {
        withinLimit: async () => true,
        upsertPushDevice: async () => ({ id: "device-1", userId: "test-user", token: privateToken,
          platform: "ios", environment: "sandbox", name: null, locale: null, critical: false,
          createdAt: new Date(), lastSeenAt: new Date() }),
        managedOrgsWithoutPushChannel: async () => ["test-org"],
        createChannel: async () => { throw new Error(`database error ${privateToken} ${secret}`); },
      } as never);
      await next();
    });
    app.route("/push", push);
    try {
      const response = await app.request("/push/devices", { method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: privateToken, platform: "ios", environment: "sandbox" }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { token: string }).token).toBe(privateToken);
      const logged = errors.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("could not create the push channel");
      expect(logged).not.toContain(privateToken);
      expect(logged).not.toContain(secret);
    } finally {
      errors.mockRestore();
      configureApns({});
    }
  });
});
