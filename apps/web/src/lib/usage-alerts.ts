/**
 * Usage clarity for metered (hosted) workspaces: how full each allowance is, whether the in-app banner shows, and the
 * customer-facing message for an API quota refusal. Pure functions, so they are tested without a browser.
 *
 * Self-hosted (community) deployments answer `GET /api/usage` with `{ metered: false }`: every function here then says
 * "nothing to show", so no banner, no meter and no upgrade prompt ever appears there.
 */
import type { Quota, Usage } from "./api";

/** From this share of an allowance the meter turns amber and the banner appears. */
export const NEAR_LIMIT_PCT = 80;

export type MeterKey = "credits" | "emails" | "webhookEvents" | "browserSeconds";
export type MeterState = "ok" | "near" | "exhausted";

/** English labels (translated by the caller with t()), in the order the Usage page shows the meters. */
export const METER_LABEL: Record<MeterKey, string> = {
  credits: "Checks",
  emails: "Email notifications",
  webhookEvents: "Webhook events",
  browserSeconds: "Browser check time",
};
const ORDER: MeterKey[] = ["credits", "emails", "webhookEvents", "browserSeconds"];

/**
 * How full one allowance is: a percentage clamped to 0–100 and a state. An allowance of zero (the plan does not include
 * that meter) is "ok" at 0 %: it is not something the customer used up, so it never raises the banner.
 */
export function meterLevel(q: Pick<Quota, "limit" | "used">): { pct: number; state: MeterState } {
  if (!(q.limit > 0)) return { pct: 0, state: "ok" };
  const ratio = Math.max(0, q.used) / q.limit;
  const pct = Math.min(100, Math.floor(ratio * 100));
  if (q.used >= q.limit) return { pct: 100, state: "exhausted" };
  return { pct, state: pct >= NEAR_LIMIT_PCT ? "near" : "ok" };
}

/** The meters a metered workspace has, in display order; none when the deployment is not metered. */
export function usageMeters(u: Usage | null | undefined): { key: MeterKey; quota: Quota }[] {
  if (!u || !u.metered) return [];
  return ORDER.flatMap((key) => {
    const quota = u[key];
    return quota ? [{ key, quota }] : [];
  });
}

/** The first instant of the next calendar month in UTC: when every allowance of this preview resets. */
export function nextUtcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** When the allowances reset: the period end the API reports, else the next UTC month. */
export function resetDate(u: Usage | null | undefined, now: Date = new Date()): Date {
  if (u && u.metered) {
    const reported = u.periodEnd ?? usageMeters(u)[0]?.quota.periodEnd;
    const d = reported ? new Date(reported) : null;
    if (d && !Number.isNaN(d.getTime())) return d;
  }
  return nextUtcMonthStart(now);
}

export type UsageAlert = { state: Exclude<MeterState, "ok">; meters: MeterKey[]; resetsAt: Date; upgradeUrl: string };

/**
 * Whether the in-app banner shows, and what it says: "exhausted" when any meter is used up (listing those), else "near"
 * when any is at or above 80 % (listing those). Null when nothing is near a limit or the deployment is not metered.
 */
export function usageAlert(u: Usage | null | undefined, now: Date = new Date()): UsageAlert | null {
  if (!u || !u.metered) return null;
  const levels = usageMeters(u).map(({ key, quota }) => ({ key, ...meterLevel(quota) }));
  const exhausted = levels.filter((l) => l.state === "exhausted").map((l) => l.key);
  const near = levels.filter((l) => l.state === "near").map((l) => l.key);
  const upgradeUrl = u.plan?.upgradeUrl || "/app/billing";
  if (exhausted.length) return { state: "exhausted", meters: exhausted, resetsAt: resetDate(u, now), upgradeUrl };
  if (near.length) return { state: "near", meters: near, resetsAt: resetDate(u, now), upgradeUrl };
  return null;
}

/** A key that changes when the banner would say something new, so a dismissal hides only what was dismissed. */
export const alertKey = (a: UsageAlert) => `${a.state}:${a.meters.join(",")}:${a.resetsAt.toISOString().slice(0, 10)}`;

/** API refusals that mean "this month's allowance is used up" (HTTP 402 or 429). */
export const QUOTA_CODES = ["credits_exhausted", "browser_quota_exhausted", "webhook_quota_exhausted"] as const;
export type QuotaCode = (typeof QUOTA_CODES)[number];
export const isQuotaCode = (code: unknown): code is QuotaCode => typeof code === "string" && (QUOTA_CODES as readonly string[]).includes(code);

/** The English message per code; `{date}` is the reset date. Translated by the caller with t() before filling in. */
export const QUOTA_MESSAGE: Record<QuotaCode, string> = {
  credits_exhausted: "This workspace has used all of its checks for this month. Checks resume on {date}, or upgrade your plan to continue now.",
  browser_quota_exhausted: "This workspace has used all of its browser check time for this month. It resets on {date}, or upgrade your plan to continue now.",
  webhook_quota_exhausted: "This workspace has used all of its webhook events for this month. New requests are refused until {date}, or upgrade your plan to continue now.",
};

/**
 * The customer-facing explanation of a quota refusal: the message key, the reset date (from the refusal's `resetsAt`,
 * else the next UTC month) and where to upgrade (the refusal's `upgradeUrl`, else the billing page). Null for any
 * other error, which the caller shows as it always did.
 */
export function quotaRefusal(err: unknown, now: Date = new Date()): { code: QuotaCode; message: string; resetsAt: Date; upgradeUrl: string } | null {
  const e = err as { code?: unknown; resetsAt?: unknown; upgradeUrl?: unknown } | null;
  if (!e || !isQuotaCode(e.code)) return null;
  const given = typeof e.resetsAt === "string" ? new Date(e.resetsAt) : null;
  const resetsAt = given && !Number.isNaN(given.getTime()) && given.getTime() > now.getTime() ? given : nextUtcMonthStart(now);
  const upgradeUrl = typeof e.upgradeUrl === "string" && e.upgradeUrl.startsWith("/") && !e.upgradeUrl.startsWith("//") ? e.upgradeUrl : "/app/billing";
  return { code: e.code, message: QUOTA_MESSAGE[e.code], resetsAt, upgradeUrl };
}

/** A reset date as people read it: "1 Dec 2026" in the page's language, always the UTC calendar day. */
export function formatResetDate(d: Date, locale?: string): string {
  try {
    return d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
