import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { calendarMonthUtc, createMontralEntitlements } from "./montral-metering";
import type { Bindings } from "./env";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:8787";
const config: Bindings = {
  DATABASE_URL: url, BETTER_AUTH_SECRET: "montral-billing-private-test-only-not-live",
  BETTER_AUTH_URL: ORIGIN, WEB_ORIGIN: ORIGIN,
  MONTRAL_BILLING_ENABLED: "true", MONTRAL_BILLING_MODE: "test",
  LEMONSQUEEZY_API_KEY: "fake-test-only", LEMONSQUEEZY_WEBHOOK_SECRET: "test-signature-secret-only",
  LEMONSQUEEZY_STORE_ID: "42", LEMONSQUEEZY_VARIANT_PRO: "101", LEMONSQUEEZY_VARIANT_BUSINESS: "102",
};
const app = createApp(openDatabase, { edition: montralEdition });
const db = url ? openDatabase(url, { max: 4 }) : null;
async function signed(raw: string, secret = config.LEMONSQUEEZY_WEBHOOK_SECRET!) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
async function fire(payload: unknown, overrides: Bindings = config, secret = config.LEMONSQUEEZY_WEBHOOK_SECRET!) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return app.fetch(new Request(ORIGIN + "/api/billing/lemon", {
    method: "POST", headers: { "content-type": "application/json", "x-signature": await signed(raw, secret) }, body: raw,
  }), overrides as never);
}
async function signup() {
  const response = await app.fetch(new Request(ORIGIN + "/api/auth/sign-up/email", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sandbox merchant test",
      email: `sandbox-${crypto.randomUUID()}@example.com`, password: "correct horse battery staple" }),
  }), config as never);
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map(x => x.split(";")[0]).join("; ");
  const me = await app.fetch(new Request(ORIGIN + "/api/me", { headers: { cookie } }), config as never);
  expect(me.status).toBe(200);
  const user = await me.json() as { organization: { id: string }; userId: string };
  return { cookie, org: user.organization.id, userId: user.userId };
}
const event = (id: string, intent: string | null, eventName: string, status: string, updated: string, variant = 101) => ({
  meta: { event_name: eventName, custom_data: { montral_intent: intent } },
  data: { type: "subscriptions", id, attributes: {
    store_id: 42, variant_id: variant, status, test_mode: true, updated_at: updated,
  } },
});

describe.skipIf(!url)("Montral sandbox billing PostgreSQL verification", () => {
  beforeAll(async () => {
    await db!.migrate();
    await montralEdition.migrate!(db!);
  });
  afterAll(async () => { await db?.close(1); });

  it("measures calendar months in UTC including leap years", () => {
    const period = calendarMonthUtc(new Date("2024-02-29T23:59:59Z"));
    expect(period.start.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("enforces monthly credits and email budgets with concurrent PostgreSQL spending", async () => {
    const { org } = await signup();
    const limits = createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true" });
    expect(await limits.plan(org)).toMatchObject({ id: "free", maxActiveMonitors: 1, minIntervalSec: 600, maxRegions: 1 });
    const parallel = await Promise.all(Array.from({ length: 12 }, () => limits.spendCredits(org, 500)));
    expect(parallel.every(n => n === 0 || n === 500)).toBe(true);
    expect(parallel.reduce((total, n) => total + n, 0)).toBe(4500);
    expect(await limits.creditBalance(org)).toMatchObject({ limit: 4500, used: 4500 });
    expect(await limits.spendCredits(org, 100)).toBe(0);
    const emails = await Promise.all(Array.from({ length: 6 }, () => limits.spendEmails(org, 5)));
    expect(emails.reduce((total, n) => total + n, 0)).toBe(20);
    expect(await limits.emailBalance(org)).toMatchObject({ limit: 20, used: 20 });
    const provider = String(Math.floor(Math.random() * 5000000 + 9000000));
    await db!.query(
      "INSERT INTO montral_subscription(organization_id,provider_id,variant_id,plan,status,test_mode,provider_updated_at) VALUES($1,$2,'101','pro','active',true,NOW())",
      [org, provider],
    );
    expect(await limits.plan(org)).toMatchObject({ id: "pro", maxActiveMonitors: 5, minIntervalSec: 300, maxRegions: 2 });
    expect(await limits.spendCredits(org, 50000)).toBe(45500);
    expect(await limits.creditBalance(org)).toMatchObject({ limit: 50000, used: 50000 });
    await db!.query("UPDATE montral_subscription SET status='expired' WHERE provider_id=$1", [provider]);
    expect(await limits.plan(org)).toMatchObject({ id: "free", maxActiveMonitors: 1 });
    expect(await limits.spendCredits(org, 1)).toBe(0);
    const preview = createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "false" });
    expect(await preview.plan(org)).toBeNull();
    expect(await preview.spendCredits(org, 80000)).toBe(80000);
  });

  it("fails closed until explicitly configured", async () => {
    const r = await fire("{}", { ...config, MONTRAL_BILLING_ENABLED: "false" });
    expect(r.status).toBe(404);
    const badSignature = await fire({}, config, "attacker-secret");
    expect(badSignature.status).toBe(401);
    const badJson = await fire("{not json");
    expect(badJson.status).toBe(400);
  });

  it("does not trust signed merchant data unless it matches a server-created unexpired checkout intent", async () => {
    const sub = String(Math.floor(Math.random() * 9000000 + 1000000));
    const attempt = await fire(event(sub, crypto.randomUUID(), "subscription_created", "active", "2026-10-30T19:00:00.000Z"));
    expect(attempt.status).toBe(409);
    const rows = await db!.query<{ provider_id: string }>("SELECT provider_id FROM montral_subscription WHERE provider_id=$1", [sub]);
    expect(rows).toEqual([]);
  });

  it("applies verified creation once, handles updates in order and rejects stale/replayed changes", async () => {
    const { cookie, org, userId } = await signup();
    const id = crypto.randomUUID();
    const sub = String(Math.floor(Math.random() * 9000000 + 1000000));
    await db!.query(
      "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
      [id, org, userId],
    );
    const created = event(sub, id, "subscription_created", "active", "2026-10-30T19:00:00.000Z");
    expect((await fire(created)).status).toBe(200);
    const dupe = await fire(created);
    expect(dupe.status).toBe(200);
    expect(await dupe.json()).toMatchObject({ result: "duplicate" });
    const billing = await app.fetch(new Request(ORIGIN + "/api/billing", { headers: { cookie } }), config as never);
    expect(billing.status).toBe(200);
    expect(await billing.json()).toMatchObject({ plan: "pro", status: "active", billingConfigured: true });
    expect((await fire(event(sub, id, "subscription_cancelled", "cancelled", "2026-10-30T20:00:00.000Z"))).status).toBe(200);
    expect((await fire(event(sub, id, "subscription_updated", "active", "2026-10-30T19:30:00.000Z"))).status).toBe(200);
    const afterStale = await db!.query<{ status: string }>("SELECT status FROM montral_subscription WHERE provider_id=$1", [sub]);
    expect(afterStale[0]?.status).toBe("cancelled");
    expect((await fire(event(sub, id, "subscription_expired", "expired", "2026-10-30T21:00:00.000Z"))).status).toBe(200);
    const after = await db!.query<{ plan: string; status: string }>("SELECT plan,status FROM montral_subscription WHERE provider_id=$1", [sub]);
    expect(after[0]).toMatchObject({ plan: "pro", status: "expired" });
    const wrong = await fire(event(sub, id, "subscription_updated", "active", "2026-10-30T22:00:00.000Z", 102));
    expect(wrong.status).toBe(409);
    const intentReuse = await fire(event(String(Number(sub)+1), id, "subscription_created", "active", "2026-10-30T23:00:00.000Z", 102));
    expect(intentReuse.status).toBe(409);
    const disabled = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"plan":"pro"}',
    }), { ...config, MONTRAL_BILLING_ENABLED: "false" } as never);
    expect(disabled.status).toBe(503);
  });
});
