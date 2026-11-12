import type { Database } from "@montral/repo";
import type { AppEnv, Bindings } from "./env";
import type { Hono } from "hono";
import { Hono as Router } from "hono";
import { requireManager } from "./middleware";
import { columnExists, constraintExists, relationExists } from "./schema-catalog";
import { recordAuditEvent } from "./audit";
import { cachedPlanCatalog, type PlanCatalog } from "./plan-catalog";
import { z } from "zod";

const BODY_LIMIT = 64 * 1024;
/** Authenticated sandbox checkout accepts only a small JSON plan selection. */
const CHECKOUT_BODY_LIMIT = 2 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;
export class BillingBodyTimeoutError extends Error {
  constructor() { super("Billing callback body read timeout"); }
}
/**
 * The plan ids the environment fallback (LEMONSQUEEZY_VARIANT_PRO/_BUSINESS) subscribes to. Used only while the plan
 * catalog lists no provider variants (e.g. the built-in sandbox catalog); then the catalog must define both ids.
 */
export const ENV_FALLBACK_PLAN_IDS = ["pro", "business"] as const;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const inputPlan = z.object({ plan: z.string().regex(PLAN_ID) }).strict();
const SUB_EVENTS = new Set(["subscription_created", "subscription_updated", "subscription_cancelled",
  "subscription_resumed", "subscription_expired", "subscription_paused", "subscription_unpaused"]);
/**
 * Lemon Squeezy's subscription payment events (docs.lemonsqueezy.com/help/webhooks/event-types). Their payload is a
 * subscription INVOICE ("subscription-invoices"), which names its subscription but carries no variant; they change
 * only the payment state, never the plan.
 */
const PAYMENT_EVENTS: Record<string, PaymentState> = {
  subscription_payment_success: "paid",
  subscription_payment_recovered: "paid",
  subscription_payment_failed: "failed",
  subscription_payment_refunded: "refunded",
};
/** Documented subscription-invoice statuses. */
const INVOICE_STATUSES = new Set(["pending", "paid", "void", "refunded", "partial_refund"]);
const SUBSCRIPTION_STATUS = /^(on_trial|active|paused|past_due|unpaid|cancelled|expired)$/;
export type PaymentState = "paid" | "failed" | "refunded";
const DAY_MS = 86_400_000;
export const BILLING_GRACE_DEFAULT_DAYS = 7;
export const BILLING_GRACE_MAX_DAYS = 30;
/** Days a past-due subscription keeps its plan, from the first failed payment: MONTRAL_BILLING_GRACE_DAYS (0–30), else 7. */
export function billingGraceDays(env: Pick<Bindings, "MONTRAL_BILLING_GRACE_DAYS"> | undefined): number {
  const raw = env?.MONTRAL_BILLING_GRACE_DAYS;
  if (raw === undefined || raw.trim() === "") return BILLING_GRACE_DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n)) return BILLING_GRACE_DEFAULT_DAYS;
  return Math.min(BILLING_GRACE_MAX_DAYS, Math.max(0, n));
}
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

/** Both environment fallback variants are set, valid and distinct. */
export const envVariantsValid = (env: Bindings) =>
  !!stringId(env.LEMONSQUEEZY_VARIANT_PRO) && !!stringId(env.LEMONSQUEEZY_VARIANT_BUSINESS) &&
  env.LEMONSQUEEZY_VARIANT_PRO !== env.LEMONSQUEEZY_VARIANT_BUSINESS;
const hasOperatorCatalog = (env: Bindings) => !!env.MONTRAL_PLAN_CONFIG_JSON && env.MONTRAL_PLAN_CONFIG_JSON.trim() !== "";

/**
 * Completely disabled until an operator opts in with a test store, secret and plans. Plans come from the operator
 * plan catalog's provider variants or, failing those, the two environment variants (see billingPlanMap).
 */
export function billingReady(env: Bindings): boolean {
  return env.MONTRAL_BILLING_ENABLED === "true" &&
    env.MONTRAL_BILLING_MODE === "test" &&
    !!env.LEMONSQUEEZY_API_KEY && !!env.LEMONSQUEEZY_WEBHOOK_SECRET &&
    !!stringId(env.LEMONSQUEEZY_STORE_ID) &&
    (envVariantsValid(env) || hasOperatorCatalog(env));
}

/** How provider variants map to catalog plans in this deployment. */
export type BillingPlanMap = {
  source: "catalog" | "env";
  catalog: PlanCatalog;
  /** the variant a checkout for this plan uses (the plan's first variant); plans not listed cannot be bought */
  variantForPlan: ReadonlyMap<string, string>;
  /** the catalog plan id a provider variant subscribes to, or null (unknown variant: never guessed) */
  planForVariant(variantId: string): string | null;
};

/**
 * The variant → plan mapping. Catalog-driven when any catalog plan lists `providerVariants`; otherwise the environment
 * fallback maps LEMONSQUEEZY_VARIANT_PRO/_BUSINESS to the plan ids "pro"/"business", which the catalog must define.
 * Null when billing is not ready or no mapping is configured. Throws PlanCatalogError for an invalid catalog (fail
 * closed: callers answer 503, never guess a plan).
 */
export async function billingPlanMap(env: Bindings): Promise<BillingPlanMap | null> {
  if (!billingReady(env)) return null;
  const catalog = await cachedPlanCatalog(env);
  if (catalog.hasProviderVariants) {
    const variantForPlan = new Map<string, string>();
    for (const plan of catalog.plans.values()) {
      const first = plan.providerVariants?.[0];
      if (first && plan.id !== catalog.defaultPlan.id) variantForPlan.set(plan.id, first);
    }
    return { source: "catalog", catalog, variantForPlan, planForVariant: (v) => catalog.planForVariant(v)?.id ?? null };
  }
  if (!envVariantsValid(env) || ENV_FALLBACK_PLAN_IDS.some((id) => !catalog.plans.has(id) || id === catalog.defaultPlan.id)) return null;
  const variantForPlan = new Map<string, string>([["pro", env.LEMONSQUEEZY_VARIANT_PRO!], ["business", env.LEMONSQUEEZY_VARIANT_BUSINESS!]]);
  const byVariant = new Map([...variantForPlan].map(([plan, variant]) => [variant, plan] as const));
  return { source: "env", catalog, variantForPlan, planForVariant: (v) => byVariant.get(v) ?? null };
}

/**
 * Catalog drift of live (non-expired) subscriptions: stored plan ids the catalog no longer defines (those workspaces
 * get the default plan) and stored variants no catalog plan lists (a later plan change by that variant is refused).
 * Counts and plan ids only, never workspace or customer data. Null when billing has no plan map.
 */
export async function subscriptionCatalogDrift(db: Database, env: Bindings): Promise<{
  source: BillingPlanMap["source"]; missingPlans: { plan: string; count: number }[]; unmappedVariants: number;
} | null> {
  const map = await billingPlanMap(env);
  if (!map) return null;
  const rows = await db.query<{ plan: string; variant_id: string; count: string }>(
    "SELECT plan, variant_id, COUNT(*)::text AS count FROM montral_subscription WHERE status <> 'expired' GROUP BY plan, variant_id",
  );
  const missing = new Map<string, number>();
  let unmappedVariants = 0;
  for (const r of rows) {
    if (!map.catalog.plans.has(r.plan)) missing.set(r.plan, (missing.get(r.plan) ?? 0) + Number(r.count));
    if (map.planForVariant(r.variant_id) === null) unmappedVariants += Number(r.count);
  }
  return { source: map.source, missingPlans: [...missing].map(([plan, count]) => ({ plan, count })), unmappedVariants };
}

/** The stored subscription columns entitlements are computed from. */
export type SubscriptionEntitlementRow = {
  plan: string; status: string; test_mode: boolean; ends_at: Date | string | null;
  provider_updated_at: Date | string | null; payment_state: PaymentState | null;
  payment_updated_at: Date | string | null; past_due_since: Date | string | null;
};

/**
 * The plan id a stored subscription entitles its workspace to at `now`, or null (the catalog's default plan applies).
 * Fail closed:
 * - only a test-mode subscription counts (this preview has no live billing);
 * - `expired`, `unpaid`, `paused` and a refunded payment fall back at once;
 * - `cancelled` keeps the plan only until a future `ends_at`;
 * - past due (status `past_due`, or a failed payment not yet followed by a successful one) keeps the plan for
 *   `graceDays` from the first failed payment (`past_due_since`), then falls back until a payment succeeds. A
 *   successful payment newer than the subscription's last status update ends past due even before the provider's
 *   `subscription_updated` arrives.
 */
export function entitledPlanId(row: SubscriptionEntitlementRow | null | undefined, now: number, graceDays: number): string | null {
  if (!row || row.test_mode !== true || typeof row.plan !== "string") return null;
  if (row.payment_state === "refunded") return null;
  const time = (d: Date | string | null) => (d === null ? Number.NaN : new Date(d).getTime());
  if (row.status === "cancelled") {
    if (!(time(row.ends_at) > now)) return null;
  } else if (!["active", "on_trial", "past_due"].includes(row.status)) {
    return null;
  }
  if (isPastDue(row)) {
    const since = time(row.past_due_since);
    if (!Number.isFinite(since) || now >= since + graceDays * DAY_MS) return null;
  }
  return row.plan;
}

/**
 * Past due: the latest payment failed, or the provider status is past_due and no successful payment is newer than that
 * status update (a newer paid invoice ends past due even before the provider's subscription_updated arrives).
 */
function isPastDue(row: SubscriptionEntitlementRow): boolean {
  const time = (d: Date | string | null) => (d === null ? Number.NaN : new Date(d).getTime());
  const paidSinceStatus = row.payment_state === "paid" && time(row.payment_updated_at) >= time(row.provider_updated_at);
  return row.payment_state === "failed" || (row.status === "past_due" && !paidSinceStatus);
}

/** When a past-due subscription's grace period ends (null: not past due). For display only. */
export function graceEndsAt(row: SubscriptionEntitlementRow | null | undefined, graceDays: number): string | null {
  if (!row || !row.past_due_since || row.payment_state === "refunded") return null;
  return isPastDue(row) ? new Date(new Date(row.past_due_since).getTime() + graceDays * DAY_MS).toISOString() : null;
}

/**
 * CHECK constraints on montral_billing_intent that restrict `plan` to the fixed ids of earlier versions, by their
 * actual names (earlier versions declared it inline, so PostgreSQL chose the name).
 */
async function legacyIntentPlanChecks(db: Database): Promise<string[]> {
  const rows = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = to_regclass('montral_billing_intent') AND contype = 'c'
        AND conname <> 'montral_billing_intent_plan_format'
        AND pg_get_constraintdef(oid) LIKE '%plan%'
        AND pg_get_constraintdef(oid) LIKE '%''pro''%' AND pg_get_constraintdef(oid) LIKE '%''business''%'`,
  );
  return rows.map((r) => r.conname);
}
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Rolling upgrades and rollbacks: replicas of the previous release keep running (and restarting) while this one
 * migrates. This release therefore never drops, replaces or redefines a database function the previous release uses:
 * `montral_reserve_billing_intent` and the eight-argument `montral_apply_billing_event` stay exactly as that release
 * defines them (an old replica restarting re-creates its own versions, which no new code calls). New code calls only
 * `montral_reserve_billing_intent_v2` and `montral_billing_apply`. Old replicas against the new schema are merely less
 * capable (only the fixed plan ids, no payment state), never conflicting. The old functions are removed in a later
 * release, once no replica of the previous release can run.
 */
export async function migrateMontralBilling(db: Database): Promise<string[]> {
  // This runs inside the single edition-migration transaction on EVERY replica
  // startup, while checkouts may be in flight. The reservation functions read
  // montral_subscription and then montral_billing_intent. An
  // unconditional `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
  // locks the table even when the object exists, and the old order (intent,
  // then subscription) deadlocked (40P01) with a concurrent reservation. Decide
  // from the catalog first: an up-to-date schema takes no table-locking DDL.
  const hasSubscription = await relationExists(db, "montral_subscription");
  const hasIntent = await relationExists(db, "montral_billing_intent");
  const hasEvent = await relationExists(db, "montral_billing_event");
  const addIntentConsumedAt = hasIntent && !await columnExists(db, "montral_billing_intent", "consumed_at");
  const createIntentIndex = !await relationExists(db, "montral_billing_intent_pending");
  const addSubscriptionEndsAt = hasSubscription && !await columnExists(db, "montral_subscription", "ends_at");
  // Billing lifecycle (catalog-driven plans, payment state and grace). Plan ids
  // come from the operator catalog, so the hard-coded plan CHECK of earlier
  // versions is replaced by a plan-id FORMAT check on both tables.
  const addPaymentColumns = hasSubscription && !await columnExists(db, "montral_subscription", "payment_state");
  const addSubscriptionPlanFormat = hasSubscription && !await constraintExists(db, "montral_subscription", "montral_subscription_plan_format");
  const replaceIntentPlanCheck = hasIntent && !await constraintExists(db, "montral_billing_intent", "montral_billing_intent_plan_format");
  const addEventDuplicateAudit = hasEvent && !await columnExists(db, "montral_billing_event", "duplicate_audited_at");
  // Genuine upgrade of existing tables: take every lock this migration needs
  // up front, in the checkout function's order (subscription, then intent),
  // then the event ledger (which no checkout touches).
  const upgrade = [
    (addSubscriptionEndsAt || addPaymentColumns || addSubscriptionPlanFormat) && "montral_subscription",
    (addIntentConsumedAt || (hasIntent && createIntentIndex) || replaceIntentPlanCheck) && "montral_billing_intent",
    addEventDuplicateAudit && "montral_billing_event",
  ].filter((name): name is string => !!name);
  if (upgrade.length) await db.query(`LOCK TABLE ${upgrade.join(", ")} IN ACCESS EXCLUSIVE MODE`);
  await db.query(`CREATE TABLE IF NOT EXISTS montral_billing_intent (
    id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    created_by text NOT NULL,
    plan text NOT NULL CONSTRAINT montral_billing_intent_plan_format CHECK (plan ~ '^[a-z][a-z0-9_-]{0,31}$'),
    variant_id text NOT NULL, expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(), consumed_at timestamptz
  )`);
  if (addIntentConsumedAt) {
    await db.query("ALTER TABLE montral_billing_intent ADD COLUMN IF NOT EXISTS consumed_at timestamptz");
  }
  if (replaceIntentPlanCheck) {
    // Previous-release replicas only ever insert 'pro'/'business', which the
    // format check admits, so dropping the fixed check cannot break them.
    for (const name of await legacyIntentPlanChecks(db)) {
      await db.query(`ALTER TABLE montral_billing_intent DROP CONSTRAINT IF EXISTS ${quoteIdent(name)}`);
    }
    await db.query(`ALTER TABLE montral_billing_intent ADD CONSTRAINT montral_billing_intent_plan_format
      CHECK (plan ~ '^[a-z][a-z0-9_-]{0,31}$')`);
  }
  if (createIntentIndex) {
    await db.query(`CREATE INDEX IF NOT EXISTS montral_billing_intent_pending
      ON montral_billing_intent (organization_id,expires_at) WHERE consumed_at IS NULL`);
  }
  // Atomically reserve a single unexpired checkout per workspace. This lock is
  // scoped to the workspace, so independent customers are never serialized.
  // A new name: the previous release's montral_reserve_billing_intent (fixed
  // plan ids) is left exactly as that release defines it.
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_reserve_billing_intent_v2(
      p_id uuid, p_org text, p_creator text, p_plan text, p_variant text
    ) RETURNS boolean LANGUAGE plpgsql AS $montral$
    BEGIN
      -- Plan ids come from the operator catalog; the API admits only catalog
      -- plans with a provider variant. Here, only their format is enforced.
      IF p_plan IS NULL OR p_plan !~ '^[a-z][a-z0-9_-]{0,31}$' OR p_variant IS NULL OR p_variant !~ '^[0-9]{1,24}$' THEN
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
    provider_id text NOT NULL UNIQUE, variant_id text NOT NULL,
    plan text NOT NULL CONSTRAINT montral_subscription_plan_format CHECK (plan ~ '^[a-z][a-z0-9_-]{0,31}$'),
    status text NOT NULL, test_mode boolean NOT NULL DEFAULT true,
    ends_at timestamptz, provider_updated_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    payment_state text CHECK (payment_state IN ('paid','failed','refunded')),
    payment_updated_at timestamptz, past_due_since timestamptz
  )`);
  if (addSubscriptionEndsAt) {
    await db.query("ALTER TABLE montral_subscription ADD COLUMN IF NOT EXISTS ends_at timestamptz");
  }
  if (addPaymentColumns) {
    // payment_state: the latest subscription-invoice outcome (NULL: none seen);
    // payment_updated_at: that invoice's provider clock (ordered separately from
    // the subscription's own provider_updated_at); past_due_since: the first
    // failed payment of the current past-due spell, from which grace is counted.
    await db.query(`ALTER TABLE montral_subscription
      ADD COLUMN IF NOT EXISTS payment_state text CHECK (payment_state IN ('paid','failed','refunded')),
      ADD COLUMN IF NOT EXISTS payment_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS past_due_since timestamptz`);
  }
  if (addSubscriptionPlanFormat) {
    await db.query(`ALTER TABLE montral_subscription ADD CONSTRAINT montral_subscription_plan_format
      CHECK (plan ~ '^[a-z][a-z0-9_-]{0,31}$')`);
  }
  // Older subscriptions can predate the past_due_since column or a prior
  // migration can have left it NULL. Recover the earliest *recorded* failure
  // clock, never NOW(): a restart must not manufacture a fresh grace period.
  // If an invoice failure has no timestamp and no past_due subscription status,
  // leave NULL (fail closed). Paid/refunded and non-test subscriptions are not
  // eligible for this preview-only backfill. The conditional UPDATE takes no
  // row locks on healthy subscriptions and is idempotent on every restart.
  await db.query(`
    UPDATE montral_subscription SET past_due_since =
      CASE
        WHEN status = 'past_due' AND payment_state = 'failed'
          THEN LEAST(provider_updated_at, payment_updated_at)
        WHEN status = 'past_due' THEN provider_updated_at
        ELSE payment_updated_at
      END
    WHERE test_mode = true AND past_due_since IS NULL
      AND status IN ('active', 'on_trial', 'past_due')
      AND (status = 'past_due' OR payment_state = 'failed')
      AND payment_state IS DISTINCT FROM 'refunded'
      -- Use NULL-safe predicates: legacy records have payment_state=NULL,
      -- and NOT(NULL) is NULL in SQL, not TRUE. A recorded successful
      -- payment newer than the status is the only excluded paid case.
      AND (status <> 'past_due' OR payment_state IS DISTINCT FROM 'paid'
        OR (payment_updated_at IS NOT NULL AND payment_updated_at < provider_updated_at))
      AND (status = 'past_due' OR payment_updated_at IS NOT NULL)
  `);
  // An earlier checkout preview (before the previous release) exposed a
  // seven-argument SQL function that no supported release calls any more.
  await db.query("DROP FUNCTION IF EXISTS montral_apply_billing_event(text,text,text,text,text,timestamptz,uuid)");
  await db.query(`CREATE TABLE IF NOT EXISTS montral_billing_event (
    digest char(64) PRIMARY KEY, provider_id text NOT NULL, name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(), duplicate_audited_at timestamptz
  )`);
  if (addEventDuplicateAudit) {
    // When a redelivery of this digest was first audited: later identical
    // redeliveries are answered "duplicate" without another audit row.
    await db.query("ALTER TABLE montral_billing_event ADD COLUMN IF NOT EXISTS duplicate_audited_at timestamptz");
  }
  // A development build of this release defined montral_billing_apply with a
  // shorter result row; CREATE OR REPLACE cannot change a result type.
  if ((await db.query(`SELECT 1 AS found FROM pg_proc
      WHERE proname = 'montral_billing_apply' AND NOT ('r_plan_kept' = ANY (COALESCE(proargnames, ARRAY[]::text[])))`)).length) {
    await db.query("DROP FUNCTION IF EXISTS montral_billing_apply(text,text,text,text,text,text,timestamptz,uuid,timestamptz,text)");
  }
  await db.query(`
    CREATE OR REPLACE FUNCTION montral_billing_apply(
      p_digest text, p_event text, p_provider text, p_variant text, p_plan text,
      p_status text, p_updated timestamptz, p_intent uuid, p_ends timestamptz, p_payment text
    ) RETURNS TABLE (r_outcome text, r_org text, r_plan text, r_status text, r_audit boolean, r_plan_kept boolean)
    LANGUAGE plpgsql AS $montral$
    DECLARE target_org text; target_plan text; expected_variant text; current_status text;
            current_variant text; current_updated timestamptz; plan_kept boolean := false;
            inserted_count integer; changed_count integer := 0; first_redelivery integer;
            strictness text[] := ARRAY['on_trial','active','paused','past_due','unpaid','cancelled','expired']::text[];
            payment_strictness text[] := ARRAY['paid','failed','refunded']::text[];
    BEGIN
      -- A single database transaction covers identity resolution, deduplication
      -- and the subscription update; no event is "consumed" before an update commits.
      -- p_payment NULL: a subscription event (status/variant/plan); otherwise a
      -- subscription-invoice payment outcome that changes only the payment state.
      -- r_audit: whether the caller records this outcome in the audit log (a
      -- redelivered digest is audited once, not on every further redelivery).
      IF EXISTS (SELECT 1 FROM montral_billing_event WHERE digest=p_digest) THEN
        UPDATE montral_billing_event SET duplicate_audited_at=NOW()
          WHERE digest=p_digest AND duplicate_audited_at IS NULL;
        GET DIAGNOSTICS first_redelivery = ROW_COUNT;
        RETURN QUERY SELECT 'duplicate'::text, s.organization_id, s.plan, s.status, first_redelivery > 0, false
          FROM montral_subscription s WHERE s.provider_id=p_provider;
        IF NOT FOUND THEN RETURN QUERY SELECT 'duplicate'::text, NULL::text, NULL::text, NULL::text, false, false; END IF;
        RETURN;
      END IF;
      IF p_event = 'subscription_created' THEN
        SELECT i.organization_id, i.plan, i.variant_id
          INTO target_org, target_plan, expected_variant
          FROM montral_billing_intent i
          WHERE i.id=p_intent AND i.expires_at > NOW() AND i.consumed_at IS NULL FOR UPDATE;
        IF target_org IS NULL THEN
          RETURN QUERY SELECT 'unmatched'::text, NULL::text, NULL::text, NULL::text, false, false; RETURN;
        END IF;
        IF expected_variant <> p_variant THEN
          RETURN QUERY SELECT 'unmatched'::text, target_org, NULL::text, NULL::text, true, false; RETURN;
        END IF;
        -- Multiple intents may exist from older preview versions. A second
        -- provider must not replace an active subscription. Serialize with
        -- the checkout reservation lock, then reread after locking.
        PERFORM pg_advisory_xact_lock(hashtextextended('montral:checkout:' || target_org, 0));
        IF EXISTS (
          SELECT 1 FROM montral_subscription s
          WHERE s.organization_id=target_org AND s.provider_id<>p_provider AND s.status<>'expired'
        ) THEN
          RETURN QUERY SELECT 'unmatched'::text, target_org, NULL::text, NULL::text, true, false; RETURN;
        END IF;
      ELSE
        SELECT s.organization_id, s.status, s.variant_id, s.provider_updated_at
          INTO target_org, current_status, current_variant, current_updated
          FROM montral_subscription s WHERE s.provider_id=p_provider FOR UPDATE;
        IF target_org IS NULL THEN
          RETURN QUERY SELECT 'unmatched'::text, NULL::text, NULL::text, NULL::text, false, false; RETURN;
        END IF;
        -- A subscription event whose variant the catalog does not map (p_plan
        -- NULL; e.g. the variant was removed from the catalog) still applies its
        -- status, deadline and clock: a cancellation or expiry must always take
        -- effect. Only the PLAN CHANGE is refused: plan and variant stay.
        plan_kept := p_payment IS NULL AND p_plan IS NULL
          AND p_variant IS DISTINCT FROM current_variant AND current_updated < p_updated;
      END IF;
      INSERT INTO montral_billing_event(digest,provider_id,name)
        VALUES(p_digest,p_provider,p_event) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS inserted_count = ROW_COUNT;
      IF inserted_count = 0 THEN
        -- a concurrent delivery of the same digest committed first
        RETURN QUERY SELECT 'duplicate'::text, s.organization_id, s.plan, s.status, false, false
          FROM montral_subscription s WHERE s.organization_id=target_org;
        RETURN;
      END IF;
      IF p_event = 'subscription_created' THEN
        UPDATE montral_billing_intent SET consumed_at=NOW() WHERE id=p_intent;
        INSERT INTO montral_subscription(organization_id,provider_id,variant_id,plan,status,test_mode,provider_updated_at,ends_at,
            payment_state,payment_updated_at,past_due_since)
          VALUES (target_org,p_provider,p_variant,target_plan,p_status,true,p_updated,p_ends,
            NULL,NULL,CASE WHEN p_status='past_due' THEN p_updated END)
        ON CONFLICT (organization_id) DO UPDATE SET
          provider_id=EXCLUDED.provider_id, variant_id=EXCLUDED.variant_id,
          plan=EXCLUDED.plan,status=EXCLUDED.status,provider_updated_at=EXCLUDED.provider_updated_at,
          ends_at=EXCLUDED.ends_at,updated_at=NOW(),
          -- a replacement subscription starts with no payment history; the same
          -- provider keeps its own (an invoice may have been seen first)
          payment_state=CASE WHEN montral_subscription.provider_id <> EXCLUDED.provider_id THEN NULL ELSE montral_subscription.payment_state END,
          payment_updated_at=CASE WHEN montral_subscription.provider_id <> EXCLUDED.provider_id THEN NULL ELSE montral_subscription.payment_updated_at END,
          past_due_since=CASE
            WHEN montral_subscription.provider_id <> EXCLUDED.provider_id THEN EXCLUDED.past_due_since
            WHEN EXCLUDED.status='past_due' THEN COALESCE(montral_subscription.past_due_since, EXCLUDED.provider_updated_at)
            WHEN montral_subscription.payment_state='failed' THEN montral_subscription.past_due_since
            ELSE NULL END
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
              array_position(strictness, EXCLUDED.status) > array_position(strictness, montral_subscription.status)
              OR (EXCLUDED.status='cancelled' AND montral_subscription.status='cancelled'
                AND montral_subscription.ends_at IS NOT NULL
                AND (EXCLUDED.ends_at IS NULL OR EXCLUDED.ends_at < montral_subscription.ends_at))
            ))
          ))
        );
        GET DIAGNOSTICS changed_count = ROW_COUNT;
      ELSIF current_status = 'expired' THEN
        -- Expiry is terminal for a provider subscription (Lemon Squeezy: ended
        -- after cancellation or completed dunning). Nothing revives it; a new
        -- checkout creates a new provider subscription.
        changed_count := 0;
      ELSIF p_payment IS NULL THEN
        UPDATE montral_subscription s SET
            status=p_status, ends_at=p_ends, updated_at=NOW(),
            -- a plan change (another catalog variant) applies only from a strictly
            -- newer provider update and only for a variant the catalog maps; an
            -- equal-timestamp tie or an unmapped variant never changes the plan
            variant_id=CASE WHEN s.provider_updated_at < p_updated AND p_plan IS NOT NULL THEN p_variant ELSE s.variant_id END,
            plan=CASE WHEN s.provider_updated_at < p_updated AND p_plan IS NOT NULL THEN p_plan ELSE s.plan END,
            -- the provider reporting the subscription active/on_trial on a strictly
            -- newer update than the last failed invoice ends that failure (a lost
            -- payment-success event must not downgrade a paying customer)
            payment_state=CASE
              WHEN s.payment_state='failed' AND p_status IN ('active','on_trial')
                AND s.provider_updated_at < p_updated AND (s.payment_updated_at IS NULL OR s.payment_updated_at < p_updated)
              THEN NULL ELSE s.payment_state END,
            past_due_since=CASE
              WHEN p_status='past_due' THEN COALESCE(s.past_due_since, p_updated)
              WHEN s.payment_state='failed' AND NOT (p_status IN ('active','on_trial')
                AND s.provider_updated_at < p_updated AND (s.payment_updated_at IS NULL OR s.payment_updated_at < p_updated))
              THEN s.past_due_since
              ELSE NULL END,
            provider_updated_at=p_updated
          WHERE s.provider_id=p_provider AND (
            s.provider_updated_at < p_updated
            OR (s.provider_updated_at = p_updated AND (
              array_position(strictness, p_status) > array_position(strictness, s.status)
              OR (p_status='cancelled' AND s.status='cancelled' AND s.ends_at IS NOT NULL
                AND (p_ends IS NULL OR p_ends < s.ends_at))
            ))
          );
        GET DIAGNOSTICS changed_count = ROW_COUNT;
      ELSE
        -- Invoice clock: ordered by the invoice's provider updated_at, separately
        -- from the subscription clock. A tie admits only a stricter outcome.
        UPDATE montral_subscription s SET
            payment_state=p_payment, payment_updated_at=p_updated, updated_at=NOW(),
            past_due_since=CASE
              WHEN p_payment='failed' THEN COALESCE(s.past_due_since, p_updated)
              -- a success ends the past-due spell unless the subscription itself
              -- reported past_due after this payment
              WHEN p_payment='paid' AND NOT (s.status='past_due' AND s.provider_updated_at > p_updated) THEN NULL
              ELSE s.past_due_since END
          WHERE s.provider_id=p_provider AND (
            s.payment_updated_at IS NULL OR s.payment_updated_at < p_updated
            OR (s.payment_updated_at = p_updated
              AND array_position(payment_strictness, p_payment) > array_position(payment_strictness, s.payment_state))
          );
        GET DIAGNOSTICS changed_count = ROW_COUNT;
      END IF;
      -- Digest remains in the replay ledger even if this valid signed event
      -- is older, or tied in timestamp and not more restrictive.
      RETURN QUERY SELECT CASE WHEN changed_count = 0 THEN 'stale' ELSE 'applied' END::text,
          s.organization_id, s.plan, s.status, true, plan_kept AND changed_count > 0
        FROM montral_subscription s WHERE s.organization_id=target_org;
      IF NOT FOUND THEN
        RETURN QUERY SELECT CASE WHEN changed_count = 0 THEN 'stale' ELSE 'applied' END::text, target_org, NULL::text, NULL::text, true, false;
      END IF;
    END;
    $montral$
  `);
  return ["montral_billing_test_preview_v1", "montral_billing_lifecycle_v1"];
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

type ProviderPayload = {
  meta?: { event_name?: unknown; custom_data?: { montral_intent?: unknown } };
  data?: { type?: unknown; id?: unknown; attributes?: {
    store_id?: unknown; variant_id?: unknown; status?: unknown; test_mode?: unknown;
    updated_at?: unknown; ends_at?: unknown; subscription_id?: unknown;
  } };
};

/** A verified subscription event: changes status, deadline and (through the variant) the plan. */
export type SubscriptionEvent = {
  kind: "subscription"; name: string; id: string; variant: string; status: string;
  updated: string; endsAt: string | null; intent: string | null;
};
/** A verified subscription-invoice payment outcome: changes only the payment state of subscription `id`. */
export type PaymentEvent = { kind: "payment"; name: string; id: string; payment: PaymentState; updated: string };
export type BillingEvent = SubscriptionEvent | PaymentEvent;

const validTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Fail closed when provenance, checkout identity or state cannot be confirmed. */
export function parseSubscriptionEvent(raw: unknown, env: Bindings): BillingEvent | null {
  const payload = raw as ProviderPayload | null;
  const name = payload?.meta?.event_name;
  if (typeof name !== "string") return null;
  const attrs = payload?.data?.attributes;
  const store = stringId(attrs?.store_id);
  if (!store || store !== env.LEMONSQUEEZY_STORE_ID || attrs?.test_mode !== true) return null;
  if (!validTime(attrs.updated_at)) return null;
  const updated = new Date(attrs.updated_at).toISOString();
  const payment = Object.prototype.hasOwnProperty.call(PAYMENT_EVENTS, name) ? PAYMENT_EVENTS[name] : undefined;
  if (payment) {
    // Subscription invoice object: `subscription_id` links it to the stored
    // subscription; it carries no variant. Its documented `status` must agree
    // with the event (a success is a paid invoice; a refund a (partially)
    // refunded one), otherwise the event is refused rather than interpreted.
    if (payload?.data?.type !== "subscription-invoices") return null;
    const subscription = stringId(attrs.subscription_id);
    if (!subscription || typeof attrs.status !== "string" || !INVOICE_STATUSES.has(attrs.status)) return null;
    if (payment === "paid" && attrs.status !== "paid") return null;
    if (payment === "refunded" && attrs.status !== "refunded" && attrs.status !== "partial_refund") return null;
    return { kind: "payment", name, id: subscription, payment, updated };
  }
  if (!SUB_EVENTS.has(name) || payload?.data?.type !== "subscriptions") return null;
  const id = stringId(payload.data.id);
  const variant = stringId(attrs.variant_id);
  if (!id || !variant) return null;
  if (typeof attrs.status !== "string" || !SUBSCRIPTION_STATUS.test(attrs.status)) return null;
  const endValue = attrs.ends_at;
  // Provider cancellation is only paid through ends_at. Invalid dates cannot
  // extend benefits; absence means an immediate fallback to the default plan.
  if (endValue !== undefined && endValue !== null && !validTime(endValue)) return null;
  const endsAt = typeof endValue === "string" ? new Date(endValue).toISOString() : null;
  const intent = payload.meta?.custom_data?.montral_intent;
  if (name === "subscription_created" && (typeof intent !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(intent))) return null;
  return {
    kind: "subscription", name, id, variant, status: attrs.status, updated, endsAt,
    intent: typeof intent === "string" ? intent : null,
  };
}

export type BillingOutcome = "applied" | "stale" | "duplicate" | "unmatched";
const OUTCOMES = new Set<BillingOutcome>(["applied", "stale", "duplicate", "unmatched"]);

/**
 * Applies one verified billing event through the single monotonic SQL path (montral_billing_apply) and records what
 * happened in the workspace's audit log: `billing.event_applied` for a state change, `billing.event_ignored` for a
 * stale or duplicate event (the state it left unchanged; a redelivered digest is audited once), and
 * `billing.event_unmatched` for a creation whose checkout intent does not match. A subscription event naming a variant
 * the catalog does not map still applies its status and deadline; only the plan change is refused (audited as applied
 * with reason `unmapped_variant_plan_kept`). An event whose workspace cannot be identified is not audited (there is no
 * workspace log to write to). Audit values hold only status, plan and event type: no amounts, no customer data.
 */
export async function applyBillingEvent(db: Database, map: BillingPlanMap, event: BillingEvent, digest: string): Promise<BillingOutcome> {
  const isSubscription = event.kind === "subscription";
  const plan = isSubscription ? map.planForVariant(event.variant) : null;
  const rows = await db.query<{ r_outcome: string; r_org: string | null; r_plan: string | null; r_status: string | null; r_audit: boolean; r_plan_kept: boolean }>(
    "SELECT r_outcome,r_org,r_plan,r_status,r_audit,r_plan_kept FROM montral_billing_apply($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::uuid,$9::timestamptz,$10)",
    [
      digest, event.name, event.id,
      isSubscription ? event.variant : null, plan,
      isSubscription ? event.status : null, event.updated,
      isSubscription ? event.intent : null, isSubscription ? event.endsAt : null,
      isSubscription ? null : event.payment,
    ],
  );
  const row = rows[0];
  const outcome = (row && OUTCOMES.has(row.r_outcome as BillingOutcome) ? row.r_outcome : "unmatched") as BillingOutcome;
  // r_audit is false for further redeliveries of an already audited digest (audited once, not on every retry)
  if (row?.r_org && row.r_audit !== false) {
    const action = outcome === "applied" ? "billing.event_applied" : outcome === "unmatched" ? "billing.event_unmatched" : "billing.event_ignored";
    try {
      await recordAuditEvent((sql, params) => db.query(sql, params), {
        orgId: row.r_org, projectId: null,
        actor: { type: "system", id: null, label: "Billing provider" },
        action, targetType: "subscription", targetId: event.id,
        changes: { fields: ["plan", "status"], values: {
          status: row.r_status, plan: row.r_plan, type: event.name,
          // applied with an unmapped variant: status/deadline applied, the plan change refused (plan kept)
          ...(outcome === "applied" ? (row.r_plan_kept ? { reason: "unmapped_variant_plan_kept" } : {}) : { reason: outcome }),
        } },
        ip: null,
      });
    } catch {
      // Best effort, as for every audit event: the billing state already committed.
      console.error("billing audit event could not be recorded; private diagnostics suppressed");
    }
  }
  return outcome;
}

/** A subscription as the provider reports it now (e.g. from its API), for an operator reconciliation job. */
export type SubscriptionSnapshot = {
  providerId: string; status: string; variantId: string; updatedAt: string; endsAt: string | null;
};

/**
 * Reconciliation hook: applies a provider subscription snapshot through the same monotonic path as a signed webhook,
 * so a lost or delayed `subscription_updated` can be repaired later. It can only update a subscription Montral already
 * linked through a verified checkout (never create one), an older or equal-and-less-strict snapshot is stale, a
 * variant the catalog does not map applies status and deadline but keeps the plan, and the same snapshot twice is a
 * duplicate. Makes no network call: the caller fetches
 * the snapshot (none does yet; no operator job is scheduled in this preview).
 */
export async function reconcileSubscription(db: Database, env: Bindings, snapshot: SubscriptionSnapshot): Promise<BillingOutcome | "invalid" | "not_configured"> {
  const id = stringId(snapshot.providerId);
  const variant = stringId(snapshot.variantId);
  if (!id || !variant || !SUBSCRIPTION_STATUS.test(snapshot.status) || !validTime(snapshot.updatedAt)) return "invalid";
  if (snapshot.endsAt !== null && !validTime(snapshot.endsAt)) return "invalid";
  const map = await billingPlanMap(env);
  if (!map) return "not_configured";
  const event: SubscriptionEvent = {
    kind: "subscription", name: "subscription_reconciled", id, variant, status: snapshot.status,
    updated: new Date(snapshot.updatedAt).toISOString(),
    endsAt: snapshot.endsAt === null ? null : new Date(snapshot.endsAt).toISOString(), intent: null,
  };
  // The digest names the snapshot's content, so re-running a job over an unchanged subscription is a duplicate.
  const digest = await sha256(new TextEncoder().encode(
    `montral-reconcile:${event.id}:${event.variant}:${event.status}:${event.updated}:${event.endsAt ?? ""}`));
  return applyBillingEvent(db, map, event, digest);
}

/** A signed callback's HMAC covers exact bytes; allow only bounded memory
 * and one total wall-clock upload interval before verifying any signature.
 * The test-only timeout override is never supplied by mounted HTTP routes. */
export async function limitedBody(req: Request, timeoutMs = BODY_READ_TIMEOUT_MS, maxBytes = BODY_LIMIT): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length")) > maxBytes) {
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
      if (bytes > maxBytes) return null;
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
    // Plans come from the catalog; an invalid catalog fails closed (503, the provider retries later), never a guess.
    let map: BillingPlanMap | null;
    try {
      map = await billingPlanMap(c.env);
    } catch {
      return c.json({ error: "Billing plans are unavailable" }, 503);
    }
    if (!map) return c.json({ error: "Not configured" }, 404);
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
    const outcome = await applyBillingEvent(c.get("database"), map, event, await sha256(body));
    if (outcome === "unmatched") return c.json({ error: "Unknown subscription, checkout or plan variant" }, 409);
    return c.json({ ok: true, result: outcome }, 200);
  });

  const billing = new Router<AppEnv>();
  /** The plan map, or null when billing is off, unmapped or its catalog is invalid (fail closed). */
  const planMapOrNull = (env: Bindings) => billingPlanMap(env).catch(() => null);
  billing.get("/", requireManager, async (c) => {
    const rows = await c.get("database").query<SubscriptionEntitlementRow & { provider_updated_at: Date }>(
      `SELECT plan,status,test_mode,provider_updated_at,ends_at,payment_state,payment_updated_at,past_due_since
         FROM montral_subscription WHERE organization_id=$1`, [c.get("orgId")]);
    const map = await planMapOrNull(c.env);
    const row = rows[0];
    const grace = billingGraceDays(c.env);
    c.header("cache-control", "no-store");
    return c.json({ plan: row?.plan ?? map?.catalog.defaultPlan.id ?? "free", status: row?.status ?? "none",
      billingConfigured: !!map && map.variantForPlan.size > 0, providerUpdatedAt: row?.provider_updated_at ?? null,
      endsAt: row?.ends_at ?? null,
      // what the subscription grants right now (null: the default plan), and the end of a past-due grace period
      entitledPlan: entitledPlanId(row, Date.now(), grace),
      paymentState: row?.payment_state ?? null, graceEndsAt: graceEndsAt(row, grace) });
  });
  /**
   * The plans this deployment offers: id, name, and whether a test checkout can be opened for it. Prices are returned
   * only when the catalog has price metadata AND the owner published prices (MONTRAL_BILLING_SHOW_PRICES=true); by
   * default the response holds no price field at all.
   */
  billing.get("/plans", requireManager, async (c) => {
    c.header("cache-control", "no-store");
    let catalog: PlanCatalog;
    try {
      catalog = await cachedPlanCatalog(c.env);
    } catch {
      return c.json({ error: "Plans are unavailable" }, 503);
    }
    const map = await planMapOrNull(c.env);
    const showPrices = c.env.MONTRAL_BILLING_SHOW_PRICES === "true";
    return c.json({
      defaultPlan: catalog.defaultPlan.id,
      plans: [...catalog.plans.values()].map((p) => ({
        id: p.id, name: p.name,
        checkoutAvailable: !!map && map.variantForPlan.has(p.id),
        ...(showPrices && p.price ? { price: { amountMinor: p.price.amountMinor, currency: p.price.currency, interval: p.price.interval } } : {}),
      })),
    });
  });
  billing.post("/checkout", requireManager, async (c) => {
    const map = await planMapOrNull(c.env);
    if (!map || map.variantForPlan.size === 0) return c.json({ error: "Billing is unavailable" }, 503);
    // Refuse unbounded/slow plan-selection JSON before generating a one-time
    // checkout nonce or reserving a transaction. Reuse the byte-exact reader.
    let rawPlan: Uint8Array | null;
    try {
      rawPlan = await limitedBody(c.req.raw, BODY_READ_TIMEOUT_MS, CHECKOUT_BODY_LIMIT);
    } catch (error) {
      if (error instanceof BillingBodyTimeoutError) {
        c.header("cache-control", "no-store");
        c.header("referrer-policy", "no-referrer");
        c.header("x-content-type-options", "nosniff");
        return c.json({ error: "Checkout body read timeout" }, 408);
      }
      throw error;
    }
    if (rawPlan === null) {
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      c.header("x-content-type-options", "nosniff");
      return c.json({ error: "Payload too large" }, 413);
    }
    let plan: unknown;
    try {
      plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawPlan)) as unknown;
    } catch { return c.json({ error: "Invalid plan" }, 400); }
    const result = inputPlan.safeParse(plan);
    if (!result.success) return c.json({ error: "Invalid plan" }, 400);
    // Any catalog plan with a provider variant can be bought (never the default plan); anything else is unknown.
    const variant = map.variantForPlan.get(result.data.plan);
    if (!variant) return c.json({ error: "Invalid plan" }, 400);
    const id = crypto.randomUUID();
    // Advisory-locked SQL reservation makes a single pending test checkout per
    // workspace, even across different Node/Worker processes and connections.
    // The intent is committed before contacting the provider for callback safety.
    const reservation = await c.get("database").query<{ reserved: boolean }>(
      "SELECT montral_reserve_billing_intent_v2($1::uuid,$2::text,$3::text,$4::text,$5::text) AS reserved",
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
