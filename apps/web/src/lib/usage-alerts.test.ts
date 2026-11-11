import { describe, expect, it } from "vitest";
import type { Quota, Usage } from "./api";
import { zh } from "./zh";
import {
  alertKey, formatResetDate, isQuotaCode, METER_LABEL, meterLevel, nextUtcMonthStart, QUOTA_CODES, QUOTA_MESSAGE, quotaRefusal,
  resetDate, usageAlert, usageMeters,
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
