import { z } from "zod";

/**
 * The plan catalog: which plans a metered (cloud) deployment offers and what each allows. It is operator configuration,
 * supplied at deployment time (MONTRAL_PLAN_CONFIG, a file path on Node; MONTRAL_PLAN_CONFIG_JSON, the document itself,
 * e.g. a Workers secret) and kept out of source control. Without one, the built-in sandbox catalog below applies: the
 * preview limits documented in docs/BILLING-SANDBOX.md, not a commercial offer.
 *
 * Fail closed: a catalog that is present but invalid is never replaced by a guess. `loadPlanCatalog` throws (the Node
 * server refuses to start; on Workers every metered request fails), so a broken file can neither grant paid access nor
 * lift a limit. Error messages name the offending path, never a value (prices and allowances stay private).
 *
 * The Community (self-hosted) edition is unmetered and never reads a catalog.
 */

export const PLAN_CATALOG_SCHEMA_VERSION = 1;
/** Upper bound for every count and allowance: far beyond any real plan, well inside PostgreSQL's integer for usage. */
const MAX_COUNT = 2_000_000_000;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,31}$/;
/** A provider variant id: a positive decimal number written as a string (Lemon Squeezy variant ids are integers). */
const PROVIDER_VARIANT = /^[1-9][0-9]{0,23}$/;

const count = z.number().int().min(0).max(MAX_COUNT);
const limitsSchema = z.object({
  /** monitors that may be active (not paused) at once */
  activeMonitors: count,
  /** fastest interval a monitor may use, in seconds */
  minIntervalSec: z.number().int().min(60).max(86_400),
  /** regions a monitor may check from at once */
  regions: z.number().int().min(1).max(64),
  /** monthly outbound-check credits (one per regional check attempt) */
  credits: count,
  /** monthly notification emails (alerts and status-page subscriber mails) */
  emails: count,
  /**
   * monthly webhook requests the public receiver captures (one per stored event). Optional for compatibility with
   * catalogs written before it existed: absent means METER_DEFAULTS.webhookEvents (the built-in Free value), never
   * unlimited.
   */
  webhookEvents: count.optional(),
  /**
   * monthly browser-check runtime in seconds (reserved at each journey's configured timeout, unused seconds given back).
   * Optional like webhookEvents: absent means METER_DEFAULTS.browserSeconds, never unlimited.
   */
  browserSeconds: count.optional(),
}).strict();

const priceSchema = z.object({
  /** amount in the currency's minor unit (cents); metadata only, never logged */
  amountMinor: count,
  currency: z.string().regex(/^[A-Z]{3}$/),
  interval: z.enum(["month", "year"]),
}).strict();

const planSchema = z.object({
  id: z.string().regex(PLAN_ID),
  name: z.string().trim().min(1).max(60),
  limits: limitsSchema,
  /** features this plan includes; only features Montral enforces are accepted (see FEATURES) */
  features: z.array(z.enum(["hideBranding"])).max(16).default([]),
  price: priceSchema.optional(),
  /**
   * The billing provider's variant ids that subscribe a workspace to this plan (numeric strings, unique across plans).
   * Optional: a catalog without any variants uses the environment fallback (LEMONSQUEEZY_VARIANT_PRO/_BUSINESS).
   */
  providerVariants: z.array(z.string().regex(PROVIDER_VARIANT)).max(16).optional(),
}).strict();

const overrideSchema = z.object({
  organizationId: z.string().min(1).max(200),
  /** the plan this workspace is on regardless of its subscription (e.g. an enterprise contract) */
  plan: z.string().regex(PLAN_ID).optional(),
  /** individual limits replacing the plan's for this workspace */
  limits: limitsSchema.partial().optional(),
  /** why, for the audit trail (no commercial terms) */
  note: z.string().max(200).optional(),
}).strict();

const catalogSchema = z.object({
  schemaVersion: z.literal(PLAN_CATALOG_SCHEMA_VERSION),
  /** the operator's label for this catalog revision, reported with the content hash */
  version: z.string().trim().min(1).max(64),
  /** the plan a workspace without a valid subscription is on (the most restrictive one, usually free) */
  defaultPlan: z.string().regex(PLAN_ID),
  plans: z.array(planSchema).min(1).max(32),
  overrides: z.array(overrideSchema).max(10_000).default([]),
}).strict().superRefine((c, ctx) => {
  const ids = new Set<string>();
  c.plans.forEach((p, i) => {
    if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["plans", i, "id"], message: "duplicate plan id" });
    ids.add(p.id);
  });
  if (!ids.has(c.defaultPlan)) ctx.addIssue({ code: "custom", path: ["defaultPlan"], message: "names no plan" });
  // a variant subscribes to exactly one plan, and the default plan (what a workspace without a subscription gets) is
  // never sold: a purchase must always move a workspace off it
  const variants = new Set<string>();
  c.plans.forEach((p, i) => {
    if (p.id === c.defaultPlan && p.providerVariants?.length) ctx.addIssue({ code: "custom", path: ["plans", i, "providerVariants"], message: "the default plan cannot have provider variants" });
    p.providerVariants?.forEach((v, j) => {
      if (variants.has(v)) ctx.addIssue({ code: "custom", path: ["plans", i, "providerVariants", j], message: "duplicate provider variant" });
      variants.add(v);
    });
  });
  const orgs = new Set<string>();
  c.overrides.forEach((o, i) => {
    if (o.plan !== undefined && !ids.has(o.plan)) ctx.addIssue({ code: "custom", path: ["overrides", i, "plan"], message: "names no plan" });
    if (orgs.has(o.organizationId)) ctx.addIssue({ code: "custom", path: ["overrides", i, "organizationId"], message: "duplicate override" });
    orgs.add(o.organizationId);
  });
});

/** Limits as written in a catalog (the optional meters may be absent). */
export type PlanLimitsInput = z.infer<typeof limitsSchema>;
/** Limits as enforced: every meter has a number (absent optional meters filled from METER_DEFAULTS). */
export type PlanLimits = Required<PlanLimitsInput>;
export type PlanFeature = z.infer<typeof planSchema>["features"][number];
export type CatalogPlan = z.infer<typeof planSchema>;
export type PlanCatalogDocument = z.infer<typeof catalogSchema>;

export type PlanCatalog = {
  /** the operator's label plus a content hash: replicas serving different catalogs show different values */
  version: string;
  hash: string;
  source: "builtin" | "operator";
  defaultPlan: CatalogPlan;
  plans: ReadonlyMap<string, CatalogPlan>;
  /** true when any plan lists provider variants: billing then maps variants to plans through this catalog only */
  hasProviderVariants: boolean;
  /** the plan a provider variant subscribes to (null: the catalog does not sell this variant) */
  planForVariant(variantId: string): CatalogPlan | null;
  /** the effective plan and limits of a workspace whose subscription names `planId` (null: no valid subscription) */
  resolve(organizationId: string, planId: string | null): { plan: CatalogPlan; limits: PlanLimits; unknownPlan: boolean };
};

export class PlanCatalogError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid plan catalog: ${issues.slice(0, 10).join("; ")}`);
  }
}

/**
 * What a plan gets for a meter its catalog entry does not name (catalogs written before the meter existed): the
 * built-in Free plan's value below, the most conservative one. An omitted meter is therefore never unlimited; an
 * operator who wants more writes the number. Synthetic, not a commercial offer.
 */
export const METER_DEFAULTS = Object.freeze({ webhookEvents: 500, browserSeconds: 1800 });

/** The preview limits of the sandbox edition (docs/BILLING-SANDBOX.md). Synthetic, not a commercial offer. */
export const BUILTIN_SANDBOX_CATALOG: PlanCatalogDocument = {
  schemaVersion: PLAN_CATALOG_SCHEMA_VERSION,
  version: "builtin-sandbox",
  defaultPlan: "free",
  plans: [
    { id: "free", name: "Free", limits: { activeMonitors: 1, minIntervalSec: 600, regions: 1, credits: 4500, emails: 20, ...METER_DEFAULTS }, features: [] },
    { id: "pro", name: "Pro", limits: { activeMonitors: 5, minIntervalSec: 300, regions: 2, credits: 50000, emails: 200, webhookEvents: 5000, browserSeconds: 18000 }, features: [] },
    { id: "business", name: "Business", limits: { activeMonitors: 20, minIntervalSec: 60, regions: 3, credits: 250000, emails: 1000, webhookEvents: 25000, browserSeconds: 72000 }, features: ["hideBranding"] },
  ],
  overrides: [],
};

/** Stable JSON (sorted keys), so the hash names the content, not its formatting. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A validation message without anything taken from the document (quoted keys or values, "received ..."). */
const FIXED: Record<string, string> = { unrecognized_keys: "unknown field", invalid_value: "not an allowed value", invalid_union: "not an allowed value", invalid_key: "invalid key", invalid_element: "invalid entry" };
const safeMessage = (m: string) => m.replace(/,?\s*received.*$/i, "").replace(/"[^"]*"/g, "…").replace(/[,:;\s]+$/, "");

/** Validates a catalog document; issues name paths and rules, never the values found there. */
export function parsePlanCatalog(raw: unknown): PlanCatalogDocument {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) throw new PlanCatalogError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${FIXED[i.code] ?? safeMessage(i.message)}`));
  return parsed.data;
}

export async function buildPlanCatalog(doc: PlanCatalogDocument, source: PlanCatalog["source"]): Promise<PlanCatalog> {
  // frozen: callers share these objects, and a catalog never changes after it was built
  const frozen = doc.plans.map((p) => Object.freeze({
    ...p, limits: Object.freeze({ ...p.limits }), features: Object.freeze([...p.features]),
    ...(p.providerVariants ? { providerVariants: Object.freeze([...p.providerVariants]) } : {}),
  }) as CatalogPlan);
  const byVariant = new Map(frozen.flatMap((p) => (p.providerVariants ?? []).map((v) => [v, p] as const)));
  const plans = new Map(frozen.map((p) => [p.id, p] as const));
  const overrides = new Map(doc.overrides.map((o) => [o.organizationId, o] as const));
  const defaultPlan = plans.get(doc.defaultPlan)!;
  const hash = (await sha256(canonical(doc))).slice(0, 16);
  return {
    version: `${doc.version}@${hash}`,
    hash,
    source,
    defaultPlan,
    plans,
    hasProviderVariants: byVariant.size > 0,
    planForVariant: (variantId) => byVariant.get(variantId) ?? null,
    resolve(organizationId, planId) {
      const override = overrides.get(organizationId);
      const named = planId === null ? null : plans.get(planId) ?? null;
      // a subscription naming a plan the catalog no longer has gets the default (least) plan, never a guess
      const unknownPlan = planId !== null && named === null;
      const plan = (override?.plan ? plans.get(override.plan) : undefined) ?? named ?? defaultPlan;
      // an override's absent field keeps the plan's value; a plan's absent meter takes the conservative default
      const limits: PlanLimits = { ...METER_DEFAULTS, ...plan.limits, ...(override?.limits ?? {}) };
      return { plan, limits, unknownPlan };
    },
  };
}

/** The catalog a deployment configured: the operator's (validated, throws when invalid) or the built-in sandbox one. */
export async function loadPlanCatalog(env: { MONTRAL_PLAN_CONFIG_JSON?: string }): Promise<PlanCatalog> {
  const text = env.MONTRAL_PLAN_CONFIG_JSON;
  if (text === undefined || text.trim() === "") return buildPlanCatalog(BUILTIN_SANDBOX_CATALOG, "builtin");
  if (text.length > 4 * 1024 * 1024) throw new PlanCatalogError(["(root): longer than 4,194,304 characters"]);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PlanCatalogError(["(root): not valid JSON"]);
  }
  return buildPlanCatalog(parsePlanCatalog(raw), "operator");
}

/** One parsed catalog per document text (requests on Workers each build their entitlements). */
const cache = new Map<string, Promise<PlanCatalog>>();
/** An invalid catalog's failure is kept this long, so an outage does not re-parse a large document on every call. */
const FAILURE_TTL_MS = 60_000;
export function cachedPlanCatalog(env: { MONTRAL_PLAN_CONFIG_JSON?: string }): Promise<PlanCatalog> {
  const key = env.MONTRAL_PLAN_CONFIG_JSON ?? "";
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 4) cache.clear();
    hit = loadPlanCatalog(env);
    cache.set(key, hit);
    // a failure is reported again for a minute, then the document is parsed anew (a corrected secret is picked up)
    hit.catch(() => setTimeout(() => { if (cache.get(key) === hit) cache.delete(key); }, FAILURE_TTL_MS).unref?.());
  }
  return hit;
}
