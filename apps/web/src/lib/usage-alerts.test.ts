import { describe, expect, it } from "vitest";
import type { Quota, Usage } from "./api";
import { zh } from "./zh";
import {
  alertKey, formatResetDate, isQuotaCode, joinMeters, METER_LABEL, meterLevel, nextUtcMonthStart, QUOTA_CODES, QUOTA_MESSAGE, quotaRefusal,
  resetDate, usageAlert, usageBarStorage, usageMeters,
} from "./usage-alerts";

// Synthetic allowances only: no figure here describes a real plan.
const END = "2026-12-01T00:00:00.000Z";
const q = (used: number, limit: number): Quota => ({ used, limit, periodStart: "2026-11-01T00:00:00.000Z", periodEnd: END });
const metered = (over: Partial<Extract<Usage, { metered: true }>> = {}): Usage => ({
  metered: true, periodEnd: END, credits: q(1, 2000), emails: q(0, 10), webhookEvents: q(0, 100), browserSeconds: q(0, 100), activeMonitors: 1,
  plan: { id: "synthetic", name: "Synthetic plan", maxActiveMonitors: 3, minIntervalSec: 120, upgradeUrl: "/app/billing" }, ...over,
});
const NOW = new Date("2026-11-20T12:00:00Z");

describe("meterLevel", () => {
  it("is ok below 80 %, near from 80 %, exhausted at or above the limit", () => {
    expect(meterLevel(q(79, 100))).toEqual({ pct: 79, state: "ok" });
    expect(meterLevel(q(799, 1000))).toEqual({ pct: 79, state: "ok" }); // 79.9 % is not yet 80 %
    expect(meterLevel(q(80, 100))).toEqual({ pct: 80, state: "near" });
    expect(meterLevel(q(99, 100))).toEqual({ pct: 99, state: "near" });
    expect(meterLevel(q(100, 100))).toEqual({ pct: 100, state: "exhausted" });
    expect(meterLevel(q(130, 100))).toEqual({ pct: 100, state: "exhausted" });
  });
  it("never alerts on an allowance of zero (the plan does not include the meter) or on negative usage", () => {
    expect(meterLevel(q(0, 0))).toEqual({ pct: 0, state: "ok" });
    expect(meterLevel(q(-5, 10))).toEqual({ pct: 0, state: "ok" });
  });
});

describe("usageAlert", () => {
  it("shows nothing on a deployment without plans (self-hosted), or before usage has loaded", () => {
    expect(usageAlert({ metered: false }, NOW)).toBeNull();
    expect(usageAlert(null, NOW)).toBeNull();
    expect(usageMeters({ metered: false })).toEqual([]);
  });
  it("shows nothing while every meter is below 80 %", () => {
    expect(usageAlert(metered(), NOW)).toBeNull();
  });
  it("is near when any meter reaches 80 %, listing those meters", () => {
    const a = usageAlert(metered({ emails: q(8, 10), webhookEvents: q(85, 100) }), NOW);
    expect(a).toEqual({ state: "near", meters: ["emails", "webhookEvents"], resetsAt: new Date(END), upgradeUrl: "/app/billing" });
  });
  it("is exhausted when any meter is used up, which wins over near", () => {
    const a = usageAlert(metered({ credits: q(2000, 2000), emails: q(9, 10) }), NOW);
    expect(a?.state).toBe("exhausted");
    expect(a?.meters).toEqual(["credits"]);
  });
  it("links to the billing page when the plan names no upgrade URL", () => {
    expect(usageAlert(metered({ plan: null, browserSeconds: q(100, 100) }), NOW)?.upgradeUrl).toBe("/app/billing");
  });
  it("a dismissal key changes when the banner would say something new", () => {
    const near = usageAlert(metered({ emails: q(8, 10) }), NOW)!;
    const out = usageAlert(metered({ emails: q(10, 10) }), NOW)!;
    expect(alertKey(near)).not.toBe(alertKey(out));
    expect(alertKey(near)).toBe(alertKey(usageAlert(metered({ emails: q(9, 10) }), NOW)!));
  });
});

describe("reset date", () => {
  it("is the start of the next UTC month, across the year boundary", () => {
    expect(nextUtcMonthStart(new Date("2026-11-30T23:59:59Z")).toISOString()).toBe(END);
    expect(nextUtcMonthStart(new Date("2026-12-31T23:59:59Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("prefers the period end the API reports, then a meter's, then the next UTC month", () => {
    expect(resetDate(metered({ periodEnd: "2026-12-15T00:00:00.000Z" }), NOW).toISOString()).toBe("2026-12-15T00:00:00.000Z");
    expect(resetDate(metered({ periodEnd: undefined }), NOW).toISOString()).toBe(END);
    expect(resetDate({ metered: false }, NOW).toISOString()).toBe(END);
  });
  it("is formatted as the UTC calendar day", () => {
    expect(formatResetDate(new Date(END), "en-US")).toBe("Dec 1, 2026");
  });
});

describe("quotaRefusal", () => {
  it("explains each quota code with the refusal's reset date and the billing page", () => {
    for (const code of QUOTA_CODES) {
      const r = quotaRefusal({ code, status: 402, resetsAt: END }, NOW);
      expect(r).toEqual({ code, message: QUOTA_MESSAGE[code], resetsAt: new Date(END), upgradeUrl: "/app/billing" });
      expect(r!.message).toContain("{date}");
    }
  });
  it("falls back to the next UTC month without a usable resetsAt", () => {
    expect(quotaRefusal({ code: "credits_exhausted" }, NOW)?.resetsAt.toISOString()).toBe(END);
    expect(quotaRefusal({ code: "credits_exhausted", resetsAt: "not a date" }, NOW)?.resetsAt.toISOString()).toBe(END);
    expect(quotaRefusal({ code: "credits_exhausted", resetsAt: "2026-01-01T00:00:00Z" }, NOW)?.resetsAt.toISOString()).toBe(END);
  });
  it("only follows a same-origin upgrade path", () => {
    expect(quotaRefusal({ code: "browser_quota_exhausted", upgradeUrl: "/app/billing?from=quota" }, NOW)?.upgradeUrl).toBe("/app/billing?from=quota");
    expect(quotaRefusal({ code: "browser_quota_exhausted", upgradeUrl: "https://elsewhere.example/" }, NOW)?.upgradeUrl).toBe("/app/billing");
    expect(quotaRefusal({ code: "browser_quota_exhausted", upgradeUrl: "//elsewhere.example/" }, NOW)?.upgradeUrl).toBe("/app/billing");
  });
  it("leaves every other error alone", () => {
    for (const code of ["monitor_limit", "manual_check_rate_limited", "metering_unavailable", "workspace_suspended", undefined]) {
      expect(isQuotaCode(code)).toBe(false);
      expect(quotaRefusal({ code, status: 402 }, NOW)).toBeNull();
    }
    expect(quotaRefusal(null, NOW)).toBeNull();
  });
});

describe("translations", () => {
  it("every message and meter label shown by the banner and the quota notice has a Chinese translation", () => {
    for (const s of [...Object.values(QUOTA_MESSAGE), ...Object.values(METER_LABEL)]) expect(zh[s], s).toBeTruthy();
  });
});

describe("usage banner memory (paints with the page on revisits)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  it("remembers the notice last shown and reads it back at first paint", () => {
    const store = memory();
    expect(usageBarStorage(store).read(NOW)).toBeNull();
    const a = usageAlert(metered({ emails: q(8, 10) }), NOW)!;
    usageBarStorage(store).write(a);
    expect(usageBarStorage(store).read(NOW)).toEqual(a);
  });
  it("keeps what the bar displays only: state, meter keys, reset date and upgrade path, no usage figures", () => {
    const store = memory();
    usageBarStorage(store).write(usageAlert(metered({ emails: q(8, 10) }), NOW));
    expect(JSON.parse(store.m.get("montral_usage_alert")!)).toEqual({ state: "near", meters: ["emails"], resetsAt: END, upgradeUrl: "/app/billing" });
  });
  it("forgets the notice and its dismissal once usage is back under 80 %", () => {
    const store = memory();
    const a = usageAlert(metered({ emails: q(10, 10) }), NOW)!;
    usageBarStorage(store).write(a);
    usageBarStorage(store).dismiss(alertKey(a));
    expect(usageBarStorage(store).dismissed()).toBe(alertKey(a));
    usageBarStorage(store).write(null);
    expect(usageBarStorage(store).read(NOW)).toBeNull();
    expect(usageBarStorage(store).dismissed()).toBeNull();
  });
  it("ignores a remembered notice from an ended period, or anything malformed", () => {
    const store = memory();
    usageBarStorage(store).write(usageAlert(metered({ emails: q(10, 10) }), NOW));
    expect(usageBarStorage(store).read(new Date("2026-12-02T00:00:00Z"))).toBeNull();
    for (const bad of ["{", "null", '{"state":"near","meters":["credits"],"resetsAt":"' + END + '","upgradeUrl":"https://elsewhere.example/"}',
      '{"state":"near","meters":["__proto__"],"resetsAt":"' + END + '","upgradeUrl":"/app/billing"}', '{"state":"ok","meters":["credits"],"resetsAt":"' + END + '","upgradeUrl":"/app/billing"}']) {
      store.m.set("montral_usage_alert", bad);
      expect(usageBarStorage(store).read(NOW), bad).toBeNull();
    }
  });
  it("works without session storage, or when it throws", () => {
    expect(usageBarStorage(null).read(NOW)).toBeNull();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    const s = usageBarStorage(throwing);
    expect(() => { s.write(usageAlert(metered({ emails: q(10, 10) }), NOW)); s.dismiss("k"); s.write(null); }).not.toThrow();
    expect(s.read(NOW)).toBeNull();
    expect(s.dismissed()).toBeNull();
  });
});

describe("meter names in a sentence", () => {
  it("are joined with the ideographic comma in Chinese", () => {
    expect(joinMeters(["检查额度", "邮件通知"], "zh-CN")).toBe("检查额度、邮件通知");
    expect(joinMeters(["Checks", "Email notifications"], "en")).toBe("Checks, Email notifications");
  });
});

describe("quota wording", () => {
  it("says what is left is not enough for this check, per period, never 'this month'", () => {
    expect(QUOTA_MESSAGE.credits_exhausted).toMatch(/not enough checks left this period for this check/);
    expect(QUOTA_MESSAGE.browser_quota_exhausted).toMatch(/not enough browser check time left this period for this check/);
    for (const m of Object.values(QUOTA_MESSAGE)) expect(m).not.toMatch(/month/);
  });
});
