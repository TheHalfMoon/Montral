import { describe, expect, it } from "vitest";
import { BUILTIN_SANDBOX_CATALOG, buildPlanCatalog, cachedPlanCatalog, loadPlanCatalog, parsePlanCatalog, PlanCatalogError } from "./plan-catalog";

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

  it("caches a valid catalog per document and keeps reporting an invalid one", async () => {
    const env = { MONTRAL_PLAN_CONFIG_JSON: JSON.stringify(doc()) };
    expect(await cachedPlanCatalog(env)).toBe(await cachedPlanCatalog(env));
    const bad = { MONTRAL_PLAN_CONFIG_JSON: "[]" };
    await expect(cachedPlanCatalog(bad)).rejects.toBeInstanceOf(PlanCatalogError);
    await expect(cachedPlanCatalog(bad)).rejects.toBeInstanceOf(PlanCatalogError);
  });
});
