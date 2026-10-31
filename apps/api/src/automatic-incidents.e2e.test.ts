import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { checkOne } from "./scheduler";
import { setMailTransport } from "./email";

// Real DB-backed automatic failure -> incident -> alert -> heartbeat recovery.
// No external network targets and no actual SMTP: a local transport records
// the exact messages the application's alert-dispatch path would send.
const connection = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = {
  DATABASE_URL: connection,
  BETTER_AUTH_SECRET: "synthetic-auto-incident-test-secret-12345",
  BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, EMAIL_FROM: "alerts@example.test",
};

describe.skipIf(!connection)("automatic heartbeat incident and alert lifecycle", () => {
  it("opens only after two misses and sends exactly one down and one recovery alert", async () => {
    const app = createApp(openDatabase);
    const db = openDatabase(connection!, { max: 2 });
    const captured: { to: string; subject: string; text: string }[] = [];
    setMailTransport(async (message) => { captured.push({
      to: message.to, subject: message.subject, text: message.text,
    }); });
    let cookie = "";
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await app.fetch(new Request(origin + "/api" + path, {
        method, headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env as never);
      const nextCookie = response.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
      if (nextCookie) cookie = nextCookie;
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
    try {
      const signup = await call("POST", "/auth/sign-up/email", {
        email: `automatic-${crypto.randomUUID()}@example.test`,
        name: "Synthetic only", password: "correct horse battery",
      });
      expect(signup.status).toBe(200);
      const organizationId = (await call("GET", "/me")).body.organization.id as string;
      const channel = await call("POST", "/channels", {
        name: "Synthetic email sink", type: "email",
        config: { to: "synthetic-recipient@example.test" },
      });
      expect(channel.status).toBe(201);
      const created = await call("POST", "/monitors", {
        name: "Synthetic missed cron", type: "heartbeat",
        intervalSec: 60, failureThreshold: 2, recoveryThreshold: 2,
        channelIds: [channel.body.id],
      });
      expect(created.status).toBe(201);
      // Signup may send an account verification email to the fake in-memory
      // transport. Only count alert events after the monitor was created.
      captured.length = 0;
      const id = created.body.id as string;
      const token = created.body.heartbeatToken as string;
      const miss = async () => {
        await db.query(
          "UPDATE monitor_observation SET valid_until = now() - interval '1 second' WHERE monitor_id=$1",
          [id],
        );
        const snapshot = await db.repo.getMonitor(organizationId, id, null);
        expect(snapshot).not.toBeNull();
        await checkOne(db.repo, snapshot!);
      };
      const detail = () => call("GET", `/monitors/${id}`);
      const incidents = () => call("GET", "/incidents");

      await miss();
      expect((await detail()).body).toMatchObject({ consecutiveFailures: 1 });
      expect(await db.repo.hasOpenIncident(id, false)).toBe(false);
      expect(captured).toHaveLength(0);

      await miss();
      expect((await detail()).body).toMatchObject({ status: "down", consecutiveFailures: 2 });
      const opened = (await incidents()).body.filter((item: any) => item.monitorId === id);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ auto: true, status: "investigating" });
      expect(captured).toHaveLength(1);
      expect(captured[0].to).toBe("synthetic-recipient@example.test");
      expect(captured[0].subject).toContain("Synthetic missed cron");

      // Repeated deadline failures while still down are not fresh incidents.
      await miss();
      expect((await incidents()).body.filter((item: any) => item.monitorId === id)).toHaveLength(1);
      expect(captured).toHaveLength(1);

      // The first valid heartbeat cannot prematurely declare recovery.
      expect((await call("POST", `/heartbeat/${token}`)).status).toBe(200);
      expect((await detail()).body).toMatchObject({ status: "down", consecutiveSuccesses: 1 });
      expect(captured).toHaveLength(1);
      // A second heartbeat completes recovery and sends one recovery alert.
      expect((await call("POST", `/heartbeat/${token}`)).status).toBe(200);
      expect((await detail()).body).toMatchObject({ status: "up", consecutiveSuccesses: 2 });
      expect(await db.repo.hasOpenIncident(id, false)).toBe(false);
      const resolved = await call("GET", `/incidents/${opened[0].id}`);
      expect(resolved.body).toMatchObject({ status: "resolved", auto: true });
      expect(resolved.body.resolvedAt).toBeTruthy();
      expect(captured).toHaveLength(2);
      expect(captured[1].subject).toContain("Synthetic missed cron");
      const delivery = await db.query<{ kind: string; status: string }>(
        "SELECT kind,status FROM alert_delivery WHERE incident_id=$1 ORDER BY created_at,id",
        [opened[0].id],
      );
      expect(delivery).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "incident.opened", status: "sent" }),
        expect.objectContaining({ kind: "incident.resolved", status: "sent" }),
      ]));
    } finally {
      setMailTransport(undefined);
      await db.close(2);
    }
  }, 40_000);
});
