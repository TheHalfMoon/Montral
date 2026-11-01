import { openDatabase } from "@montral/db-pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

const url = process.env.TEST_DATABASE_URL;
const base = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "test-only-auth-key-12345678901234", BETTER_AUTH_URL: base, WEB_ORIGIN: base, EMAIL_FROM: "alerts@example.test" };

describe.skipIf(!url)("account security notice log privacy", () => {
  it("keeps a reset successful while suppressing mail-provider exception details", async () => {
    const app = createApp(openDatabase);
    const email = `notice-${crypto.randomUUID()}@example.test`;
    const marker = `synthetic-diagnostic-${crypto.randomUUID()}`;
    const sent: { to: string; subject: string; text: string }[] = [];
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempted = false;
    const post = (path: string, body: unknown) => app.fetch(new Request(base + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), env as never);
    try {
      setMailTransport(async (msg) => {
        if (msg.subject === "Your Montral password was changed") {
          attempted = true;
          throw new Error(`SMTP failure ${email} ${marker}`);
        }
        sent.push(msg);
      });
      expect((await post("/api/auth/sign-up/email", { email, password: "initial synthetic password", name: "Synthetic User" })).status).toBe(200);
      expect((await post("/api/auth/request-password-reset", { email, redirectTo: `${base}/reset-password` })).status).toBe(200);
      const link = sent.find((msg) => msg.to === email && /reset/i.test(msg.subject));
      expect(link).toBeTruthy();
      const token = /reset-password\/([^?"&\s]+)/.exec(link!.text)?.[1];
      expect(token).toBeTruthy();
      const reset = await post("/api/auth/reset-password", { newPassword: "replacement synthetic password", token });
      expect(reset.status).toBe(200);
      expect(attempted).toBe(true);
      expect((await post("/api/auth/sign-in/email", { email, password: "replacement synthetic password" })).status).toBe(200);
      const output = logs.mock.calls.flat().map(String).join(" ");
      expect(output).toContain("password-changed email failed");
      expect(output).not.toContain(marker);
      expect(output).not.toContain(email);
      expect(output).not.toContain(token!);
    } finally {
      setMailTransport(undefined);
      logs.mockRestore();
    }
  });
});
