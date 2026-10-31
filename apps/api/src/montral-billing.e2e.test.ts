import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createApp } from "./app";
import { montralEdition } from "./montral-edition";
import { migrateMontralSchema } from "./schema-migrate";
import { calendarMonthUtc, createMontralEntitlements } from "./montral-metering";
import { runMontralMaintenance } from "./montral-maintenance";
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

describe.skipIf(!url)("Montral sandbox billing PostgreSQL verification", () => {
  beforeAll(async () => {
    await migrateMontralSchema(db!, montralEdition);
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
      expect(responses.filter(x => x.status === 201)).toHaveLength(1);
      expect(responses.filter(x => x.status === 409)).toHaveLength(7);
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
