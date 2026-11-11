import { describe, expect, it } from "vitest";
import {
  applyBillingEvent, billingGraceDays, billingPlanMap, billingReady, createLemonTestCheckout, entitledPlanId, graceEndsAt,
  limitedBody, parseSubscriptionEvent, reconcileSubscription, verifyLemonSignature, type SubscriptionEntitlementRow,
} from "./montral-billing";
import type { Database } from "@montral/repo";
import type { Bindings } from "./env";

const config = {
  MONTRAL_BILLING_ENABLED: "true",
  MONTRAL_BILLING_MODE: "test",
  LEMONSQUEEZY_API_KEY: "fake-test-mode-key",
  LEMONSQUEEZY_WEBHOOK_SECRET: "fake-sandbox-signing-secret",
  LEMONSQUEEZY_STORE_ID: "42",
  LEMONSQUEEZY_VARIANT_PRO: "101",
  LEMONSQUEEZY_VARIANT_BUSINESS: "102",
} as Bindings;
const payload = {
  meta: { event_name: "subscription_created", custom_data: { montral_intent: "00000000-0000-4000-8000-000000000000" } },
  data: { type: "subscriptions", id: "123", attributes: {
    store_id: 42, variant_id: 101, status: "active", test_mode: true,
    updated_at: "2026-10-30T21:00:00.000Z",
  } },
};
async function signature(body: string, secret = config.LEMONSQUEEZY_WEBHOOK_SECRET!) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
describe("Montral commercial billing is sandbox-only and signature-bound", () => {
  it("does not keep an under-limit signed-billing request open forever on a slow sender", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/billing/lemon", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await Promise.race([
      limitedBody(request, 30).then(() => "accepted", (e: Error) => e.message),
      new Promise<string>(resolve => setTimeout(() => resolve("still-stalled"), 180)),
    ]);
    expect(result).toBe("Billing callback body read timeout");
    expect(canceled).toBe(true);
  });

  it("does not block oversized billing callback refusal when cancellation hangs", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(20 * 1024)); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/billing/lemon", {
      method: "POST", headers: { "content-length": "1" }, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const result = await Promise.race([
      limitedBody(request, 300),
      new Promise<"still-stalled">(resolve => setTimeout(() => resolve("still-stalled"), 180)),
    ]);
    expect(result).toBeNull();
    expect(canceled).toBe(true);
  });

  it("bounds an authenticated checkout plan upload that drips below its tiny byte cap", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([123])); },
      cancel() { canceled = true; return new Promise<void>(() => {}); },
    });
    const request = new Request("http://localhost/api/billing/checkout", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      limitedBody(request, 30, 2048).then(() => "unexpected-read", (e: Error) => e.message),
      new Promise<string>(resolve => setTimeout(() => resolve("still-stalled"), 180)),
    ]);
    expect(outcome).toBe("Billing callback body read timeout");
    expect(canceled).toBe(true);
  });

  it("rejects missing mode, live mode and incomplete merchant credentials", () => {
    expect(billingReady({} as Bindings)).toBe(false);
    expect(billingReady({ ...config, MONTRAL_BILLING_ENABLED: "false" })).toBe(false);
    expect(billingReady({ ...config, MONTRAL_BILLING_MODE: "live" })).toBe(false);
    expect(billingReady({ ...config, LEMONSQUEEZY_VARIANT_BUSINESS: "" })).toBe(false);
    expect(billingReady(config)).toBe(true);
  });
  it("verifies only exact HMAC SHA256 signatures of raw bytes", async () => {
    const raw = JSON.stringify(payload);
    const sig = await signature(raw);
    expect(await verifyLemonSignature(raw, sig, config.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(true);
    expect(await verifyLemonSignature(raw + " ", sig, config.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(false);
    expect(await verifyLemonSignature(raw, sig, "fake-another-secret")).toBe(false);
    expect(await verifyLemonSignature(raw, sig.slice(1), config.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(false);
    expect(await verifyLemonSignature(raw, undefined, config.LEMONSQUEEZY_WEBHOOK_SECRET!)).toBe(false);
  });
  it("creates an isolated TEST checkout with the server-issued correlation nonce, without any network", async () => {
    let invoked = 0;
    const intent = "00000000-0000-4000-8000-000000000123";
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      invoked++;
      expect(String(input)).toBe("https://api.lemonsqueezy.com/v1/checkouts");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer fake-test-mode-key");
      const sent = JSON.parse(String(init?.body));
      expect(sent.data.attributes.test_mode).toBe(true);
      expect(sent.data.attributes.product_options.enabled_variants).toEqual([101]);
      expect(sent.data.attributes.checkout_data.custom.montral_intent).toBe(intent);
      expect(sent.data.relationships.store.data.id).toBe("42");
      expect(sent.data.relationships.variant.data.id).toBe("101");
      return new Response(JSON.stringify({ data: { attributes: { url: "https://test.lemonsqueezy.com/checkout/custom/fixture", test_mode: true } } }), { status: 201 });
    }) as typeof fetch;
    expect(await createLemonTestCheckout(config, "101", intent, stub)).toBe("https://test.lemonsqueezy.com/checkout/custom/fixture");
    expect(invoked).toBe(1);
    const malicious = (async () => new Response(JSON.stringify({ data: { attributes: { url: "https://phishing.example/checkout", test_mode: true } } }), { status: 200 })) as typeof fetch;
    expect(await createLemonTestCheckout(config, "101", intent, malicious)).toBeNull();
    const productionCheckout = (async () => new Response(JSON.stringify({ data: {
      attributes: { url: "https://live.lemonsqueezy.com/checkout/custom/id", test_mode: false },
    } }), { status: 201 })) as typeof fetch;
    expect(await createLemonTestCheckout(config, "101", intent, productionCheckout)).toBeNull();
  });

  it("enforces store, subscription type, strict test mode and a server intent on creation", () => {
    expect(parseSubscriptionEvent(payload, config)).toMatchObject({ name: "subscription_created", id: "123", variant: "101", status: "active" });
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, attributes: { ...payload.data.attributes, ends_at: "bad date" } } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, attributes: { ...payload.data.attributes, ends_at: "2026-11-30T10:00:00Z" } } }, config))
      .toMatchObject({ endsAt: "2026-11-30T10:00:00.000Z" });
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, attributes: { ...payload.data.attributes, test_mode: false } } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, attributes: { ...payload.data.attributes, store_id: 99 } } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, type: "orders" } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, meta: { event_name: "subscription_created" } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, meta: { ...payload.meta, event_name: "order_refunded" } }, config)).toBeNull();
    expect(parseSubscriptionEvent({ ...payload, data: { ...payload.data, attributes: { ...payload.data.attributes, status: "definitely_paid" } } }, config)).toBeNull();
  });
});

/** Synthetic catalog: a "team" plan sold through variants 903/904; plans and numbers describe no real offer. */
const catalogJson = JSON.stringify({
  schemaVersion: 1, version: "synthetic-billing-unit", defaultPlan: "starter",
  plans: [
    { id: "starter", name: "Starter", limits: { activeMonitors: 1, minIntervalSec: 600, regions: 1, credits: 10, emails: 1 } },
    { id: "team", name: "Team", limits: { activeMonitors: 3, minIntervalSec: 300, regions: 1, credits: 30, emails: 3 }, providerVariants: ["903", "904"] },
    { id: "scale", name: "Scale", limits: { activeMonitors: 9, minIntervalSec: 60, regions: 2, credits: 90, emails: 9 }, providerVariants: ["905"] },
  ],
});
const catalogConfig = { ...config, LEMONSQUEEZY_VARIANT_PRO: undefined, LEMONSQUEEZY_VARIANT_BUSINESS: undefined, MONTRAL_PLAN_CONFIG_JSON: catalogJson } as Bindings;

/** A fake database: answers the billing apply function and records every statement (no PostgreSQL, no network). */
function fakeDb(answer: { r_outcome: string; r_org: string | null; r_plan: string | null; r_status: string | null }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return sql.includes("montral_billing_apply") ? [answer] : [];
  } } as unknown as Database;
  return { db, calls };
}

describe("catalog-driven billing plans and the subscription lifecycle", () => {
  it("maps variants through the catalog, with the environment variants only as a fallback", async () => {
    const fromCatalog = (await billingPlanMap(catalogConfig))!;
    expect(fromCatalog.source).toBe("catalog");
    expect([...fromCatalog.variantForPlan]).toEqual([["team", "903"], ["scale", "905"]]);
    expect(fromCatalog.planForVariant("904")).toBe("team");
    expect(fromCatalog.planForVariant("101")).toBeNull();
    // catalog variants win even if the environment variants are set
    expect((await billingPlanMap({ ...catalogConfig, LEMONSQUEEZY_VARIANT_PRO: "101", LEMONSQUEEZY_VARIANT_BUSINESS: "102" }))!.source).toBe("catalog");
    const fallback = (await billingPlanMap(config))!;
    expect(fallback.source).toBe("env");
    expect(fallback.planForVariant("101")).toBe("pro");
    expect(fallback.planForVariant("102")).toBe("business");
    expect(fallback.planForVariant("903")).toBeNull();
    // the fallback needs both variants, distinct, and a catalog defining pro and business
    expect(await billingPlanMap({ ...config, LEMONSQUEEZY_VARIANT_BUSINESS: "101" })).toBeNull();
    const parsed = JSON.parse(catalogJson) as { plans: Record<string, unknown>[] };
    const noVariants = JSON.stringify({ ...parsed, plans: parsed.plans.map(({ providerVariants: _drop, ...p }) => p) });
    expect(billingReady({ ...config, MONTRAL_PLAN_CONFIG_JSON: noVariants })).toBe(true);
    expect(await billingPlanMap({ ...config, MONTRAL_PLAN_CONFIG_JSON: noVariants })).toBeNull();
    expect(await billingPlanMap({ ...catalogConfig, MONTRAL_BILLING_MODE: "live" })).toBeNull();
    await expect(billingPlanMap({ ...catalogConfig, MONTRAL_PLAN_CONFIG_JSON: "{ broken" })).rejects.toThrow(/Invalid plan catalog/);
  });

  it("bounds the grace period: 0-30 days, default 7", () => {
    expect(billingGraceDays({})).toBe(7);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "" })).toBe(7);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "3" })).toBe(3);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "0" })).toBe(0);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "45" })).toBe(30);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "-2" })).toBe(0);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "2.5" })).toBe(7);
    expect(billingGraceDays({ MONTRAL_BILLING_GRACE_DAYS: "soon" })).toBe(7);
  });

  it("computes entitlements: grace from the first failed payment, immediate fallback on refund or expiry", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const day = 86_400_000;
    const row = (over: Partial<SubscriptionEntitlementRow> = {}): SubscriptionEntitlementRow => ({
      plan: "team", status: "active", test_mode: true, ends_at: null, provider_updated_at: "2026-11-01T00:00:00Z",
      payment_state: null, payment_updated_at: null, past_due_since: null, ...over,
    });
    expect(entitledPlanId(row(), now, 7)).toBe("team");
    expect(entitledPlanId(row({ status: "on_trial" }), now, 7)).toBe("team");
    expect(entitledPlanId(row({ test_mode: false }), now, 7)).toBeNull();
    expect(entitledPlanId(null, now, 7)).toBeNull();
    for (const status of ["expired", "unpaid", "paused"]) expect(entitledPlanId(row({ status }), now, 7), status).toBeNull();
    // past due within grace keeps the plan; after grace (or without a start) it falls back
    const since = new Date(now - 3 * day).toISOString();
    expect(entitledPlanId(row({ status: "past_due", past_due_since: since }), now, 7)).toBe("team");
    expect(entitledPlanId(row({ status: "past_due", past_due_since: since }), now, 3)).toBeNull();
    expect(entitledPlanId(row({ status: "past_due", past_due_since: since }), now, 0)).toBeNull();
    expect(entitledPlanId(row({ status: "past_due" }), now, 30)).toBeNull();
    // a failed payment counts as past due even before the subscription status follows
    expect(entitledPlanId(row({ payment_state: "failed", past_due_since: since, payment_updated_at: since }), now, 7)).toBe("team");
    expect(entitledPlanId(row({ payment_state: "failed", past_due_since: new Date(now - 8 * day).toISOString() }), now, 7)).toBeNull();
    // a successful payment newer than the past_due status restores the plan; an older one does not
    expect(entitledPlanId(row({ status: "past_due", payment_state: "paid", payment_updated_at: "2026-11-02T00:00:00Z" }), now, 7)).toBe("team");
    expect(entitledPlanId(row({ status: "past_due", payment_state: "paid", payment_updated_at: "2026-10-30T00:00:00Z", past_due_since: new Date(now - 9 * day).toISOString() }), now, 7)).toBeNull();
    // a refund falls back at once, whatever the status
    expect(entitledPlanId(row({ payment_state: "refunded" }), now, 30)).toBeNull();
    // cancelled keeps the plan only until a future ends_at
    expect(entitledPlanId(row({ status: "cancelled", ends_at: new Date(now + day).toISOString() }), now, 7)).toBe("team");
    expect(entitledPlanId(row({ status: "cancelled", ends_at: new Date(now - 1).toISOString() }), now, 7)).toBeNull();
    expect(entitledPlanId(row({ status: "cancelled" }), now, 7)).toBeNull();
    expect(graceEndsAt(row({ status: "past_due", past_due_since: since }), 7)).toBe(new Date(now + 4 * day).toISOString());
    expect(graceEndsAt(row(), 7)).toBeNull();
  });

  it("parses subscription-invoice payment events by subscription id, refusing inconsistent or live ones", () => {
    const invoice = (event: string, status: string, over: Record<string, unknown> = {}) => ({
      meta: { event_name: event },
      data: { type: "subscription-invoices", id: "7001", attributes: {
        store_id: 42, subscription_id: 123, status, test_mode: true, updated_at: "2026-11-02T10:00:00Z", ...over,
      } },
    });
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "pending"), config)).toEqual({
      kind: "payment", name: "subscription_payment_failed", id: "123", payment: "failed", updated: "2026-11-02T10:00:00.000Z",
    });
    expect(parseSubscriptionEvent(invoice("subscription_payment_success", "paid"), config)).toMatchObject({ payment: "paid", id: "123" });
    expect(parseSubscriptionEvent(invoice("subscription_payment_recovered", "paid"), config)).toMatchObject({ payment: "paid" });
    expect(parseSubscriptionEvent(invoice("subscription_payment_refunded", "refunded"), config)).toMatchObject({ payment: "refunded" });
    expect(parseSubscriptionEvent(invoice("subscription_payment_refunded", "partial_refund"), config)).toMatchObject({ payment: "refunded" });
    // a "success" for an unpaid invoice, or a refund of a paid one, is contradictory: refused, not interpreted
    expect(parseSubscriptionEvent(invoice("subscription_payment_success", "pending"), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_refunded", "paid"), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "made_up"), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "pending", { test_mode: false }), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "pending", { store_id: 99 }), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "pending", { subscription_id: null }), config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("subscription_payment_failed", "pending", { updated_at: "later" }), config)).toBeNull();
    const wrongType = invoice("subscription_payment_failed", "pending");
    expect(parseSubscriptionEvent({ ...wrongType, data: { ...wrongType.data, type: "subscriptions" } }, config)).toBeNull();
    // payment event names never parse as subscription objects, nor arbitrary names as payments
    expect(parseSubscriptionEvent({ ...payload, meta: { event_name: "subscription_payment_failed" } }, config)).toBeNull();
    expect(parseSubscriptionEvent(invoice("toString", "paid"), config)).toBeNull();
  });

  it("audits applied, ignored and unmatched events with status and plan only", async () => {
    const event = { kind: "subscription" as const, name: "subscription_updated", id: "123", variant: "905", status: "active", updated: "2026-11-02T10:00:00.000Z", endsAt: null, intent: null };
    const map = (await billingPlanMap(catalogConfig))!;
    const applied = fakeDb({ r_outcome: "applied", r_org: "org_synthetic", r_plan: "scale", r_status: "active" });
    expect(await applyBillingEvent(applied.db, map, event, "d".repeat(64))).toBe("applied");
    // the variant was resolved to its catalog plan before the SQL call
    expect(applied.calls[0]!.params.slice(0, 6)).toEqual(["d".repeat(64), "subscription_updated", "123", "905", "scale", "active"]);
    const audit = applied.calls.find((c) => c.sql.includes("INSERT INTO audit_event"))!;
    expect(audit.params[0]).toBe("org_synthetic");
    expect(audit.params[2]).toBe("system");
    expect(audit.params[4]).toBe("Billing provider");
    expect(audit.params[8]).toBe("billing.event_applied");
    expect(JSON.parse(audit.params[11] as string)).toEqual({ fields: ["plan", "status"], values: { status: "active", plan: "scale", type: "subscription_updated" } });

    const stale = fakeDb({ r_outcome: "stale", r_org: "org_synthetic", r_plan: "team", r_status: "active" });
    expect(await applyBillingEvent(stale.db, map, event, "e".repeat(64))).toBe("stale");
    const ignored = stale.calls.find((c) => c.sql.includes("INSERT INTO audit_event"))!;
    expect(ignored.params[8]).toBe("billing.event_ignored");
    expect(JSON.parse(ignored.params[11] as string).values).toMatchObject({ reason: "stale", plan: "team" });

    const unknown = fakeDb({ r_outcome: "unmatched", r_org: "org_synthetic", r_plan: "team", r_status: "active" });
    expect(await applyBillingEvent(unknown.db, map, { ...event, variant: "999" }, "f".repeat(64))).toBe("unmatched");
    expect(unknown.calls[0]!.params[4]).toBeNull();
    const unmatched = unknown.calls.find((c) => c.sql.includes("INSERT INTO audit_event"))!;
    expect(unmatched.params[8]).toBe("billing.event_unmatched");
    expect(JSON.parse(unmatched.params[11] as string).values).toMatchObject({ reason: "unknown_variant" });

    // no workspace identified: nothing to audit
    const orphan = fakeDb({ r_outcome: "unmatched", r_org: null, r_plan: null, r_status: null });
    expect(await applyBillingEvent(orphan.db, map, event, "0".repeat(64))).toBe("unmatched");
    expect(orphan.calls).toHaveLength(1);
    // payment events carry no variant or plan, only the payment outcome
    const pay = fakeDb({ r_outcome: "applied", r_org: "org_synthetic", r_plan: "team", r_status: "past_due" });
    await applyBillingEvent(pay.db, map, { kind: "payment", name: "subscription_payment_failed", id: "123", payment: "failed", updated: "2026-11-03T00:00:00.000Z" }, "1".repeat(64));
    expect(pay.calls[0]!.params).toEqual(["1".repeat(64), "subscription_payment_failed", "123", null, null, null, "2026-11-03T00:00:00.000Z", null, null, "failed"]);
  });

  it("reconciles a provider snapshot through the same monotonic path, without any network", async () => {
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("no network in reconciliation"); }) as typeof fetch;
    try {
      const run = fakeDb({ r_outcome: "applied", r_org: "org_synthetic", r_plan: "team", r_status: "past_due" });
      const snapshot = { providerId: "123", status: "past_due", variantId: "904", updatedAt: "2026-11-04T00:00:00Z", endsAt: null };
      expect(await reconcileSubscription(run.db, catalogConfig, snapshot)).toBe("applied");
      const call = run.calls[0]!;
      expect(call.sql).toContain("montral_billing_apply");
      expect(call.params.slice(1, 10)).toEqual(["subscription_reconciled", "123", "904", "team", "past_due", "2026-11-04T00:00:00.000Z", null, null, null]);
      expect(call.params[0]).toMatch(/^[0-9a-f]{64}$/);
      // the same snapshot gets the same digest (a re-run is a duplicate); a different one another digest
      const again = fakeDb({ r_outcome: "duplicate", r_org: "org_synthetic", r_plan: "team", r_status: "past_due" });
      expect(await reconcileSubscription(again.db, catalogConfig, snapshot)).toBe("duplicate");
      expect(again.calls[0]!.params[0]).toBe(call.params[0]);
      const other = fakeDb({ r_outcome: "stale", r_org: "org_synthetic", r_plan: "team", r_status: "past_due" });
      expect(await reconcileSubscription(other.db, catalogConfig, { ...snapshot, updatedAt: "2026-11-03T00:00:00Z" })).toBe("stale");
      expect(other.calls[0]!.params[0]).not.toBe(call.params[0]);
      // invalid snapshots never reach the database; unconfigured billing does nothing
      const none = fakeDb({ r_outcome: "applied", r_org: null, r_plan: null, r_status: null });
      expect(await reconcileSubscription(none.db, catalogConfig, { ...snapshot, status: "paid_forever" })).toBe("invalid");
      expect(await reconcileSubscription(none.db, catalogConfig, { ...snapshot, variantId: "x" })).toBe("invalid");
      expect(await reconcileSubscription(none.db, catalogConfig, { ...snapshot, endsAt: "never" })).toBe("invalid");
      expect(await reconcileSubscription(none.db, { ...catalogConfig, MONTRAL_BILLING_ENABLED: "false" }, snapshot)).toBe("not_configured");
      expect(none.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
});
