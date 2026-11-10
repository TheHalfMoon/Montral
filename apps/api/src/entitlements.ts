import type { Monitor, StatusPage, SubscriberTarget } from "@montral/repo";
import { effectiveRegions } from "./regions";

/**
 * What a workspace may use. The open-source build never limits anything (`unmetered`); the hosted edition passes its
 * own implementation to `createApp` and to the scheduler entry points, so no billing rule lives in this repository.
 *
 * Usage is measured in credits: one check that makes an outbound request is one credit (see `creditCost`).
 */
export interface Entitlements {
  /** Optional access policy, evaluated before every status response and before shared caches. Missing means public. */
  statusPageAccess?(page: StatusPage, request: Request): Promise<{ allowed: boolean }>;
  /** Recheck a subscriber immediately before notification. Missing means allowed; exceptions fail closed. */
  canNotifySubscriber?(workspaceId: string, subscriber: SubscriberTarget): Promise<boolean>;
  /** Optional routing policy for each eligible channel. Only true approves; failed decisions retry at the original time. */
  allowAlertChannel?(workspaceId: string, input: {
    projectId: string | null; monitorId: string | null; incidentId: string;
    kind: "incident.opened" | "incident.resolved" | "incident.reminder" | "incident.escalated";
    at: Date; channelId: string;
  }): Promise<boolean>;
  /**
   * Take `credits` for work that is about to run. Resolves with how many were granted, between 0 and `credits`:
   * fewer than asked means the allowance for the current period is used up and the rest must not run.
   *
   * `at` (default now) picks the period, so a caller that may refund later can name the same instant.
   */
  spendCredits(workspaceId: string, credits: number, at?: Date): Promise<number>;
  /**
   * Give back credits taken with `spendCredits` for work that then did not happen (a browser check deferred for capacity,
   * or one the browser runtime could not run). `spentAt` is when they were taken: they go back to that period's
   * allowance, so a check that straddles a period boundary never inflates the new period. Missing means credits are
   * never given back.
   */
  refundCredits?(workspaceId: string, credits: number, spentAt?: Date): Promise<void>;
  /** The allowance and what is used of it, for display. null when the workspace is not metered. */
  creditBalance(workspaceId: string): Promise<CreditBalance | null>;
  /** Like `spendCredits`, for notification emails (alerts and status-page subscriber mails). System mails are never counted. */
  spendEmails(workspaceId: string, count: number): Promise<number>;
  /** STAGED ONLY: an idempotent single-email quota reservation for a durable
   * monthly recipient dispatch key. Only `newlyReserved && granted` may ever
   * authorize a *first* attempt; `granted` on replay is bookkeeping, NOT
   * permission to resend. Absent when metering is disabled. Not yet used by
   * the active monthly report sender. */
  reserveEmailQuotaOnce?(workspaceId: string, idempotencyKey: string): Promise<{ granted: boolean; newlyReserved: boolean }>;
  /** STAGED ONLY. Atomically reserves one recipient's quota and moves its
   * durable monthly outbox record out of `prepared`; a returned `attempted`
   * permits at most one later SMTP attempt. No active sender uses this API.
   * Already-claimed / uncertain results MUST NOT be replayed. */
  claimMonthlyOutboxAttempt?(workspaceId: string, reportMonth: string, recipientUserId: string): Promise<
    "attempted" | "quota_denied" | "already_claimed" | "not_eligible" | "prior_reservation_uncertain"
  >;
  /** The email allowance and what is used of it, for display. null when emails are not metered. */
  emailBalance(workspaceId: string): Promise<CreditBalance | null>;
  /** The plan the workspace is on, with its hard limits. null when this deployment has no plans. */
  plan(workspaceId: string): Promise<Plan | null>;
}

export type Plan = {
  id: string;
  name: string;
  /** Monitors that are not paused. null = no cap. */
  maxActiveMonitors: number | null;
  /** The shortest check interval the plan allows, in seconds. */
  minIntervalSec: number;
  /** Regions one monitor may check from (`auto` counts as one). Absent or null = no cap. */
  maxRegions?: number | null;
  /** Whether a status page may hide Montral's name and mark. Absent = yes, like the other limits; an edition that sells it sets false on the plans without it. */
  hideBranding?: boolean;
  /** Where to start or change a subscription, and where to manage billing. Absent when the workspace cannot do it. */
  upgradeUrl?: string;
  manageUrl?: string;
};

export type CreditBalance = {
  /** Credits included in the period. */
  limit: number;
  used: number;
  /** The period is [start, end): it starts on the subscription's day of the month and resets at `end`. */
  periodStart: Date;
  periodEnd: Date;
};

/** Self-hosted default: nothing is counted, nothing is refused. */
export const unmetered: Entitlements = {
  spendCredits: async (_workspaceId, credits) => credits,
  creditBalance: async () => null,
  spendEmails: async (_workspaceId, count) => count,
  emailBalance: async () => null,
  plan: async () => null,
};

/**
 * Credits one check costs: one per request made, so a monitor checked from three regions costs three. A heartbeat
 * monitor makes no request of ours: the app being watched pings us, and evaluating a missed deadline is free, so a
 * workspace is never blinded to a dead cron job because it ran out.
 */
export const creditCost = (m: Pick<Monitor, "type" | "regions">) => (m.type === "heartbeat" ? 0 : effectiveRegions(m).length);

/** The same day of the month `n` months after `d` (UTC), clamped to the month's end: Jan 31 + 1 month = Feb 28/29. */
function addMonths(d: Date, n: number) {
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  const last = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth() + 1, 0)).getUTCDate();
  const t = new Date(first);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * The monthly period `now` falls in, counted from the subscription start (`anchor`): a subscription started on the 15th
 * renews on the 15th. Every boundary is computed from the anchor, so a clamped February does not drag later months.
 * Before the anchor it answers the first period.
 */
export function billingPeriod(anchor: Date, now: Date = new Date()): { start: Date; end: Date } {
  let k = Math.max(0, (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth());
  while (k > 0 && now < addMonths(anchor, k)) k--;
  while (now >= addMonths(anchor, k + 1)) k++;
  return { start: addMonths(anchor, k), end: addMonths(anchor, k + 1) };
}
