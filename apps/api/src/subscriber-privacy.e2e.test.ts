import { openDatabase } from "@montral/db-pg";
import { describe, expect, it, vi } from "vitest";
import { setMailTransport } from "./email";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "subscriber-access-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, EMAIL_FROM: "alerts@example.test" };

/** Subscriber email addresses are personal data, not monitoring telemetry. */
describe.skipIf(!url)("status subscriber contact privacy on real PostgreSQL", () => {
  it("restricts subscriber email enumeration to current workspace managers and keeps other status reads working", async () => {
    const db = openDatabase(url!, { max: 3 });
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const response = await app.fetch(new Request(`${origin}/api${path}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), origin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env as never);
      return { status: response.status, body: await response.json().catch(() => null) as any,
        headers: response.headers,
        cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const signup = async () => {
      const email = `subscriber-privacy-${crypto.randomUUID()}@example.com`;
      const response = await call("", "POST", "/auth/sign-up/email", { email, password: "correct horse battery staple", name: "Privacy QA" });
      expect(response.status).toBe(200);
      return { id: response.body.user.id as string, cookie: response.cookie };
    };
    try {
      await db.migrate();
      const owner = await signup();
      const member = await signup();
      const outsider = await signup();
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id as string;
      await db.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'member',NOW())", [crypto.randomUUID(), orgId, member.id]);
      const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId });
      expect(active.status).toBe(200);
      const memberCookie = active.cookie || member.cookie;
      const slug = `pii-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
      const created = await call(owner.cookie, "POST", "/status-pages", { slug, title: "Synthetic public status" });
      expect(created.status).toBe(201);
      const pageId = created.body.id as string;
      // A provider may return internal credentials or email addresses inside
      // its exception; a public subscription must never log those details.
      const marker = `synthetic-provider-private-${crypto.randomUUID()}`;
      const noisy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        setMailTransport(async () => { throw new Error(marker); });
        const pendingEmail = `pending-${crypto.randomUUID()}@example.test`;
        const response = await call("", "POST", `/public/status/${slug}/subscribe`, { email: pendingEmail });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
        const pending = await db.query<{ confirmed_at: Date | null }>(
          "SELECT confirmed_at FROM status_subscriber WHERE status_page_id=$1 AND email=$2", [pageId, pendingEmail]);
        expect(pending).toEqual([{ confirmed_at: null }]);
        const logged = noisy.mock.calls.flat().map(String).join(" ");
        expect(logged).toContain("subscription email failed");
        expect(logged).not.toContain(marker);
        expect(logged).not.toContain(pendingEmail);
      } finally {
        setMailTransport(undefined);
        noisy.mockRestore();
      }
      const syntheticEmail = `private-recipient-${crypto.randomUUID()}@example.test`;
      const subscriberId = crypto.randomUUID();
      await db.query("INSERT INTO status_subscriber(id,status_page_id,email,token,confirmed_at) VALUES($1,$2,$3,$4,NOW())", [subscriberId, pageId, syntheticEmail, crypto.randomUUID()]);
      const path = `/status-pages/${pageId}/subscribers`;
      // Ordinary members still see the status page and its public information.
      expect((await call(memberCookie, "GET", `/status-pages/${pageId}`)).status).toBe(200);
      expect((await call(memberCookie, "GET", "/status-pages")).status).toBe(200);
      const denied = await call(memberCookie, "GET", path);
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain(syntheticEmail);
      expect(denied.headers.get("cache-control")).toBe("private, no-store");
      const allowed = await call(owner.cookie, "GET", path);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: subscriberId, email: syntheticEmail })]));
      expect(allowed.headers.get("cache-control")).toBe("private, no-store");
      expect(allowed.headers.get("referrer-policy")).toBe("no-referrer");
      expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
      expect(allowed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect((await call(memberCookie, "DELETE", `${path}/${subscriberId}`)).status).toBe(403);
      expect((await call(outsider.cookie, "GET", path)).status).toBe(404);
      expect((await call("", "GET", path)).status).toBe(401);
      // A member can be promoted, then authorized to view contact data without
      // re-logging-in; downgrade revokes access even for the cached session.
      await db.query("UPDATE member SET role='admin' WHERE organization_id=$1 AND user_id=$2", [orgId, member.id]);
      expect((await call(memberCookie, "GET", path)).status).toBe(200);
      await db.query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2", [orgId, member.id]);
      expect((await call(memberCookie, "GET", path)).status).toBe(403);
    } finally { await db.close(1); }
  });
});
