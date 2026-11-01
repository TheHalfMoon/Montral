import type { Database } from "@montral/repo";
import type { AppEnv, Bindings } from "./env";
import type { Hono } from "hono";
import { Hono as Router } from "hono";
import { requireManager } from "./middleware";
import { z } from "zod";

const BODY_LIMIT = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
export class BillingBodyTimeoutError extends Error {
  constructor() { super("Billing callback body read timeout"); }
}
const PLANS = ["pro", "business"] as const;
const inputPlan = z.object({ plan: z.enum(PLANS) }).strict();
const SUB_EVENTS = new Set(["subscription_created", "subscription_updated", "subscription_cancelled",
  "subscription_resumed", "subscription_expired", "subscription_paused", "subscription_unpaused"]);
// Signed provider callbacks must be authenticated and deduplicated using the
// exact HTTP bytes, never a lossy replacement-decoded Unicode string.
const asBytes = (source: string | Uint8Array) => typeof source === "string"
  ? new TextEncoder().encode(source) : new Uint8Array(source);
const sha256 = async (source: Uint8Array) => Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", asBytes(source))),
  b => b.toString(16).padStart(2, "0"),
).join("");
const stringId = (v: unknown) => (typeof v === "string" && /^[0-9]{1,24}$/.test(v)) ? v :
  (typeof v === "number" && Number.isSafeInteger(v) && v > 0) ? String(v) : null;

/** Use WebCrypto instead of Node crypto so the same signing code works on Cloudflare Workers. */
export async function verifyLemonSignature(body: string | Uint8Array, header: string | undefined, secret: string): Promise<boolean> {
  if (!secret || !header || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, asBytes(body)));
  const expected = Uint8Array.from(header.match(/../g)!, byte => parseInt(byte, 16));
  let result = 0;
  for (let i = 0; i < digest.length; i++) result |= digest[i] ^ expected[i];
  return result === 0;
}

/** Completely disabled until an operator opts in with a test store, secret and plans. */
export function billingReady(env: Bindings): boolean {
  return env.MONTRAL_BILLING_ENABLED === "true" &&
    env.MONTRAL_BILLING_MODE === "test" &&
    !!env.LEMONSQUEEZY_API_KEY && !!env.LEMONSQUEEZY_WEBHOOK_SECRET &&
    !!stringId(env.LEMONSQUEEZY_STORE_ID) &&
    !!stringId(env.LEMONSQUEEZY_VARIANT_PRO) && !!stringId(env.LEMONSQUEEZY_VARIANT_BUSINESS);
}

export async function migrateMontralBilling(db: Database): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS montral_billing_intent (
    id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    created_by text NOT NULL, plan text NOT NULL CHECK (plan IN ('pro','business')),
    variant_id text NOT NULL, expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(), consumed_at timestamptz
  )`);
  await db.query("ALTER TABLE montral_billing_intent ADD COLUMN IF NOT EXISTS consumed_at timestamptz");
  await db.query(`CREATE INDEX IF NOT EXISTS montral_billing_intent_pending
    ON montral_billing_intent (organization_id,expires_at) WHERE consumed_at IS NULL`);
  // Atomically reserve a single unexpired checkout per workspace. This lock is
  // scoped to the workspace, so independent customers are never serialized.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_reserve_billing_intent(
      p_id uuid, p_org text, p_creator text, p_plan text, p_variant text
    ) RETURNS boolean LANGUAGE plpgsql AS $montral$
    BEGIN
      IF p_plan NOT IN ('pro','business') THEN
        RAISE EXCEPTION 'invalid billing plan';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('montral:checkout:' || p_org, 0));
      IF EXISTS (
        SELECT 1 FROM montral_subscription
        WHERE organization_id=p_org AND status <> 'expired'
      ) OR EXISTS (
        SELECT 1 FROM montral_billing_intent
        WHERE organization_id=p_org AND consumed_at IS NULL AND expires_at > NOW()
      ) THEN
        RETURN false;
      END IF;
      INSERT INTO montral_billing_intent(
        id,organization_id,created_by,plan,variant_id,expires_at
      ) VALUES (p_id,p_org,p_creator,p_plan,p_variant,NOW()+INTERVAL '30 minutes');
      RETURN true;
    END;
    $montral$
  `);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_subscription (
    organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
    provider_id text NOT NULL UNIQUE, variant_id text NOT NULL, plan text NOT NULL,
    status text NOT NULL, test_mode boolean NOT NULL DEFAULT true,
    ends_at timestamptz, provider_updated_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await db.query("ALTER TABLE montral_subscription ADD COLUMN IF NOT EXISTS ends_at timestamptz");
  // An earlier checkout preview exposed a seven-argument SQL function. Drop
  // it so existing installations cannot accidentally call the old behavior.
  await db.query("DROP FUNCTION IF EXISTS montral_apply_billing_event(text,text,text,text,text,timestamptz,uuid)");
  await db.query(`CREATE TABLE IF NOT EXISTS montral_billing_event (
    digest char(64) PRIMARY KEY, provider_id text NOT NULL, name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  )`);
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_apply_billing_event(
      p_digest text, p_event text, p_provider text, p_variant text,
      p_status text, p_updated timestamptz, p_intent uuid, p_ends timestamptz
    ) RETURNS text LANGUAGE plpgsql AS $montral$
    DECLARE target_org text; target_plan text; expected_variant text;
            inserted_count integer; changed_count integer;
    BEGIN
      -- A single database transaction covers identity resolution, deduplication
      -- and the subscription update; no event is "consumed" before an update commits.
      IF EXISTS (SELECT 1 FROM montral_billing_event WHERE digest=p_digest) THEN
        RETURN 'duplicate';
      END IF;
      IF p_event = 'subscription_created' THEN
        SELECT organization_id, plan, variant_id
          INTO target_org, target_plan, expected_variant
          FROM montral_billing_intent
          WHERE id=p_intent AND expires_at > NOW() AND consumed_at IS NULL FOR UPDATE;
        IF target_org IS NULL OR expected_variant <> p_variant THEN RETURN 'unmatched'; END IF;
        -- Multiple intents may exist from older preview versions. A second
        -- provider must not replace an active subscription. Serialize with
        -- the checkout reservation lock, then reread after locking.
        PERFORM pg_advisory_xact_lock(hashtextextended('montral:checkout:' || target_org, 0));
        IF EXISTS (
          SELECT 1 FROM montral_subscription
          WHERE organization_id=target_org AND provider_id<>p_provider AND status<>'expired'
        ) THEN
          RETURN 'unmatched';
        END IF;
      ELSE
        SELECT organization_id, plan, variant_id
          INTO target_org, target_plan, expected_variant
          FROM montral_subscription WHERE provider_id=p_provider FOR UPDATE;
        IF target_org IS NULL OR expected_variant <> p_variant THEN RETURN 'unmatched'; END IF;
      END IF;
      INSERT INTO montral_billing_event(digest,provider_id,name)
        VALUES(p_digest,p_provider,p_event) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count = 0 THEN RETURN 'duplicate'; END IF;
      IF p_event = 'subscription_created' THEN
        UPDATE montral_billing_intent SET consumed_at=NOW() WHERE id=p_intent;
        INSERT INTO montral_subscription(organization_id,provider_id,variant_id,plan,status,test_mode,provider_updated_at,ends_at)
          VALUES (target_org,p_provider,p_variant,target_plan,p_status,true,p_updated,p_ends)
        ON CONFLICT (organization_id) DO UPDATE SET
          provider_id=EXCLUDED.provider_id, variant_id=EXCLUDED.variant_id,
          plan=EXCLUDED.plan,status=EXCLUDED.status,provider_updated_at=EXCLUDED.provider_updated_at,
          ends_at=EXCLUDED.ends_at,updated_at=NOW()
        WHERE (
          -- Provider replacement starts a distinct clock stream, but only
          -- after the old subscription is really expired.
          (montral_subscription.provider_id <> EXCLUDED.provider_id
            AND montral_subscription.status = 'expired')
          OR
          (montral_subscription.provider_id = EXCLUDED.provider_id AND (
            montral_subscription.provider_updated_at < EXCLUDED.provider_updated_at
            OR (montral_subscription.provider_updated_at = EXCLUDED.provider_updated_at AND (
              -- Equal provider timestamps must never restore paid access
              -- after a cancellation/expiry. Prefer only stricter states.
              array_position(ARRAY['on_trial','active','paused','past_due','unpaid','cancelled','expired']::text[], EXCLUDED.status)
                > array_position(ARRAY['on_trial','active','paused','past_due','unpaid','cancelled','expired']::text[], montral_subscription.status)
              OR (EXCLUDED.status='cancelled' AND montral_subscription.status='cancelled'
                AND montral_subscription.ends_at IS NOT NULL
                AND (EXCLUDED.ends_at IS NULL OR EXCLUDED.ends_at < montral_subscription.ends_at))
            ))
          ))
        );
      ELSE
        UPDATE montral_subscription SET status=p_status,provider_updated_at=p_updated,ends_at=p_ends,updated_at=NOW()
          WHERE provider_id=p_provider AND (
            provider_updated_at < p_updated
            OR (provider_updated_at = p_updated AND (
              array_position(ARRAY['on_trial','active','paused','past_due','unpaid','cancelled','expired']::text[], p_status)
                > array_position(ARRAY['on_trial','active','paused','past_due','unpaid','cancelled','expired']::text[], status)
              OR (p_status='cancelled' AND status='cancelled' AND ends_at IS NOT NULL
                AND (p_ends IS NULL OR p_ends < ends_at))
            ))
          );
      END IF;
      GET DIAGNOSTICS changed_count = ROW_COUNT;
      -- Digest remains in the replay ledger even if this valid signed event
      -- is older, or tied in timestamp and not more restrictive.
      IF changed_count = 0 THEN RETURN 'stale'; END IF;
      RETURN 'applied';
    END;
    $montral$
  `);
  return ["montral_billing_test_preview_v1"];
}

/**
 * Remove ONLY expired sandbox checkout-correlation nonces. Keep them for seven
 * extra days to tolerate delayed provider retries. Subscription records and
 * signed event digests are deliberately untouched: deleting either can impair
 * replay protection or the audit trail.
 */
export async function pruneExpiredBillingIntents(db: Database): Promise<number> {
  const rows = await db.query<{ removed: string }>(`
    WITH old_intents AS (
      DELETE FROM montral_billing_intent
      WHERE expires_at < NOW() - INTERVAL '7 days'
      RETURNING 1
    ) SELECT COUNT(*)::text AS removed FROM old_intents
  `);
  return Number(rows[0]?.removed ?? 0);
}

type SubscriptionPayload = {
  meta?: { event_name?: unknown; custom_data?: { montral_intent?: unknown } };
  data?: { type?: unknown; id?: unknown; attributes?: {
    store_id?: unknown; variant_id?: unknown; status?: unknown; test_mode?: unknown;
    updated_at?: unknown; ends_at?: unknown;
  } };
};

/** Fail closed when provenance, checkout identity or state cannot be confirmed. */
export function parseSubscriptionEvent(raw: unknown, env: Bindings) {
  const payload = raw as SubscriptionPayload | null;
  const name = payload?.meta?.event_name;
  if (typeof name !== "string" || !SUB_EVENTS.has(name)) return null;
  if (payload?.data?.type !== "subscriptions") return null;
  const id = stringId(payload.data.id);
  const attrs = payload.data.attributes;
  const store = stringId(attrs?.store_id);
  const variant = stringId(attrs?.variant_id);
  if (!id || !store || store !== env.LEMONSQUEEZY_STORE_ID || !variant) return null;
  if (attrs?.test_mode !== true || typeof attrs?.status !== "string" ||
      !/^(on_trial|active|paused|past_due|unpaid|cancelled|expired)$/.test(attrs.status)) return null;
  if (typeof attrs.updated_at !== "string" || !Number.isFinite(Date.parse(attrs.updated_at))) return null;
  const endValue = attrs.ends_at;
  // Provider cancellation is only paid through ends_at. Invalid dates cannot
  // extend benefits; absence means an immediate Free downgrade.
  if (endValue !== undefined && endValue !== null &&
      (typeof endValue !== "string" || !Number.isFinite(Date.parse(endValue)))) return null;
  const endsAt = typeof endValue === "string" ? new Date(endValue).toISOString() : null;
  const intent = payload.meta?.custom_data?.montral_intent;
  if (name === "subscription_created" && (typeof intent !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(intent))) return null;
  return {
    name, id, variant, status: attrs.status,
    updated: new Date(attrs.updated_at).toISOString(), endsAt,
    intent: typeof intent === "string" ? intent : null,
  };
}

/** A signed callback's HMAC covers exact bytes; allow only bounded memory
 * and one total wall-clock upload interval before verifying any signature.
 * The test-only timeout override is never supplied by mounted HTTP routes. */
export async function limitedBody(req: Request, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length")) > BODY_LIMIT) {
    void req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  let bytes = 0; const chunks: Uint8Array[] = [];
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BillingBodyTimeoutError()), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) return null;
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A sender can refuse cancellation forever; neither 413 nor 408 may
    // await that promise, and successful signed callbacks need no cancellation.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let position = 0;
  for (const chunk of chunks) { joined.set(chunk, position); position += chunk.length; }
  return joined;
}

/**
 * Only creates a provider TEST checkout, never a charge. Caller persists the
 * server-generated intent before returning its unguessable provider URL.
 * The optional fetcher is injected in tests to forbid network traffic.
 */
export async function createLemonTestCheckout(
  env: Bindings, variant: string, id: string, fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const provider = await fetcher("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
        accept: "application/vnd.api+json", "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify({ data: { type: "checkouts",
        attributes: { test_mode: true,
          product_options: { enabled_variants: [Number(variant)] },
          checkout_data: { custom: { montral_intent: id } },
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        relationships: { store: { data: { type: "stores", id: env.LEMONSQUEEZY_STORE_ID } },
          variant: { data: { type: "variants", id: variant } } },
      } }),
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);

  if (!provider?.ok) return null;
  const data = await provider.json().catch(() => null) as { data?: { attributes?: { url?: string; test_mode?: boolean } } } | null;
  // Refuse a production checkout, even if a merchant accidentally configures a
  // live-store credential while this preview is restricted to TEST MODE.
  if (data?.data?.attributes?.test_mode !== true) return null;
  const checkout = data?.data?.attributes?.url;
  return checkout && /^https:\/\/[^/]+\.lemonsqueezy\.com\/checkout\//.test(checkout) ? checkout : null;
}

export function mountMontralBilling({ app, authed }: { app: Hono<AppEnv>; authed: Hono<AppEnv> }) {
  // A merchant's payment event is NOT a generic webhook inbox event.
  // The endpoint is hidden until this project is deliberately configured.
  app.post("/api/billing/lemon", async (c) => {
    if (!billingReady(c.env)) return c.json({ error: "Not configured" }, 404);
    let body: Uint8Array | null;
    try {
      body = await limitedBody(c.req.raw);
    } catch (error) {
      if (error instanceof BillingBodyTimeoutError) {
        c.header("cache-control", "no-store");
        c.header("referrer-policy", "no-referrer");
        c.header("x-content-type-options", "nosniff");
        return c.json({ error: error.message }, 408);
      }
      throw error;
    }
    if (body === null) return c.json({ error: "Payload too large" }, 413);
    if (!await verifyLemonSignature(body, c.req.header("x-signature"), c.env.LEMONSQUEEZY_WEBHOOK_SECRET!)) {
      return c.json({ error: "Invalid signature" }, 401);
    }
    let payload: unknown;
    try {
      // Reject ill-formed UTF-8, rather than replacing bytes with U+FFFD:
      // the signed raw-body sequence must have one unambiguous JSON decoding.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      payload = JSON.parse(text || "null");
    } catch { return c.json({ error: "Invalid UTF-8 or JSON" }, 400); }
    const event = parseSubscriptionEvent(payload, c.env);
    if (!event) return c.json({ error: "Unsupported or invalid test subscription event" }, 422);
    // The provider sends event name in both the signed payload and a header.
    // Both must agree; this is a protocol consistency check, not authentication.
    const eventNameHeader = c.req.header("x-event-name");
    if (eventNameHeader && eventNameHeader !== event.name) return c.json({ error: "Event name mismatch" }, 422);
    const rows = await c.get("database").query<{ outcome: string }>(
      "SELECT montral_apply_billing_event($1,$2,$3,$4,$5,$6::timestamptz,$7::uuid,$8::timestamptz) AS outcome",
      [await sha256(body), event.name, event.id, event.variant, event.status, event.updated, event.intent, event.endsAt],
    );
    if (rows[0]?.outcome === "unmatched") return c.json({ error: "Unknown subscription or checkout" }, 409);
    return c.json({ ok: true, result: rows[0]?.outcome ?? "unknown" }, 200);
  });

  const billing = new Router<AppEnv>();
  billing.get("/", requireManager, async (c) => {
    const rows = await c.get("database").query<{
      plan: string; status: string; provider_updated_at: Date; ends_at: Date | null;
    }>("SELECT plan,status,provider_updated_at,ends_at FROM montral_subscription WHERE organization_id=$1", [c.get("orgId")]);
    c.header("cache-control", "no-store");
    return c.json({ plan: rows[0]?.plan ?? "free", status: rows[0]?.status ?? "none",
      billingConfigured: billingReady(c.env), providerUpdatedAt: rows[0]?.provider_updated_at ?? null,
      endsAt: rows[0]?.ends_at ?? null });
  });
  billing.post("/checkout", requireManager, async (c) => {
    if (!billingReady(c.env)) return c.json({ error: "Billing is unavailable" }, 503);
    const result = inputPlan.safeParse(await c.req.json().catch(() => null));
    if (!result.success) return c.json({ error: "Invalid plan" }, 400);
    const variant = result.data.plan === "pro" ? c.env.LEMONSQUEEZY_VARIANT_PRO! : c.env.LEMONSQUEEZY_VARIANT_BUSINESS!;
    const id = crypto.randomUUID();
    // Advisory-locked SQL reservation makes a single pending test checkout per
    // workspace, even across different Node/Worker processes and connections.
    // The intent is committed before contacting the provider for callback safety.
    const reservation = await c.get("database").query<{ reserved: boolean }>(
      "SELECT montral_reserve_billing_intent($1::uuid,$2::text,$3::text,$4::text,$5::text) AS reserved",
      [id, c.get("orgId"), c.get("userId"), result.data.plan, variant],
    );
    if (!reservation[0]?.reserved) return c.json({
      error: "An active subscription or unexpired checkout already exists for this workspace",
    }, 409);
    const checkout = await createLemonTestCheckout(c.env, variant, id);
    if (!checkout) {
      await c.get("database").query(
        "DELETE FROM montral_billing_intent WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL",
        [id, c.get("orgId")],
      );
      return c.json({ error: "Checkout provider is unavailable" }, 502);
    }
    c.header("cache-control", "no-store");
    return c.json({ url: checkout, testMode: true }, 201);
  });
  authed.route("/billing", billing);
}
