import { openDatabase } from "@montral/db-pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "membership-test-secret-not-for-production", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin };

describe.skipIf(!url)("workspace membership", () => {
  it("revokes reads and writes for removed members, including cached sessions", async () => {
    const db = openDatabase(url!, { max: 1 });
    await db.migrate();
    const app = createApp(openDatabase);
    const call = async (cookie: string, method: string, path: string, body?: unknown) => {
      const r = await app.fetch(new Request(`${origin}/api${path}`, {
        method, headers: { cookie, origin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env as never);
      return { status: r.status, body: await r.json().catch(() => null) as any, cookie: r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
    };
    const signup = async (name: string) => {
      const email = `${name}-${crypto.randomUUID()}@example.com`;
      const r = await call("", "POST", "/auth/sign-up/email", { email, name, password: "correct horse battery" });
      expect(r.status).toBe(200);
      await db.query(`update "user" set email_verified = true where id = $1`, [r.body.user.id]);
      const login = await call("", "POST", "/auth/sign-in/email", { email, password: "correct horse battery" });
      expect(login.status).toBe(200);
      return { email, id: r.body.user.id, cookie: login.cookie };
    };
    try {
      const owner = await signup("membership-owner");
      const member = await signup("membership-member");
      const orgId = (await call(owner.cookie, "GET", "/me")).body.organization.id;
      const invite = await call(owner.cookie, "POST", "/auth/organization/invite-member", { organizationId: orgId, email: member.email, role: "member" });
      expect(invite.status).toBe(200);
      expect((await call(member.cookie, "POST", "/auth/organization/accept-invitation", { invitationId: invite.body.id })).status).toBe(200);
      const active = await call(member.cookie, "POST", "/auth/organization/set-active", { organizationId: orgId });
      expect(active.status).toBe(200);
      const cookie = active.cookie || member.cookie;
      expect(await db.repo.isMember(member.id, orgId)).toBe(true);
      expect((await call(cookie, "GET", "/monitors")).status).toBe(200);
      // Keep live session authentication and membership intact even when an
      // untrusted optional project-selector cookie has broken URL escapes.
      for (const malformed of ["%", "%ZZ", "%E0%A4%A", "%C3%28"]) {
        expect((await call(`${cookie}; montral_project=${malformed}`, "GET", "/monitors")).status).toBe(200);
      }
      // keys the member pinned to this workspace go with the membership; a key pinned to their own workspace stays
      const ownOrg = (await db.query<{ organization_id: string }>(`select organization_id from member where user_id = $1 and organization_id <> $2 limit 1`, [member.id, orgId]))[0]?.organization_id;
      const pinned = await call(cookie, "POST", "/auth/api-key/create", { name: "pinned-here", metadata: { organizationId: orgId } });
      expect(pinned.status).toBe(200);
      const elsewhere = ownOrg ? await call(cookie, "POST", "/auth/api-key/create", { name: "pinned-elsewhere", metadata: { organizationId: ownOrg } }) : null;
      const keyCall = (key: string) => app.fetch(new Request(`${origin}/api/monitors`, { headers: { "x-api-key": key } }), env as never);
      expect((await keyCall(pinned.body.key)).status).toBe(200);
      expect((await call(owner.cookie, "POST", "/auth/organization/remove-member", { organizationId: orgId, memberIdOrEmail: member.email })).status).toBe(200);
      expect(await db.repo.isMember(member.id, orgId)).toBe(false);
      expect(await db.query(`select 1 from apikey where id = $1`, [pinned.body.id])).toHaveLength(0);
      expect((await keyCall(pinned.body.key)).status).toBe(401);
      // nor can the former member prepare a new key pinned to the workspace
      expect((await call(cookie, "POST", "/auth/api-key/create", { name: "prepared", metadata: { organizationId: orgId } })).status).toBe(403);
      if (elsewhere) expect(await db.query(`select 1 from apikey where id = $1`, [elsewhere.body.id])).toHaveLength(1);
      // re-inviting the member does not bring the revoked key back
      const again = await call(owner.cookie, "POST", "/auth/organization/invite-member", { organizationId: orgId, email: member.email, role: "member" });
      expect(again.status).toBe(200);
      expect((await call(member.cookie, "POST", "/auth/organization/accept-invitation", { invitationId: again.body.id })).status).toBe(200);
      expect((await keyCall(pinned.body.key)).status).toBe(401);
      expect((await call(owner.cookie, "POST", "/auth/organization/remove-member", { organizationId: orgId, memberIdOrEmail: member.email })).status).toBe(200);
      for (const session of [cookie, cookie.split("; ").filter((c) => c.split("=")[0].endsWith("session_token")).join("; ")]) {
        expect(session).not.toBe("");
        expect((await call(session, "GET", "/monitors")).status).toBe(403);
        expect((await call(session, "POST", "/monitors", { name: "Removed", type: "heartbeat", intervalSec: 3600 })).status).toBe(403);
      }
      expect((await call(owner.cookie, "GET", "/monitors")).status).toBe(200);
      // An explicit switch to a workspace the member still belongs to remains available through auth.
      expect((await call(cookie, "POST", "/auth/organization/set-active", { organizationId: null })).status).toBe(200);
    } finally {
      await db.close(1);
    }
  });
});
