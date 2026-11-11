import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { calendarMonthUtc, createMontralEntitlements } from "./montral-metering";
import { runMontralMaintenance } from "./montral-maintenance";
import { reconcileSubscription } from "./montral-billing";
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
const event = (id: string, intent: string | null, eventName: string, status: string, updated: string, variant = 101, endsAt: string | null = null) => ({
  meta: { event_name: eventName, custom_data: { montral_intent: intent } },
  data: { type: "subscriptions", id, attributes: {
    store_id: 42, variant_id: variant, status, test_mode: true, updated_at: updated, ends_at: endsAt,
  } },
});

// One pool for both suites below: closed once, after the last test of the file.
afterAll(async () => { await db?.close(1); });

describe.skipIf(!url)("Montral sandbox billing PostgreSQL verification", () => {
  beforeAll(async () => {
    await migrateMontralSchema(db!, montralEdition);
  });

  it("refuses a stalled signed sandbox callback with 408 and zero event writes", async () => {
    const provider = String(Math.floor(Math.random() * 9000000 + 11000000));
    const raw = JSON.stringify(event(provider, "00000000-0000-4000-8000-000000000000",
      "subscription_created", "active", "2026-11-01T10:00:00Z"));
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(raw)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const response = await app.fetch(new Request(ORIGIN + "/api/billing/lemon", {
      method: "POST", headers: {
        "content-type": "application/json", "x-signature": await signed(raw),
        "x-event-name": "subscription_created",
      }, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" }), config as never);
    expect(response.status).toBe(408);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ error: "Billing callback body read timeout" });
    expect(canceled).toBe(true);
    const changes = await db!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM montral_billing_event WHERE provider_id=$1", [provider]);
    expect(changes).toEqual([{ count: "0" }]);
  }, 15_000);

  it("measures calendar months in UTC including leap years", () => {
    const period = calendarMonthUtc(new Date("2024-02-29T23:59:59Z"));
    expect(period.start.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("meters with the operator's plan catalog: its limits apply at once, overrides win, an invalid catalog fails closed", async () => {
    const { org } = await signup();
    // synthetic catalog: these numbers describe no real offer
    const catalog = (credits: number, overrides: unknown[] = []) => JSON.stringify({
      schemaVersion: 1, version: "synthetic-e2e", defaultPlan: "basic",
      plans: [{ id: "basic", name: "Basic", limits: { activeMonitors: 2, minIntervalSec: 180, regions: 1, credits, emails: 3 } },
        { id: "pro", name: "Wide", limits: { activeMonitors: 9, minIntervalSec: 60, regions: 4, credits: 870, emails: 30 }, features: ["hideBranding"] },
        { id: "business", name: "Widest", limits: { activeMonitors: 11, minIntervalSec: 60, regions: 4, credits: 880, emails: 30 } }],
      overrides,
    });
    const metered = (json: string) => createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true", MONTRAL_PLAN_CONFIG_JSON: json });
    const a = metered(catalog(13));
    expect(await a.plan(org)).toMatchObject({ id: "basic", name: "Basic", maxActiveMonitors: 2, minIntervalSec: 180, maxRegions: 1, hideBranding: false });
    expect(await a.spendCredits(org, 10)).toBe(10);
    expect(await a.spendCredits(org, 10)).toBe(3);
    expect(await a.creditBalance(org)).toMatchObject({ limit: 13, used: 13 });
    // the operator lowers the allowance mid-period: nothing more is granted, and the balance shows the new limit
    const lowered = metered(catalog(5));
    expect(await lowered.spendCredits(org, 1)).toBe(0);
    expect(await lowered.creditBalance(org)).toMatchObject({ limit: 5, used: 13 });
    // a per-workspace override (an enterprise contract) changes the plan and one limit
    const contract = metered(catalog(13, [{ organizationId: org, plan: "pro", limits: { credits: 20 }, note: "synthetic contract" }]));
    expect(await contract.plan(org)).toMatchObject({ id: "pro", maxActiveMonitors: 9, maxRegions: 4, hideBranding: true });
    expect(await contract.spendCredits(org, 10)).toBe(7);
    // billing is enabled here, so a catalog without the plan ids billing stores is refused, not silently defaulted
    const unbillable = metered(JSON.stringify({ schemaVersion: 1, version: "x", defaultPlan: "basic", plans: [{ id: "basic", name: "B", limits: { activeMonitors: 1, minIntervalSec: 600, regions: 1, credits: 1, emails: 1 } }] }));
    await expect(unbillable.spendCredits(org, 1)).rejects.toThrow(/must define the plan ids pro, business/);
    // an invalid catalog never meters with a guess: every metered call fails
    const broken = metered(JSON.stringify({ schemaVersion: 1, version: "x", defaultPlan: "missing", plans: [] }));
    await expect(broken.spendCredits(org, 1)).rejects.toThrow(/Invalid plan catalog/);
    await expect(broken.plan(org)).rejects.toThrow(/Invalid plan catalog/);
    expect(await contract.creditBalance(org)).toMatchObject({ used: 20 });
  });

  it("refunds credits to the month they were spent in, never to the new month", async () => {
    const { org } = await signup();
    const limits = createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true" });
    const current = calendarMonthUtc();
    const previous = calendarMonthUtc(new Date(current.start.getTime() - 1));
    await db!.query("INSERT INTO montral_usage(organization_id,period_start,kind,used) VALUES($1,$2::timestamptz,'credits',40)", [org, previous.start.toISOString()]);
    expect(await limits.spendCredits(org, 30)).toBe(30);
    // a check charged just before midnight on the last day of the month whose refund lands after the boundary
    await limits.refundCredits!(org, 10, new Date(current.start.getTime() - 1_000));
    const used = async (start: Date) => Number((await db!.query<{ used: number }>(
      "SELECT used FROM montral_usage WHERE organization_id=$1 AND period_start=$2::timestamptz AND kind='credits'", [org, start.toISOString()]))[0]?.used);
    expect(await used(previous.start)).toBe(30);
    expect(await used(current.start)).toBe(30);
    // without a time, a refund goes to the current month (as before)
    await limits.refundCredits!(org, 5);
    expect(await used(current.start)).toBe(25);
    // an invalid time falls back to the current month rather than throwing
    await limits.refundCredits!(org, 5, new Date(Number.NaN));
    expect(await used(current.start)).toBe(20);
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
    // a browser check that did not happen gives its credit back: it can be spent again, and a refund never goes below 0
    await limits.refundCredits!(org, 1);
    expect(await limits.creditBalance(org)).toMatchObject({ used: 4499 });
    expect(await limits.spendCredits(org, 5)).toBe(1);
    await limits.refundCredits!(org, 1_000_000);
    expect(await limits.creditBalance(org)).toMatchObject({ used: 0 });
    expect(await limits.spendCredits(org, 4500)).toBe(4500);
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

  it("does not grant cancelled subscriptions indefinitely, even if expiration webhook never arrives", async () => {
    const { org, userId } = await signup();
    const intent = crypto.randomUUID();
    const provider = String(Math.floor(Math.random() * 5000000 + 11000000));
    await db!.query(
      "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
      [intent, org, userId],
    );
    const entitlements = createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true" });
    const first = event(provider, intent, "subscription_created", "active", new Date(Date.now() - 60_000).toISOString());
    expect((await fire(first)).status).toBe(200);
    expect(await entitlements.plan(org)).toMatchObject({ id: "pro" });
    const future = new Date(Date.now() + 3600_000).toISOString();
    const cancelled = event(provider, intent, "subscription_cancelled", "cancelled", new Date().toISOString(), 101, future);
    expect((await fire(cancelled)).status).toBe(200);
    expect(await entitlements.plan(org)).toMatchObject({ id: "pro" });
    const stored = await db!.query<{ ends_at: Date }>(
      "SELECT ends_at FROM montral_subscription WHERE provider_id=$1", [provider],
    );
    expect(new Date(stored[0]?.ends_at).toISOString()).toBe(future);
    // Simulate the expiration deadline with no additional webhook. Plan
    // computation itself must revoke paid access, without relying on cron.
    await db!.query("UPDATE montral_subscription SET ends_at=NOW()-INTERVAL '1 minute' WHERE provider_id=$1", [provider]);
    expect(await entitlements.plan(org)).toMatchObject({ id: "free", maxActiveMonitors: 1 });
    await db!.query("UPDATE montral_subscription SET ends_at=NULL WHERE provider_id=$1", [provider]);
    expect(await entitlements.plan(org)).toMatchObject({ id: "free" });
    await db!.query("UPDATE montral_subscription SET status='active',test_mode=false WHERE provider_id=$1", [provider]);
    expect(await entitlements.plan(org)).toMatchObject({ id: "free" });
    await db!.query("UPDATE montral_subscription SET test_mode=true WHERE provider_id=$1", [provider]);
    expect(await createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" }).plan(org))
      .toMatchObject({ id: "free" });
  });

  it("refuses an oversized manager checkout body before minting a nonce or calling any provider", async () => {
    const { cookie, org } = await signup();
    const fetchBefore = globalThis.fetch;
    let called = 0;
    try {
      vi.stubGlobal("fetch", async () => { called++; throw new Error("unreachable provider"); });
      const response = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json", "content-length": "5" },
        body: JSON.stringify({ plan: "pro", padding: "x".repeat(8 * 1024) }),
      }), config as never);
      expect(response.status).toBe(413);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.json()).toEqual({ error: "Payload too large" });
      expect(called).toBe(0);
      expect(await db!.query("SELECT id FROM montral_billing_intent WHERE organization_id=$1", [org])).toHaveLength(0);
    } finally {
      vi.stubGlobal("fetch", fetchBefore);
      vi.unstubAllGlobals();
    }
  });

  it("returns 408 on a never-ending manager checkout body, with no nonce or provider call", async () => {
    const { cookie, org } = await signup();
    const fetchBefore = globalThis.fetch;
    let canceled = false;
    let calls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"plan":"pro"')); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    try {
      vi.stubGlobal("fetch", async () => { calls++; throw new Error("must not reach provider"); });
      const response = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: stream, duplex: "half",
      } as RequestInit & { duplex: "half" }), config as never);
      expect(response.status).toBe(408);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.json()).toEqual({ error: "Checkout body read timeout" });
      expect(canceled).toBe(true);
      expect(calls).toBe(0);
      expect(await db!.query("SELECT id FROM montral_billing_intent WHERE organization_id=$1", [org])).toHaveLength(0);
    } finally {
      vi.stubGlobal("fetch", fetchBefore);
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it("allows only one pending checkout across concurrent requests and database connections", async () => {
    const { cookie, org } = await signup();
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    try {
      vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
        expect(url).toBe("https://api.lemonsqueezy.com/v1/checkouts");
        expect(options.redirect).toBe("error");
        const payload = JSON.parse(String(options.body));
        const id = payload.data.attributes.checkout_data.custom.montral_intent as string;
        expect((await db!.query(
          "SELECT id FROM montral_billing_intent WHERE id=$1 AND organization_id=$2", [id, org],
        ))).toHaveLength(1);
        providerCalls++;
        // Concurrent checkout requests are still running when the first
        // provider response returns. The DB lock must prevent duplicates.
        await new Promise(resolve => setTimeout(resolve, 50));
        return new Response(JSON.stringify({ data: {
          attributes: { test_mode: true, url: "https://test.lemonsqueezy.com/checkout/custom/synthetic" },
        } }), { status: 201, headers: { "content-type": "application/json" } });
      });
      const responses = await Promise.all(Array.from({ length: 8 }, () =>
        app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
          method: "POST", headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ plan: "pro" }),
        }), config as never),
      ));
      // Report every status on failure: a flaky run once returned one non-409 that was never identified.
      const statuses = responses.map(x => x.status).sort();
      expect(statuses, "checkout statuses").toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
      expect(providerCalls).toBe(1);
      expect(await db!.query(
        "SELECT id FROM montral_billing_intent WHERE organization_id=$1 AND consumed_at IS NULL AND expires_at>NOW()", [org],
      )).toHaveLength(1);
      const subsequent = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ plan: "business" }),
      }), config as never);
      expect(subsequent.status).toBe(409);
      expect(providerCalls).toBe(1);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it("permits another checkout after expiry and blocks one after a verified active subscription", async () => {
    const { cookie, org, userId } = await signup();
    const fetchBefore = globalThis.fetch;
    let calls = 0;
    try {
      vi.stubGlobal("fetch", async () => {
        calls++;
        return new Response(JSON.stringify({ data: {
          attributes: { test_mode: true, url: "https://test.lemonsqueezy.com/checkout/custom/synthetic" },
        } }), { status: 201 });
      });
      // First pending checkout is expired, so replacement is allowed.
      await db!.query(
        "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()-INTERVAL '1 minute')",
        [crypto.randomUUID(), org, userId],
      );
      const checkout = () => app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }), config as never);
      expect((await checkout()).status).toBe(201);
      expect(calls).toBe(1);
      // Even if an obsolete pending checkout disappears, an active
      // subscription prevents a second purchase.
      await db!.query("UPDATE montral_billing_intent SET expires_at=NOW()-INTERVAL '1 minute' WHERE organization_id=$1", [org]);
      await db!.query(
        "INSERT INTO montral_subscription(organization_id,provider_id,variant_id,plan,status,test_mode,provider_updated_at) VALUES($1,$2,'101','pro','active',true,NOW())",
        [org, String(Math.floor(Math.random()*1000000 + 20000000))],
      );
      expect((await checkout()).status).toBe(409);
      expect(calls).toBe(1);
    } finally {
      vi.stubGlobal("fetch", fetchBefore);
      vi.unstubAllGlobals();
    }
  });

  it("does not allow a legacy second checkout intent to replace an existing active provider", async () => {
    const { org, userId } = await signup();
    const firstIntent = crypto.randomUUID();
    const secondIntent = crypto.randomUUID();
    const originalProvider = String(Math.floor(Math.random() * 10000000 + 20000000));
    const otherProvider = String(Number(originalProvider) + 1);
    for (const id of [firstIntent, secondIntent]) {
      await db!.query(
        "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
        [id, org, userId],
      );
    }
    const start = new Date(Date.now()-10_000).toISOString();
    const later = new Date().toISOString();
    expect((await fire(event(originalProvider, firstIntent, "subscription_created", "active", start))).status).toBe(200);
    const replacement = await fire(event(otherProvider, secondIntent, "subscription_created", "active", later));
    expect(replacement.status).toBe(409);
    const existing = await db!.query<{ provider_id: string }>(
      "SELECT provider_id FROM montral_subscription WHERE organization_id=$1", [org],
    );
    expect(existing).toMatchObject([{ provider_id: originalProvider }]);
    expect(await db!.query(
      "SELECT id FROM montral_billing_intent WHERE id=$1 AND consumed_at IS NULL", [secondIntent],
    )).toHaveLength(1);
    // Later events can no longer mutate or masquerade as the abandoned provider.
    expect((await fire(event(otherProvider, null, "subscription_updated", "active", new Date(Date.now()+10_000).toISOString()))).status).toBe(409);
  });

  it("persists the checkout nonce before provider calls and discards failed attempts", async () => {
    const { cookie, org } = await signup();
    const intentsBefore = await db!.query("SELECT id FROM montral_billing_intent WHERE organization_id=$1", [org]);
    expect(intentsBefore).toHaveLength(0);
    const originalFetch = globalThis.fetch;
    let providerCalled = 0;
    try {
      vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
        expect(url).toBe("https://api.lemonsqueezy.com/v1/checkouts");
        const body = JSON.parse(String(options.body));
        const id = body.data.attributes.checkout_data.custom.montral_intent as string;
        expect((await db!.query("SELECT id FROM montral_billing_intent WHERE id=$1 AND organization_id=$2", [id, org]))).toHaveLength(1);
        providerCalled++;
        return new Response("provider unavailable", { status: 503 });
      });
      const resp = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      }), config as never);
      expect(resp.status).toBe(502);
      expect(providerCalled).toBe(1);
      expect(await db!.query("SELECT id FROM montral_billing_intent WHERE organization_id=$1", [org])).toHaveLength(0);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      vi.unstubAllGlobals();
    }
  });

  it("prunes expired sandbox checkout nonces without deleting recent intents or financial event digests", async () => {
    const { org, userId } = await signup();
    const old = crypto.randomUUID();
    const recent = crypto.randomUUID();
    const active = crypto.randomUUID();
    const oldConsumed = crypto.randomUUID();
    for (const [id, expiration, consumed] of [
      [old, "NOW()-INTERVAL '9 days'", "NULL"],
      [recent, "NOW()-INTERVAL '1 day'", "NULL"],
      [active, "NOW()+INTERVAL '30 minutes'", "NULL"],
      [oldConsumed, "NOW()-INTERVAL '8 days'", "NOW()-INTERVAL '9 days'"],
    ]) {
      await db!.query(
        `INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at,consumed_at)
         VALUES($1,$2,$3,'pro','101',${expiration},${consumed})`,
        [id, org, userId],
      );
    }
    const countBefore = await db!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM montral_billing_event",
    );
    const result = await runMontralMaintenance(db!);
    expect(result.expiredIntents).toBeGreaterThanOrEqual(2);
    const remain = await db!.query<{ id: string }>(
      "SELECT id FROM montral_billing_intent WHERE organization_id=$1", [org],
    );
    expect(remain.map(v => v.id).sort()).toEqual([recent, active].sort());
    const countAfter = await db!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM montral_billing_event",
    );
    expect(countAfter).toEqual(countBefore);
    expect((await runMontralMaintenance(db!)).expiredIntents).toBe(0);
  });

  it("fails closed until explicitly configured", async () => {
    const r = await fire("{}", { ...config, MONTRAL_BILLING_ENABLED: "false" });
    expect(r.status).toBe(404);
    const badSignature = await fire({}, config, "attacker-secret");
    expect(badSignature.status).toBe(401);
    const badJson = await fire("{not json");
    expect(badJson.status).toBe(400);
  });

  it("verifies signed webhook bytes exactly and rejects malformed UTF-8 with valid raw signature", async () => {
    const payload = {
      ...event("12345678901234567890", null, "subscription_updated", "active", "2026-10-30T19:00:00.000Z"),
      ignored_metadata: "non-ASCII replacement � inside signed JSON",
    };
    const originalBytes = new TextEncoder().encode(JSON.stringify(payload));
    const rawSignature = async (bytes: Uint8Array<ArrayBuffer>) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.LEMONSQUEEZY_WEBHOOK_SECRET!), {
        name: "HMAC", hash: "SHA-256",
      }, false, ["sign"]);
      return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)),
        b => b.toString(16).padStart(2, "0")).join("");
    };
    const signedRequest = async (bytes: Uint8Array<ArrayBuffer>, signature: string) =>
      app.fetch(new Request(ORIGIN + "/api/billing/lemon", {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": signature },
        body: new Blob([bytes]),
      }), config as never);

    const valid = await signedRequest(originalBytes, await rawSignature(originalBytes));
    expect(valid.status).toBe(409); // Valid signature and JSON, but unknown subscription identity.

    const replacementPosition = originalBytes.findIndex((b, i) =>
      b === 0xef && originalBytes[i + 1] === 0xbf && originalBytes[i + 2] === 0xbd);
    expect(replacementPosition).toBeGreaterThan(0);
    const altered = originalBytes.slice();
    altered[replacementPosition] = 0xff; // Invalid UTF-8 in otherwise valid, signed JSON.

    // An attacker cannot reuse a legitimate signature for different bytes.
    const forged = await signedRequest(altered, await rawSignature(originalBytes));
    expect(forged.status).toBe(401);
    // Even the real raw-byte HMAC must not make invalid UTF-8 processable.
    const signedMalformed = await signedRequest(altered, await rawSignature(altered));
    expect(signedMalformed.status).toBe(400);
    expect(await signedMalformed.json()).toMatchObject({ error: "Invalid UTF-8 or JSON" });
    const unknownEvents = await db!.query(
      "SELECT digest FROM montral_billing_event WHERE provider_id=$1", ["12345678901234567890"],
    );
    expect(unknownEvents).toHaveLength(0);
  });

  it("does not trust signed merchant data unless it matches a server-created unexpired checkout intent", async () => {
    const sub = String(Math.floor(Math.random() * 9000000 + 1000000));
    const attempt = await fire(event(sub, crypto.randomUUID(), "subscription_created", "active", "2026-10-30T19:00:00.000Z"));
    expect(attempt.status).toBe(409);
    const rows = await db!.query<{ provider_id: string }>("SELECT provider_id FROM montral_subscription WHERE provider_id=$1", [sub]);
    expect(rows).toEqual([]);
  });

  it("never restores a paid state from a contradictory signed event sharing the provider timestamp", async () => {
    const { org, userId } = await signup();
    const intent = crypto.randomUUID();
    const provider = String(Math.floor(Math.random() * 5000000 + 21000000));
    await db!.query(
      "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
      [intent, org, userId],
    );
    const equalTime = "2026-10-30T22:00:00.000Z";
    const deadline = "2026-11-30T22:00:00.000Z";
    const entitlements = createMontralEntitlements(db!, { ...config, MONTRAL_METERING_ENABLED: "true" });
    expect((await fire(event(provider, intent, "subscription_created", "active", equalTime))).status).toBe(200);
    expect(await entitlements.plan(org)).toMatchObject({ id: "pro" });

    // Separate legitimately signed events from the provider can share its
    // timestamp; exact-payload digest deduplication is insufficient.
    const cancel = await fire(event(provider, intent, "subscription_cancelled", "cancelled", equalTime, 101, deadline));
    expect(cancel.status).toBe(200);
    expect((await db!.query<{ status: string }>(
      "SELECT status FROM montral_subscription WHERE provider_id=$1", [provider],
    ))[0]?.status).toBe("cancelled");

    const replayedActive = await fire(event(provider, intent, "subscription_updated", "active", equalTime));
    expect(replayedActive.status).toBe(200);
    expect(await replayedActive.json()).toMatchObject({ result: "stale" });
    const afterEqualReplay = (await db!.query<{ status: string; ends_at: string | Date | null }>(
      "SELECT status,ends_at FROM montral_subscription WHERE provider_id=$1", [provider],
    ))[0];
    expect(afterEqualReplay.status).toBe("cancelled");
    expect(new Date(afterEqualReplay.ends_at!).toISOString()).toBe(deadline);

    const shortened = "2026-11-15T22:00:00.000Z";
    const shortenResult = await fire(event(provider, intent, "subscription_updated", "cancelled", equalTime, 101, shortened));
    expect(shortenResult.status).toBe(200);
    const afterShortenedDeadline = (await db!.query<{ ends_at: string | Date | null }>(
      "SELECT ends_at FROM montral_subscription WHERE provider_id=$1", [provider],
    ))[0]?.ends_at;
    expect(new Date(afterShortenedDeadline!).toISOString()).toBe(shortened);

    const expire = await fire(event(provider, intent, "subscription_expired", "expired", equalTime));
    expect(expire.status).toBe(200);
    expect((await db!.query<{ status: string }>(
      "SELECT status FROM montral_subscription WHERE provider_id=$1", [provider],
    ))[0]?.status).toBe("expired");
    expect(await entitlements.plan(org)).toMatchObject({ id: "free" });

    // A second previously-created checkout intent with the same provider must
    // not reset an expired subscription on the exact same clock timestamp.
    const freshIntent = crypto.randomUUID();
    await db!.query(
      "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
      [freshIntent, org, userId],
    );
    const reset = await fire(event(provider, freshIntent, "subscription_created", "active", equalTime));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ result: "stale" });
    expect((await db!.query<{ status: string }>(
      "SELECT status FROM montral_subscription WHERE provider_id=$1", [provider],
    ))[0]?.status).toBe("expired");
    expect(await entitlements.plan(org)).toMatchObject({ id: "free" });

    // A genuinely new subscription provider has its OWN clock stream. Once
    // the old provider expired, its timestamps must not block a fresh checkout.
    const replacementIntent = crypto.randomUUID();
    const replacementProvider = String(Number(provider) + 1);
    await db!.query(
      "INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'pro','101',NOW()+INTERVAL '30 minutes')",
      [replacementIntent, org, userId],
    );
    const replaced = await fire(event(replacementProvider, replacementIntent,
      "subscription_created", "active", "2026-10-30T21:00:00.000Z"));
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({ result: "applied" });
    expect((await db!.query<{ provider_id: string; status: string }>(
      "SELECT provider_id,status FROM montral_subscription WHERE organization_id=$1", [org],
    ))[0]).toMatchObject({ provider_id: replacementProvider, status: "active" });
    expect(await entitlements.plan(org)).toMatchObject({ id: "pro" });
    // The superseded provider cannot mutate the newly linked subscription.
    expect((await fire(event(provider, intent, "subscription_updated", "active", "2026-10-31T00:00:00.000Z"))).status).toBe(409);
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
    // Expiry is terminal: a later update (here naming the other catalog plan's variant) cannot revive it.
    const revive = await fire(event(sub, id, "subscription_updated", "active", "2026-10-30T22:00:00.000Z", 102));
    expect(revive.status).toBe(200);
    expect(await revive.json()).toMatchObject({ result: "stale" });
    expect((await db!.query<{ plan: string; status: string }>("SELECT plan,status FROM montral_subscription WHERE provider_id=$1", [sub]))[0])
      .toMatchObject({ plan: "pro", status: "expired" });
    // A variant no plan maps to is unmatched.
    const wrong = await fire(event(sub, id, "subscription_updated", "active", "2026-10-30T22:30:00.000Z", 999));
    expect(wrong.status).toBe(409);
    const intentReuse = await fire(event(String(Number(sub)+1), id, "subscription_created", "active", "2026-10-30T23:00:00.000Z", 102));
    expect(intentReuse.status).toBe(409);
    const disabled = await app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"plan":"pro"}',
    }), { ...config, MONTRAL_BILLING_ENABLED: "false" } as never);
    expect(disabled.status).toBe(503);
  });
});

/**
 * Catalog-driven billing lifecycle. Synthetic catalog: the plans "lite" (default, never sold), "team" (variants
 * 301/302) and "scale" (303); the variant ids, limits and the price metadata describe no real offer.
 */
const lifecycleCatalog = JSON.stringify({
  schemaVersion: 1, version: "synthetic-lifecycle-e2e", defaultPlan: "lite",
  plans: [
    { id: "lite", name: "Lite", limits: { activeMonitors: 1, minIntervalSec: 600, regions: 1, credits: 11, emails: 1 } },
    { id: "team", name: "Team", limits: { activeMonitors: 3, minIntervalSec: 300, regions: 1, credits: 33, emails: 3 }, providerVariants: ["301", "302"],
      price: { amountMinor: 999, currency: "EUR", interval: "month" } },
    { id: "scale", name: "Scale", limits: { activeMonitors: 7, minIntervalSec: 60, regions: 2, credits: 77, emails: 7 }, providerVariants: ["303"] },
  ],
});
// the env variants are deliberately absent: the catalog alone maps variants to plans
const lifecycle: Bindings = { ...config, LEMONSQUEEZY_VARIANT_PRO: undefined, LEMONSQUEEZY_VARIANT_BUSINESS: undefined, MONTRAL_PLAN_CONFIG_JSON: lifecycleCatalog };
const lifecycleEntitlements = (over: Partial<Bindings> = {}) =>
  createMontralEntitlements(db!, { ...lifecycle, MONTRAL_METERING_ENABLED: "true", ...over });
const invoiceEvent = (subscription: string, eventName: string, status: string, updated: string, invoiceId = String(Math.floor(Math.random() * 9e8 + 1e8))) => ({
  meta: { event_name: eventName },
  data: { type: "subscription-invoices", id: invoiceId, attributes: {
    store_id: 42, subscription_id: Number(subscription), status, test_mode: true, updated_at: updated,
  } },
});
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
async function billingAudit(org: string) {
  return db!.query<{ action: string; actor_type: string; actor_label: string; changes: { fields: string[]; values: Record<string, unknown> } }>(
    "SELECT action,actor_type,actor_label,changes FROM audit_event WHERE organization_id=$1 AND action LIKE 'billing.%'", [org]);
}
const countActions = (rows: { action: string }[]) => rows.reduce<Record<string, number>>((n, r) => ({ ...n, [r.action]: (n[r.action] ?? 0) + 1 }), {});

describe.skipIf(!url)("Montral catalog-driven billing lifecycle on PostgreSQL", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });

  it("replaces the fixed plan CHECK with a plan-id format check on both billing tables", async () => {
    const constraints = await db!.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid IN (to_regclass('montral_billing_intent'), to_regclass('montral_subscription'))
         AND conname IN ('montral_billing_intent_plan_check','montral_billing_intent_plan_format','montral_subscription_plan_format')`);
    expect(constraints.map((c) => c.conname).sort()).toEqual(["montral_billing_intent_plan_format", "montral_subscription_plan_format"]);
    const { org, userId } = await signup();
    await db!.query("INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'team','301',NOW()-INTERVAL '1 hour')", [crypto.randomUUID(), org, userId]);
    await expect(db!.query("INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'Team!','301',NOW())", [crypto.randomUUID(), org, userId]))
      .rejects.toThrow();
  });

  it("lists catalog plans without prices until the owner publishes them, and checks out a catalog plan id", async () => {
    const { cookie, org } = await signup();
    const plans = async (env: Bindings) => {
      const r = await app.fetch(new Request(ORIGIN + "/api/billing/plans", { headers: { cookie } }), env as never);
      expect(r.status).toBe(200);
      return r.json() as Promise<{ defaultPlan: string; plans: Record<string, unknown>[] }>;
    };
    expect(await plans(lifecycle)).toEqual({ defaultPlan: "lite", plans: [
      { id: "lite", name: "Lite", checkoutAvailable: false },
      { id: "team", name: "Team", checkoutAvailable: true },
      { id: "scale", name: "Scale", checkoutAvailable: true },
    ] });
    expect(JSON.stringify(await plans(lifecycle))).not.toMatch(/price|999|EUR/);
    const published = await plans({ ...lifecycle, MONTRAL_BILLING_SHOW_PRICES: "true" });
    expect(published.plans[1]).toEqual({ id: "team", name: "Team", checkoutAvailable: true, price: { amountMinor: 999, currency: "EUR", interval: "month" } });
    expect(published.plans[2]).not.toHaveProperty("price");
    // billing off: the plans are listed, none can be bought
    expect((await plans({ ...lifecycle, MONTRAL_BILLING_ENABLED: "false" })).plans.every((p) => p.checkoutAvailable === false)).toBe(true);

    const fetchBefore = globalThis.fetch;
    const variants: number[] = [];
    try {
      vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
        variants.push(...JSON.parse(String(options.body)).data.attributes.product_options.enabled_variants);
        return new Response(JSON.stringify({ data: { attributes: { test_mode: true, url: "https://test.lemonsqueezy.com/checkout/custom/synthetic" } } }), { status: 201 });
      });
      const checkout = (plan: string) => app.fetch(new Request(ORIGIN + "/api/billing/checkout", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ plan }),
      }), lifecycle as never);
      // the default plan, plans the catalog does not have (including the old fixed ids) and malformed ids: 400
      for (const plan of ["lite", "pro", "business", "enterprise", "Team!"]) expect((await checkout(plan)).status, plan).toBe(400);
      expect(variants).toEqual([]);
      expect((await checkout("team")).status).toBe(201);
      expect(variants).toEqual([301]);
      expect(await db!.query("SELECT plan,variant_id FROM montral_billing_intent WHERE organization_id=$1", [org])).toEqual([{ plan: "team", variant_id: "301" }]);
    } finally {
      vi.stubGlobal("fetch", fetchBefore);
      vi.unstubAllGlobals();
    }
  });

  it("applies plan changes by variant in provider order, refuses unknown variants and replays, and audits each outcome", async () => {
    const { cookie, org, userId } = await signup();
    const intent = crypto.randomUUID();
    const provider = String(Math.floor(Math.random() * 5000000 + 31000000));
    await db!.query("INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'team','301',NOW()+INTERVAL '30 minutes')", [intent, org, userId]);
    const entitlements = lifecycleEntitlements();
    expect(await entitlements.plan(org)).toMatchObject({ id: "lite" });
    const created = event(provider, intent, "subscription_created", "active", "2026-11-01T10:00:00.000Z", 301);
    expect(await (await fire(created, lifecycle)).json()).toMatchObject({ result: "applied" });
    expect(await entitlements.plan(org)).toMatchObject({ id: "team", maxActiveMonitors: 3 });
    // upgrade: another catalog variant on a newer provider update
    const upgrade = await fire(event(provider, null, "subscription_updated", "active", "2026-11-02T10:00:00.000Z", 303), lifecycle);
    expect(await upgrade.json()).toMatchObject({ result: "applied" });
    expect((await db!.query("SELECT plan,variant_id FROM montral_subscription WHERE provider_id=$1", [provider]))[0]).toEqual({ plan: "scale", variant_id: "303" });
    expect(await entitlements.plan(org)).toMatchObject({ id: "scale", maxActiveMonitors: 7 });
    // a variant the catalog does not sell: 409, nothing changes, and the digest is not consumed
    const unknown = event(provider, null, "subscription_updated", "active", "2026-11-03T10:00:00.000Z", 399);
    expect((await fire(unknown, lifecycle)).status).toBe(409);
    expect(await entitlements.plan(org)).toMatchObject({ id: "scale" });
    expect((await db!.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM montral_billing_event WHERE provider_id=$1", [provider]))[0]!.n).toBe("2");
    // reorder: an older downgrade arriving after the upgrade is stale
    const late = await fire(event(provider, null, "subscription_updated", "active", "2026-11-01T12:00:00.000Z", 302), lifecycle);
    expect(await late.json()).toMatchObject({ result: "stale" });
    expect(await entitlements.plan(org)).toMatchObject({ id: "scale" });
    // an equal-timestamp event never changes the plan, even with a stricter status
    const tie = await fire(event(provider, null, "subscription_updated", "past_due", "2026-11-02T10:00:00.000Z", 301), lifecycle);
    expect(await tie.json()).toMatchObject({ result: "applied" });
    expect((await db!.query("SELECT plan,status FROM montral_subscription WHERE provider_id=$1", [provider]))[0]).toEqual({ plan: "scale", status: "past_due" });
    // downgrade on a newer update
    expect(await (await fire(event(provider, null, "subscription_updated", "active", "2026-11-04T10:00:00.000Z", 302), lifecycle)).json()).toMatchObject({ result: "applied" });
    expect(await entitlements.plan(org)).toMatchObject({ id: "team" });
    // replay: the exact same signed bytes again
    expect(await (await fire(created, lifecycle)).json()).toMatchObject({ result: "duplicate" });
    const status = await app.fetch(new Request(ORIGIN + "/api/billing", { headers: { cookie } }), lifecycle as never);
    expect(await status.json()).toMatchObject({ plan: "team", status: "active", entitledPlan: "team", billingConfigured: true, graceEndsAt: null });

    const audit = await billingAudit(org);
    expect(countActions(audit)).toEqual({ "billing.event_applied": 4, "billing.event_unmatched": 1, "billing.event_ignored": 2 });
    expect(audit.every((r) => r.actor_type === "system" && r.actor_label === "Billing provider")).toBe(true);
    expect(audit.map((r) => r.changes.values.reason).filter(Boolean).sort()).toEqual(["duplicate", "stale", "unknown_variant"]);
    // status and plan only: no amounts, prices or customer data
    for (const r of audit) {
      expect(r.changes.fields).toEqual(["plan", "status"]);
      expect(Object.keys(r.changes.values).sort().join(",")).toMatch(/^(plan,reason,status,type|plan,status,type)$/);
    }
  });

  it("keeps the plan through the grace period after a failed payment, then falls back until a payment succeeds", async () => {
    const { cookie, org, userId } = await signup();
    const intent = crypto.randomUUID();
    const provider = String(Math.floor(Math.random() * 5000000 + 41000000));
    await db!.query("INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'team','301',NOW()+INTERVAL '30 minutes')", [intent, org, userId]);
    const entitlements = lifecycleEntitlements();
    const plan = async (e = entitlements) => (await e.plan(org))?.id;
    expect((await fire(event(provider, intent, "subscription_created", "active", ago(10 * HOUR), 301), lifecycle)).status).toBe(200);
    expect(await plan()).toBe("team");

    // a renewal payment fails: past due, within grace the plan stays
    const failedAt = ago(9 * HOUR);
    expect(await (await fire(invoiceEvent(provider, "subscription_payment_failed", "pending", failedAt), lifecycle)).json()).toMatchObject({ result: "applied" });
    expect(await plan()).toBe("team");
    // the subscription follows to past_due; grace still counts from the first failed payment
    expect(await (await fire(event(provider, null, "subscription_updated", "past_due", ago(8 * HOUR), 301), lifecycle)).json()).toMatchObject({ result: "applied" });
    const pastDue = (await db!.query<{ past_due_since: Date; payment_state: string }>("SELECT past_due_since,payment_state FROM montral_subscription WHERE provider_id=$1", [provider]))[0]!;
    expect(new Date(pastDue.past_due_since).toISOString()).toBe(failedAt);
    expect(pastDue.payment_state).toBe("failed");
    expect(await plan()).toBe("team");
    const during = await (await app.fetch(new Request(ORIGIN + "/api/billing", { headers: { cookie } }), lifecycle as never)).json() as Record<string, unknown>;
    expect(during).toMatchObject({ status: "past_due", paymentState: "failed", entitledPlan: "team" });
    expect(new Date(during.graceEndsAt as string).getTime()).toBe(new Date(failedAt).getTime() + 7 * 24 * HOUR);

    // simulate time: the first failed payment is now eight days old, beyond the default seven-day grace
    await db!.query("UPDATE montral_subscription SET past_due_since=NOW()-INTERVAL '8 days' WHERE provider_id=$1", [provider]);
    expect(await plan()).toBe("lite");
    expect(await plan(lifecycleEntitlements({ MONTRAL_BILLING_GRACE_DAYS: "10" }))).toBe("team");
    expect(await plan(lifecycleEntitlements({ MONTRAL_BILLING_GRACE_DAYS: "0" }))).toBe("lite");
    // a second failed retry does not restart the grace period
    expect((await fire(invoiceEvent(provider, "subscription_payment_failed", "pending", ago(7 * HOUR)), lifecycle)).status).toBe(200);
    expect(await plan()).toBe("lite");

    // the payment is recovered: the plan is back at once, even before the subscription status follows
    expect(await (await fire(invoiceEvent(provider, "subscription_payment_recovered", "paid", ago(6 * HOUR)), lifecycle)).json()).toMatchObject({ result: "applied" });
    expect(await plan()).toBe("team");
    expect((await db!.query<{ past_due_since: Date | null }>("SELECT past_due_since FROM montral_subscription WHERE provider_id=$1", [provider]))[0]!.past_due_since).toBeNull();
    // a delayed, older failure is stale on the invoice clock
    expect(await (await fire(invoiceEvent(provider, "subscription_payment_failed", "pending", ago(8.5 * HOUR)), lifecycle)).json()).toMatchObject({ result: "stale" });
    expect(await plan()).toBe("team");
    expect((await fire(event(provider, null, "subscription_updated", "active", ago(5 * HOUR), 301), lifecycle)).status).toBe(200);
    expect(await plan()).toBe("team");

    // a refund falls back at once; a later successful payment restores the plan
    expect(await (await fire(invoiceEvent(provider, "subscription_payment_refunded", "refunded", ago(4 * HOUR)), lifecycle)).json()).toMatchObject({ result: "applied" });
    expect(await plan()).toBe("lite");
    expect(await plan(lifecycleEntitlements({ MONTRAL_BILLING_GRACE_DAYS: "30" }))).toBe("lite");
    expect((await fire(invoiceEvent(provider, "subscription_payment_success", "paid", ago(3 * HOUR)), lifecycle)).status).toBe(200);
    expect(await plan()).toBe("team");

    // expiry falls back at once and is terminal: a later "active" update cannot revive it
    expect((await fire(event(provider, null, "subscription_expired", "expired", ago(2 * HOUR), 301), lifecycle)).status).toBe(200);
    expect(await plan()).toBe("lite");
    expect(await (await fire(event(provider, null, "subscription_updated", "active", ago(1 * HOUR), 301), lifecycle)).json()).toMatchObject({ result: "stale" });
    expect(await (await fire(invoiceEvent(provider, "subscription_payment_success", "paid", ago(0.5 * HOUR)), lifecycle)).json()).toMatchObject({ result: "stale" });
    expect(await plan()).toBe("lite");

    // payment events of a subscription Montral never linked are unmatched
    expect((await fire(invoiceEvent(String(Number(provider) + 1), "subscription_payment_success", "paid", ago(0)), lifecycle)).status).toBe(409);
    const audit = await billingAudit(org);
    expect(countActions(audit)).toEqual({ "billing.event_applied": 9, "billing.event_ignored": 3 });
    expect(JSON.stringify(audit)).not.toMatch(/amount|total|email|card/i);
  });

  it("reconciles a provider snapshot through the same monotonic path", async () => {
    const { org, userId } = await signup();
    const intent = crypto.randomUUID();
    const provider = String(Math.floor(Math.random() * 5000000 + 51000000));
    await db!.query("INSERT INTO montral_billing_intent(id,organization_id,created_by,plan,variant_id,expires_at) VALUES($1,$2,$3,'team','301',NOW()+INTERVAL '30 minutes')", [intent, org, userId]);
    expect((await fire(event(provider, intent, "subscription_created", "active", "2026-11-01T10:00:00.000Z", 301), lifecycle)).status).toBe(200);
    const snapshot = { providerId: provider, status: "active", variantId: "303", updatedAt: "2026-11-05T10:00:00.000Z", endsAt: null };
    expect(await reconcileSubscription(db!, lifecycle, snapshot)).toBe("applied");
    expect(await lifecycleEntitlements().plan(org)).toMatchObject({ id: "scale" });
    expect(await reconcileSubscription(db!, lifecycle, snapshot)).toBe("duplicate");
    expect(await reconcileSubscription(db!, lifecycle, { ...snapshot, variantId: "302", updatedAt: "2026-11-04T10:00:00.000Z" })).toBe("stale");
    expect(await reconcileSubscription(db!, lifecycle, { ...snapshot, variantId: "399", updatedAt: "2026-11-06T10:00:00.000Z" })).toBe("unmatched");
    // a reconciliation can never create a subscription
    expect(await reconcileSubscription(db!, lifecycle, { ...snapshot, providerId: String(Number(provider) + 1) })).toBe("unmatched");
    expect(await lifecycleEntitlements().plan(org)).toMatchObject({ id: "scale" });
    expect(countActions(await billingAudit(org))).toEqual({ "billing.event_applied": 2, "billing.event_ignored": 2, "billing.event_unmatched": 1 });
  });
});
