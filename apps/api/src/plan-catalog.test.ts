import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SANDBOX_CATALOG, buildPlanCatalog, cachedPlanCatalog, implicitResourceMeterPaths, loadPlanCatalog, METER_DEFAULTS, parsePlanCatalog, PlanCatalogError } from "./plan-catalog";

/** Synthetic values only: they describe no real offer. */
const plan = (id: string, credits: number, extra: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), limits: { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits, emails: 7 }, ...extra,
});
const doc = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, version: "synthetic-1", defaultPlan: "alpha",
  plans: [plan("alpha", 111), plan("beta", 2222, { features: ["hideBranding"], price: { amountMinor: 1234, currency: "EUR", interval: "month" } })],
  ...over,
});
const issues = (raw: unknown) => {
  try {
    parsePlanCatalog(raw);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(PlanCatalogError);
    return (e as PlanCatalogError).issues;
  }
};

describe("plan catalog", () => {
  it("validates a catalog and resolves plans, defaults and overrides", async () => {
    const c = await buildPlanCatalog(parsePlanCatalog(doc({ overrides: [{ organizationId: "org-x", plan: "beta", limits: { credits: 5 }, note: "contract" }] })), "operator");
    expect(c.source).toBe("operator");
    expect(c.version).toMatch(/^synthetic-1@[0-9a-f]{16}$/);
    expect(c.resolve("org-1", null)).toMatchObject({ plan: { id: "alpha" }, limits: { credits: 111 }, unknownPlan: false });
    expect(c.resolve("org-1", "beta")).toMatchObject({ plan: { id: "beta" }, limits: { credits: 2222 } });
    // a subscription naming a plan the catalog does not have: the default (least) plan, flagged
    expect(c.resolve("org-1", "platinum")).toMatchObject({ plan: { id: "alpha" }, limits: { credits: 111 }, unknownPlan: true });
    // a per-workspace override wins over the subscription, field by field
    expect(c.resolve("org-x", null)).toMatchObject({ plan: { id: "beta" }, limits: { credits: 5, activeMonitors: 3 } });
    // plans are frozen: a caller cannot change what later lookups return
    expect(() => { (c.resolve("org-1", "beta").plan.limits as { credits: number }).credits = 1; }).toThrow();
    expect(c.resolve("org-1", "beta").limits.credits).toBe(2222);
  });

  it("accepts the optional resource meters, and fills an absent one with the conservative built-in default (never unlimited)", async () => {
    const withMeters = plan("beta", 2222, { limits: { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 2222, emails: 7, webhookEvents: 77, browserSeconds: 0 } });
    const c = await buildPlanCatalog(parsePlanCatalog(doc({
      plans: [plan("alpha", 111), withMeters],
      overrides: [{ organizationId: "org-x", limits: { webhookEvents: 9 } }],
    })), "operator");
    // a catalog written before the meters existed: the Free plan's values, whatever the plan
    expect(c.resolve("org-1", null).limits).toMatchObject({ credits: 111, webhookEvents: METER_DEFAULTS.webhookEvents, browserSeconds: METER_DEFAULTS.browserSeconds });
    // explicit values win, zero included (a plan without browser checks)
    expect(c.resolve("org-1", "beta").limits).toMatchObject({ webhookEvents: 77, browserSeconds: 0 });
    // an override changes only the meter it names
    expect(c.resolve("org-x", null).limits).toMatchObject({ webhookEvents: 9, browserSeconds: METER_DEFAULTS.browserSeconds });
    const free = BUILTIN_SANDBOX_CATALOG.plans.find((p) => p.id === BUILTIN_SANDBOX_CATALOG.defaultPlan)!;
    expect(free.limits).toMatchObject(METER_DEFAULTS);
    for (const p of BUILTIN_SANDBOX_CATALOG.plans) {
      expect(Number.isSafeInteger(p.limits.webhookEvents)).toBe(true);
      expect(Number.isSafeInteger(p.limits.browserSeconds)).toBe(true);
    }
    // the built-in catalog is itself valid
    expect(() => parsePlanCatalog(BUILTIN_SANDBOX_CATALOG)).not.toThrow();
  });

  it("warns once about implicit Free resource meters without exposing operator catalog data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A legacy priced catalog remains valid, but its missing meter fields are no longer silent.
      const legacy = parsePlanCatalog(doc({
        overrides: [{ organizationId: "private-workspace", note: "confidential-contract" }],
      }));
      expect(implicitResourceMeterPaths(legacy)).toEqual([
        "plans.0.limits.webhookEvents", "plans.0.limits.browserSeconds",
        "plans.1.limits.webhookEvents", "plans.1.limits.browserSeconds",
      ]);
      const loaded = await loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(legacy) });
      expect(loaded.resolve("unlisted", "beta").limits).toMatchObject(METER_DEFAULTS);
      expect(warn).toHaveBeenCalledTimes(1);
      const log = String(warn.mock.calls[0]?.[0]);
      expect(log).toContain("MONTRAL_CATALOG_IMPLICIT_METERS");
      expect(log).toContain("plans.1.limits.browserSeconds");
      expect(log).toMatch(/[a-f0-9]{16}/);
      expect(log).not.toMatch(/ALPHA|BETA|synthetic-1|1234|EUR|private-workspace|confidential-contract|2222/);

      // A complete operator catalog and the built-in sandbox catalog emit no warning.
      const complete = parsePlanCatalog(doc({
        plans: [plan("alpha", 1, { limits: { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 1, emails: 7, webhookEvents: 0, browserSeconds: 0 } })],
      }));
      expect(implicitResourceMeterPaths(complete)).toEqual([]);
      await loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(complete) });
      await loadPlanCatalog({});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("optionally resolves workspace status-page caps, including zero, without limiting legacy plans", async () => {
    const limited = plan("beta", 2222, { limits: { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 2222, emails: 7, statusPages: 2 } });
    const catalog = await buildPlanCatalog(parsePlanCatalog(doc({
      plans: [plan("alpha", 111), limited],
      overrides: [{ organizationId: "org-x", plan: "beta", limits: { statusPages: 0 } }],
    })), "operator");
    expect(catalog.resolve("other", null).limits.statusPages).toBeUndefined();
    expect(catalog.resolve("other", "beta").limits.statusPages).toBe(2);
    expect(catalog.resolve("org-x", null).limits.statusPages).toBe(0);
  });

  it("optionally caps webhook inboxes across projects, including zero and per-workspace overrides", async () => {
    const limited = plan("beta", 2222, { limits: {
      activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 2222, emails: 7, webhookInboxes: 3,
    } });
    const catalog = await buildPlanCatalog(parsePlanCatalog(doc({
      plans: [plan("alpha", 111), limited],
      overrides: [{ organizationId: "org-x", plan: "beta", limits: { webhookInboxes: 0 } }],
    })), "operator");
    expect(catalog.resolve("legacy", null).limits.webhookInboxes).toBeUndefined();
    expect(catalog.resolve("legacy", "beta").limits.webhookInboxes).toBe(3);
    expect(catalog.resolve("org-x", null).limits.webhookInboxes).toBe(0);
  });

  it("rejects invalid webhook-inbox caps in plan definitions and overrides", () => {
    const limits = { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 5, emails: 7 };
    for (const value of [-1, 1.5, null, "unlimited", 2_000_000_001]) {
      expect(issues(doc({ plans: [plan("alpha", 5, { limits: { ...limits, webhookInboxes: value } })] })).join("; "))
        .toContain("plans.0.limits.webhookInboxes");
    }
    expect(issues(doc({ overrides: [{ organizationId: "org-x", limits: { webhookInboxes: -1 } }] })).join("; "))
      .toContain("overrides.0.limits.webhookInboxes");
  });

  it("rejects invalid status-page caps in plans and overrides", () => {
    const limits = { activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 5, emails: 7 };
    expect(issues(doc({ plans: [plan("alpha", 5, { limits: { ...limits, statusPages: -1 } })] })).join("; ")).toContain("plans.0.limits.statusPages");
    expect(issues(doc({ overrides: [{ organizationId: "org-x", limits: { statusPages: 1.2 } }] })).join("; ")).toContain("overrides.0.limits.statusPages");
    expect(issues(doc({ plans: [plan("alpha", 5, { limits: { ...limits, statusPages: null } })] })).join("; ")).toContain("plans.0.limits.statusPages");
  });

  it("refuses invalid resource meter limits, naming the path but never the value", () => {
    const limits = (extra: Record<string, unknown>) => ({ activeMonitors: 3, minIntervalSec: 120, regions: 1, credits: 5, emails: 7, ...extra });
    const cases: [unknown, RegExp][] = [
      [doc({ plans: [plan("alpha", 1, { limits: limits({ webhookEvents: -1 }) })] }), /plans\.0\.limits\.webhookEvents/],
      [doc({ plans: [plan("alpha", 1, { limits: limits({ webhookEvents: 2.5 }) })] }), /plans\.0\.limits\.webhookEvents/],
      [doc({ plans: [plan("alpha", 1, { limits: limits({ browserSeconds: 3_000_000_000 }) })] }), /plans\.0\.limits\.browserSeconds/],
      [doc({ plans: [plan("alpha", 1, { limits: limits({ browserSeconds: "unlimited" }) })] }), /plans\.0\.limits\.browserSeconds/],
      [doc({ plans: [plan("alpha", 1, { limits: limits({ browserSeconds: null }) })] }), /plans\.0\.limits\.browserSeconds/],
      [doc({ overrides: [{ organizationId: "o", limits: { webhookEvents: -5 } }] }), /overrides\.0\.limits\.webhookEvents/],
    ];
    for (const [raw, rule] of cases) {
      const found = issues(raw);
      expect(found.join("; ")).toMatch(rule);
      expect(found.join(" ")).not.toMatch(/3000000000|unlimited/);
    }
  });

  it("refuses plan intervals below the API-supported 60-second floor, including overrides", () => {
    const tooFast = { activeMonitors: 3, minIntervalSec: 10, regions: 1, credits: 5, emails: 7 };
    expect(issues(doc({ plans: [plan("alpha", 5, { limits: tooFast })] })).join("; ")).toMatch(/plans\.0\.limits\.minIntervalSec/);
    expect(issues(doc({ overrides: [{ organizationId: "o", limits: { minIntervalSec: 10 } }] })).join("; ")).toMatch(/overrides\.0\.limits\.minIntervalSec/);
    expect(() => parsePlanCatalog(doc({ plans: [plan("alpha", 5, { limits: { ...tooFast, minIntervalSec: 60 } })] }))).not.toThrow();
  });

  it("names the same content with the same hash whatever the key order, and a change with another", async () => {
    const a = await buildPlanCatalog(parsePlanCatalog(doc()), "operator");
    const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(doc());
    const b = await buildPlanCatalog(parsePlanCatalog(reordered), "operator");
    const c = await buildPlanCatalog(parsePlanCatalog(doc({ plans: [plan("alpha", 112), doc().plans[1]] })), "operator");
    expect(b.hash).toBe(a.hash);
    expect(c.hash).not.toBe(a.hash);
  });

  it("refuses malformed catalogs, naming the path but never the value", () => {
    const cases: [unknown, RegExp][] = [
      [{ ...doc(), schemaVersion: 2 }, /schemaVersion/],
      [doc({ defaultPlan: "nope" }), /defaultPlan: names no plan/],
      [doc({ plans: [plan("alpha", -1)] }), /plans\.0\.limits\.credits/],
      [doc({ plans: [plan("alpha", 1.5)] }), /plans\.0\.limits\.credits/],
      [doc({ plans: [plan("alpha", 3_000_000_000)] }), /plans\.0\.limits\.credits/],
      [doc({ plans: [plan("alpha", 1), plan("alpha", 2)] }), /duplicate plan id/],
      [doc({ plans: [plan("Alpha!", 1)] }), /plans\.0\.id/],
      [doc({ plans: [plan("alpha", 1, { features: ["unlimitedEverything"] })] }), /plans\.0\.features/],
      [doc({ plans: [plan("alpha", 1, { surprise: true })] }), /plans\.0/],
      [doc({ plans: [plan("alpha", 1, { 'a"b"SECRET': 1 })] }), /plans\.0: unknown field/],
      [doc({ overrides: [{ organizationId: "o", plan: "ghost" }] }), /overrides\.0\.plan: names no plan/],
      [doc({ plans: [plan("alpha", 1, { price: { amountMinor: 5, currency: "usd", interval: "month" } })] }), /price\.currency/],
      [doc({ plans: [] }), /plans/],
      [null, /root|expected object/i],
    ];
    for (const [raw, rule] of cases) {
      const found = issues(raw);
      expect(found.join("; "), JSON.stringify(raw)?.slice(0, 80)).toMatch(rule);
      // values from the document never appear in the error
      expect(found.join(" ")).not.toMatch(/3000000000|1234|EUR|unlimitedEverything|surprise|ghost|SECRET/);
    }
  });

  it("loads the operator document, or the built-in sandbox catalog when none is configured; never a guess on failure", async () => {
    const builtin = await loadPlanCatalog({});
    expect(builtin.source).toBe("builtin");
    expect(builtin.defaultPlan.id).toBe(BUILTIN_SANDBOX_CATALOG.defaultPlan);
    expect((await loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: "  " })).source).toBe("builtin");
    expect((await loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(doc()) })).source).toBe("operator");
    await expect(loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: "{ not json" })).rejects.toThrow(/not valid JSON/);
    await expect(loadPlanCatalog({ MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(doc({ defaultPlan: "nope" })) })).rejects.toBeInstanceOf(PlanCatalogError);
  });

  it("maps provider variants to plans, validating format, uniqueness and the unsold default plan", async () => {
    // backward compatible: a v1 catalog without variants still loads, and maps nothing
    const plain = await buildPlanCatalog(parsePlanCatalog(doc()), "operator");
    expect(plain.hasProviderVariants).toBe(false);
    expect(plain.planForVariant("901")).toBeNull();
    const sold = await buildPlanCatalog(parsePlanCatalog(doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: ["901", "902"] }), plan("team", 3, { providerVariants: ["903"] })] })), "operator");
    expect(sold.hasProviderVariants).toBe(true);
    expect(sold.planForVariant("901")?.id).toBe("beta");
    expect(sold.planForVariant("902")?.id).toBe("beta");
    expect(sold.planForVariant("903")?.id).toBe("team");
    expect(sold.planForVariant("904")).toBeNull();
    expect(sold.planForVariant("0903")).toBeNull();
    expect(() => { (sold.plans.get("team")!.providerVariants as string[]).push("905"); }).toThrow();
    const cases: [unknown, RegExp][] = [
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: ["901"] }), plan("team", 3, { providerVariants: ["901"] })] }), /plans\.2\.providerVariants\.0: duplicate provider variant/],
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: ["901", "901"] })] }), /plans\.1\.providerVariants\.1: duplicate provider variant/],
      [doc({ plans: [plan("alpha", 1, { providerVariants: ["901"] })] }), /plans\.0\.providerVariants: the default plan cannot have provider variants/],
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: ["abc"] })] }), /plans\.1\.providerVariants\.0/],
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: ["0"] })] }), /plans\.1\.providerVariants\.0/],
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: [901] })] }), /plans\.1\.providerVariants\.0/],
      [doc({ plans: [plan("alpha", 1), plan("beta", 2, { providerVariants: "901" })] }), /plans\.1\.providerVariants/],
    ];
    for (const [raw, rule] of cases) {
      const found = issues(raw);
      expect(found.join("; ")).toMatch(rule);
      expect(found.join(" ")).not.toMatch(/901|abc/);
    }
  });

  it("caches a valid catalog per document and keeps reporting an invalid one", async () => {
    const env = { MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(doc()) };
    expect(await cachedPlanCatalog(env)).toBe(await cachedPlanCatalog(env));
    const bad = { MONTRAL_PLAN_CONFIG_JSON: "[]" };
    await expect(cachedPlanCatalog(bad)).rejects.toBeInstanceOf(PlanCatalogError);
    await expect(cachedPlanCatalog(bad)).rejects.toBeInstanceOf(PlanCatalogError);
  });
});
