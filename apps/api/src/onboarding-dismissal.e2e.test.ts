import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const env = {
  DATABASE_URL: url,
  BETTER_AUTH_SECRET: "onboarding-test-only-secret-not-for-production",
  BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN, CRON_SECRET: "onboarding-test-cron",
};
const app = createApp(openDatabase, { edition: montralEdition });
const db = url ? openDatabase(url, { max: 4 }) : null;
const cookieFrom = (response: Response) => response.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");

async function request(cookie: string, method: string, path: string, body?: unknown) {
  const result = await app.fetch(new Request(ORIGIN + path, {
    method, headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env as never);
  return { status: result.status, cookie: cookieFrom(result), headers: result.headers,
    body: await result.json().catch(() => null) as any };
}

async function signUp() {
  const email = `onboard-${crypto.randomUUID()}@example.com`;
  const password = "correct horse battery staple";
  const r = await request("", "POST", "/api/auth/sign-up/email", { email, name: "Onboarding QA", password });
  expect(r.status).toBe(200);
  const me = await request(r.cookie, "GET", "/api/me");
  expect(me.status).toBe(200);
  return { email, password, cookie: r.cookie, userId: me.body.userId as string, orgId: me.body.organization.id as string };
}

describe.skipIf(!url)("server-backed onboarding dismissal (PostgreSQL)", () => {
  beforeAll(async () => {
    const r = await app.fetch(new Request(ORIGIN + "/internal/migrate", {
      method: "POST", headers: { "x-cron-secret": env.CRON_SECRET },
    }), env as never);
    expect(r.status).toBe(200);
  });
  afterAll(async () => { await db?.close(1); });

  it("persists across sessions, is per user and workspace, and rejects anonymous access", async () => {
    expect((await request("", "GET", "/api/onboarding/dismissal")).status).toBe(401);
    const owner = await signUp();
    const first = await request(owner.cookie, "GET", "/api/onboarding/dismissal");
    expect(first).toMatchObject({ status: 200, body: { dismissed: false } });
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect((await request(owner.cookie, "POST", "/api/onboarding/dismissal")).body).toEqual({ dismissed: true });
    expect((await request(owner.cookie, "POST", "/api/onboarding/dismissal")).body).toEqual({ dismissed: true });
    const [rows] = await db!.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM onboarding_dismissal WHERE organization_id=$1 AND user_id=$2",
      [owner.orgId, owner.userId],
    );
    expect(rows.n).toBe("1");

    const signedIn = await request("", "POST", "/api/auth/sign-in/email",
      { email: owner.email, password: owner.password });
    expect(signedIn.status).toBe(200);
    expect((await request(signedIn.cookie, "GET", "/api/onboarding/dismissal")).body).toEqual({ dismissed: true });

    const other = await signUp();
    await db!.query("INSERT INTO member(id, organization_id, user_id, role, created_at) VALUES ($1,$2,$3,'member',now())",
      [crypto.randomUUID(), owner.orgId, other.userId]);
    const switchedMember = await request(other.cookie, "POST", "/api/auth/organization/set-active", { organizationId: owner.orgId });
    expect(switchedMember.status).toBe(200);
    const memberCookie = switchedMember.cookie || other.cookie;
    expect((await request(memberCookie, "GET", "/api/onboarding/dismissal")).body).toEqual({ dismissed: false });
    expect((await request(memberCookie, "POST", "/api/onboarding/dismissal")).body).toEqual({ dismissed: true });
    expect((await request(owner.cookie, "GET", "/api/onboarding/dismissal")).body).toEqual({ dismissed: true });

    const created = await request(owner.cookie, "POST", "/api/workspaces", { name: "Onboarding alternate" });
    expect(created.status).toBe(201);
    const switchedOwner = await request(owner.cookie, "POST", "/api/auth/organization/set-active", { organizationId: created.body.id });
    expect(switchedOwner.status).toBe(200);
    expect((await request(switchedOwner.cookie || owner.cookie, "GET", "/api/onboarding/dismissal")).body).toEqual({ dismissed: false });
  }, 60_000);
});
