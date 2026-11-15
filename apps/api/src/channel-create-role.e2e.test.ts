import { openDatabase } from "@montral/db-pg";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { setMailTransport } from "./email";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("notification destination creation roles", () => {
  const database = url ? openDatabase(url) : undefined;
  afterAll(async () => { setMailTransport(undefined); await database?.close(); });
  it("refuses member sessions and keys while retaining owner/admin creation and member operational edits", async () => {
    setMailTransport(async () => {});
    const app = createApp(openDatabase);
    const origin = "http://localhost:8787";
    const env = { DATABASE_URL: url, BETTER_AUTH_SECRET: "synthetic-channel-role-secret-123456789", BETTER_AUTH_URL: origin, WEB_ORIGIN: origin, TRUST_PROXY: "true" };
    const ip = `2001:db8:74:${crypto.randomUUID().slice(0, 4)}::1`;
    let cookie = "";
    const request = async (path: string, method = "GET", body?: unknown, key?: string) => {
      const response = await app.fetch(new Request(origin + path, {
        method, headers: { origin, "content-type": "application/json", "x-forwarded-for": ip, ...(key ? { "x-api-key": key } : { cookie }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }), env as never);
      return { status: response.status, body: await response.json().catch(() => null) as any, response };
    };
    const signup = await request("/api/auth/sign-up/email", "POST", { email: `channel-role-${crypto.randomUUID()}@example.test`, name: "Channel owner", password: "correct horse battery" });
    expect(signup.status).toBe(200);
    cookie = signup.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const me = await request("/api/me");
    const org = me.body.organization.id as string;
    const user = signup.body.user.id as string;
    const createdKey = await request("/api/auth/api-key/create", "POST", { name: "Role regression", metadata: { organizationId: org } });
    expect(createdKey.status).toBe(200);
    const key = createdKey.body.key as string;
    const body = (name: string) => ({ type: "email", name, config: { to: "synthetic-recipient@example.test" }, autoEnable: true });
    const owned = await request("/api/channels", "POST", body("Owner approved"));
    expect(owned.status).toBe(201);
    const role = (value: string) => database!.query("update member set role=$1 where organization_id=$2 and user_id=$3", [value, org, user]);
    await role("member");
    const sessionAttempt = await request("/api/channels", "POST", body("Member destination"));
    const keyAttempt = await request("/api/channels", "POST", { ...body("Member project destination"), scope: "project" }, key);
    expect([sessionAttempt.status, keyAttempt.status]).toEqual([403, 403]);
    expect(await database!.query("select id from alert_channel where organization_id=$1", [org])).toHaveLength(1);
    // Members retain the documented rename/toggle behavior, but cannot replace an approved destination.
    expect((await request(`/api/channels/${owned.body.id}`, "PATCH", { name: "Renamed", enabled: false })).status).toBe(200);
    expect((await request(`/api/channels/${owned.body.id}`, "PATCH", { config: { to: "replacement@example.test" } })).status).toBe(403);
    await role("admin");
    expect((await request("/api/channels", "POST", body("Admin approved"), key)).status).toBe(201);
    await role("owner");
    expect((await request("/api/channels", "POST", body("Owner approved again"))).status).toBe(201);
  }, 20_000);
});
