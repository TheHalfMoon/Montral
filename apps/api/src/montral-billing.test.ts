import { describe, expect, it } from "vitest";
import { billingReady, createLemonTestCheckout, limitedBody, parseSubscriptionEvent, verifyLemonSignature } from "./montral-billing";
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
