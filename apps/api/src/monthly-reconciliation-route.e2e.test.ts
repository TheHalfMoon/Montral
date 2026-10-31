import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import type { Bindings } from "./env";

const url = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:8787";
const month = "2026-09";
const enabled: Bindings = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "operator-reconciliation-fixture-secret-not-for-production",
  BETTER_AUTH_URL: origin, WEB_ORIGIN: origin,
  MONTRAL_METERING_ENABLED: "true", MONTRAL_RECONCILIATION_ENABLED: "true",
};
const app = createApp(openDatabase, { edition: montralEdition });
const db = url ? openDatabase(url, { max: 5 }) : null;
const users: string[] = [];

async function call(cookie: string, path: string, method = "GET", body?: unknown, options: { env?: Bindings; origin?: string; contentType?: string; authorization?: string } = {}) {
  const response = await app.fetch(new Request(`${origin}/api${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(method === "POST" ? { origin: options.origin ?? origin, "content-type": options.contentType ?? "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), (options.env ?? enabled) as never);
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null,
    cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
    cache: response.headers.get("cache-control") };
}

async function signup(label: string) {
  const email = `${label}-${crypto.randomUUID()}@example.test`;
  const first = await call("", "/auth/sign-up/email", "POST", { email, name: label, password: "correct horse battery staple" });
  expect(first.status).toBe(200);
  const userId = first.body!.user.id as string;
  users.push(userId);
  await db!.query('UPDATE "user" SET email_verified=true WHERE id=$1', [userId]);
  const login = await call("", "/auth/sign-in/email", "POST", { email, password: "correct horse battery staple" });
  expect(login.status).toBe(200);
  const me = await call(login.cookie, "/me");
  expect(me.status).toBe(200);
  return { cookie: login.cookie, userId, orgId: me.body!.organization.id as string };
}

async function seedAttempt(orgId: string, userId: string, state: "attempted" | "uncertain" = "uncertain", minutes = 65) {
  await db!.query("UPDATE workspace_setting SET monthly_report=true,last_report_month=$2 WHERE organization_id=$1", [orgId, month]);
  await db!.query(`INSERT INTO monthly_report_recipient
    (organization_id,report_month,recipient_user_id,recipient_email,locale,state,attempted_at,decided_at)
    VALUES($1,$2,$3,$4,'en',$5,NOW() - ($6::int * INTERVAL '1 minute'),
      CASE WHEN $5='uncertain' THEN NOW() - ($6::int * INTERVAL '1 minute') ELSE NULL END)`,
    [orgId, month, userId, `${userId}@example.test`, state, minutes]);
}

const review = (recipientUserId: string, override: Record<string, unknown> = {}) => ({
  month, recipientUserId, decision: "provider_accepted", evidenceRef: "provider:synthetic-confirmation-1001",
  acknowledgment: "I_verified_external_provider_evidence", ...override,
});

describe.skipIf(!url)("feature-gated authenticated owner-only reconciliation HTTP", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  afterAll(async () => {
    for (const user of users) await db!.query('DELETE FROM "user" WHERE id=$1', [user]);
    await db?.close(1);
  });

  it("is unavailable by default, in community edition and without a signed-in session", async () => {
    const owner = await signup("operator-off");
    await seedAttempt(owner.orgId, owner.userId);
    const path = `/monthly-reconciliation/summary?month=${month}`;
    expect((await call(owner.cookie, path, "GET", undefined, { env: { ...enabled, MONTRAL_RECONCILIATION_ENABLED: undefined } })).status).toBe(404);
    expect((await call(owner.cookie, path, "GET", undefined, { env: { ...enabled, MONTRAL_METERING_ENABLED: "false" } })).status).toBe(404);
    expect((await call("", path)).status).toBe(401);
    expect((await call("", path, "GET", undefined, { authorization: "Bearer fake-api-key" })).status).toBe(401);
    expect((await call(owner.cookie, path)).body).toEqual({ pending: 1, unresolved: 0, confirmed: 0 });
  });

  it("requires exact session owner role, exact Origin, JSON and explicit verified-evidence assertion", async () => {
    const owner = await signup("operator-owner");
    const member = await signup("operator-member");
    await seedAttempt(owner.orgId, owner.userId);
    await db!.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'member',NOW())", [`review-member-${crypto.randomUUID()}`, owner.orgId, member.userId]);
    const changed = await call(member.cookie, "/auth/organization/set-active", "POST", { organizationId: owner.orgId });
    expect(changed.status).toBe(200);
    const memberCookie = changed.cookie || member.cookie;
    const path = `/monthly-reconciliation/summary?month=${month}`;
    expect((await call(memberCookie, path)).status).toBe(403);
    expect((await call(memberCookie, "/monthly-reconciliation/review", "POST", review(owner.userId))).status).toBe(403);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId), { origin: "https://other.example.test" })).status).toBe(403);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId), { contentType: "text/plain" })).status).toBe(415);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId, { acknowledgment: "yes" }))).status).toBe(400);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId, { actorUserId: member.userId }))).status).toBe(400);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId, { evidenceRef: "secret raw evidence with spaces" }))).status).toBe(400);
    expect((await call(owner.cookie, "/monthly-reconciliation/summary?month=2026-13")).status).toBe(400);
    const initial = await call(owner.cookie, path);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ pending: 1, unresolved: 0, confirmed: 0 });
    expect(initial.cache).toContain("no-store");
    const applied = await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId));
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ applied: true });
    expect((await call(owner.cookie, path)).body).toEqual({ pending: 0, unresolved: 0, confirmed: 1 });
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId))).body).toEqual({ applied: false });
    const stored = await db!.query<{ state: string }>("SELECT state FROM monthly_report_recipient WHERE organization_id=$1 AND recipient_user_id=$2", [owner.orgId, owner.userId]);
    expect(stored[0].state).toBe("accepted");
  });

  it("lists only mature unreviewed opaque identities for current workspace owner", async () => {
    const owner = await signup("operator-redacted-queue");
    const other = await signup("operator-redacted-other");
    await seedAttempt(owner.orgId, owner.userId, "uncertain", 65);
    await seedAttempt(other.orgId, other.userId, "attempted", 65);
    const endpoint = `/monthly-reconciliation/pending?month=${month}`;
    expect((await call(owner.cookie, endpoint, "GET", undefined, { env: { ...enabled, MONTRAL_RECONCILIATION_ENABLED: undefined } })).status).toBe(404);
    expect((await call("", endpoint)).status).toBe(401);
    expect((await call(other.cookie, endpoint)).body).toMatchObject({ items: [{ recipientUserId: other.userId, state: "attempted" }] });
    const read = await call(owner.cookie, endpoint);
    expect(read.status).toBe(200);
    expect(read.body?.items).toHaveLength(1);
    expect(read.body?.items[0]).toMatchObject({ recipientUserId: owner.userId, state: "uncertain" });
    expect(read.body?.items[0].attemptedAt).toBeTruthy();
    expect(read.cache).toContain("no-store");
    const serialized = JSON.stringify(read.body);
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain("evidenceSha256");
    expect(serialized).not.toContain(other.userId);
    expect((await call(owner.cookie, "/monthly-reconciliation/pending?month=2026-13")).status).toBe(400);
    await db!.query("UPDATE monthly_report_recipient SET attempted_at=NOW()-INTERVAL '5 minutes' WHERE organization_id=$1", [owner.orgId]);
    expect((await call(owner.cookie, endpoint)).body).toEqual({ items: [] });
    await db!.query("UPDATE monthly_report_recipient SET attempted_at=NOW()-INTERVAL '65 minutes' WHERE organization_id=$1", [owner.orgId]);
    expect((await call(owner.cookie, "/monthly-reconciliation/review", "POST", review(owner.userId))).body).toEqual({ applied: true });
    expect((await call(owner.cookie, endpoint)).body).toEqual({ items: [] });
  });

  it("rejects no-Origin cookie requests and rate-limits repeated operator writes", async () => {
    const owner = await signup("operator-limited");
    await seedAttempt(owner.orgId, owner.userId);
    const raw = await app.fetch(new Request(`${origin}/api/monthly-reconciliation/review`, {
      method: "POST", headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify(review(owner.userId)),
    }), enabled as never);
    expect(raw.status).toBe(403);
    const attempts = await Promise.all(Array.from({ length: 15 }, () =>
      call(owner.cookie, "/monthly-reconciliation/review", "POST", review("not-the-recipient")),
    ));
    expect(attempts.some((r) => r.status === 429)).toBe(true);
    expect(attempts.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(3);
    expect((await call(owner.cookie, `/monthly-reconciliation/summary?month=${month}`)).body).toEqual({ pending: 1, unresolved: 0, confirmed: 0 });
  });

  it("cannot review another tenant using a caller-supplied recipient ID, and respects recent-attempt guard", async () => {
    const first = await signup("operator-first");
    const other = await signup("operator-other");
    await seedAttempt(first.orgId, first.userId, "attempted", 5);
    await seedAttempt(other.orgId, other.userId);
    const cross = await call(first.cookie, "/monthly-reconciliation/review", "POST", review(other.userId));
    expect(cross.status).toBe(200);
    expect(cross.body).toEqual({ applied: false });
    expect((await call(first.cookie, "/monthly-reconciliation/review", "POST", review(first.userId))).body).toEqual({ applied: false });
    expect((await call(first.cookie, `/monthly-reconciliation/summary?month=${month}`)).body).toEqual({ pending: 0, unresolved: 0, confirmed: 0 });
    expect((await call(other.cookie, `/monthly-reconciliation/summary?month=${month}`)).body).toEqual({ pending: 1, unresolved: 0, confirmed: 0 });
    expect((await db!.query<{ state: string }>("SELECT state FROM monthly_report_recipient WHERE organization_id=$1", [other.orgId]))[0].state).toBe("uncertain");
  });
});
