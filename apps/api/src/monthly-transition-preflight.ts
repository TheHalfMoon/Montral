import { createHash } from "node:crypto";
import type { Db } from "@montral/db-pg";

/** A bounded, read-only local audit. Deliberately not an HTTP or cron entrypoint.
 * NO DATA WRITES; not an approval to activate the staged dispatcher. */
export type MonthlyTransitionCounts = Readonly<{
  eligibleUnclaimedWorkspaces: number;
  legacyClaimedWithoutOutbox: number;
  outboxWorkspaces: number;
  outboxMonthMismatch: number;
  outboxMissingWorkspaceSetting: number;
  prepared: number;
  preparedAfterOptOut: number;
  attemptedWithinSafetyWindow: number;
  attemptedMature: number;
  uncertainUnreviewed: number;
  unresolvedReviews: number;
  providerAcceptedReviews: number;
  acceptedWithoutReview: number;
  skipped: number;
  missingAttemptReservations: number;
}>;

export type MonthlyTransitionPreflight = Readonly<{
  reportMonth: string;
  readOnly: true;
  outcome: "NO_GO";
  authorizesSending: false;
  counts: MonthlyTransitionCounts;
  findings: string[];
  countsSha256: string;
}>;

const columns = [
  "eligibleUnclaimedWorkspaces", "legacyClaimedWithoutOutbox", "outboxWorkspaces",
  "outboxMonthMismatch", "outboxMissingWorkspaceSetting", "prepared", "preparedAfterOptOut",
  "attemptedWithinSafetyWindow", "attemptedMature", "uncertainUnreviewed",
  "unresolvedReviews", "providerAcceptedReviews", "acceptedWithoutReview", "skipped",
  "missingAttemptReservations",
] as const;

export function validTransitionMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= 2000 && year <= 9998;
}

/** Single repeatable-read, READ ONLY transaction and one snapshot SELECT.
 * No tenant identifiers, emails, SMTP references, evidence hashes or messages
 * are included in the result or failure diagnostics. */
export async function inspectMonthlyTransition(db: Db, reportMonth: string): Promise<MonthlyTransitionPreflight> {
  if (!validTransitionMonth(reportMonth)) throw new Error("Invalid monthly transition report month");
  const [result] = await db.$client.begin("isolation level repeatable read read only", async (tx) =>
    tx<Array<Readonly<Record<(typeof columns)[number], number> & { transactionReadOnly: string }>>>`
      with source as (
        select r.organization_id, r.report_month, r.recipient_user_id,
               r.state, r.attempted_at, w.last_report_month, w.monthly_report,
               (w.organization_id is null) as missing_setting
        from monthly_report_recipient r
        left join workspace_setting w on w.organization_id = r.organization_id
        where r.report_month = ${reportMonth}
      ), with_review as (
        select s.*, a.decision, a.recipient_user_id is not null as reviewed
        from source s left join monthly_report_reconciliation a
          on a.organization_id=s.organization_id
         and a.report_month=s.report_month and a.recipient_user_id=s.recipient_user_id
      )
      select
        (select count(*)::integer from workspace_setting w
          where w.monthly_report and w.last_report_month is distinct from ${reportMonth}
          and not exists (select 1 from source s where s.organization_id=w.organization_id)) as "eligibleUnclaimedWorkspaces",
        (select count(*)::integer from workspace_setting w
          where w.last_report_month = ${reportMonth}
          and not exists (select 1 from source s where s.organization_id=w.organization_id)) as "legacyClaimedWithoutOutbox",
        (select count(distinct organization_id)::integer from source) as "outboxWorkspaces",
        (select count(distinct organization_id)::integer from source where last_report_month is distinct from ${reportMonth}) as "outboxMonthMismatch",
        (select count(distinct organization_id)::integer from source where missing_setting) as "outboxMissingWorkspaceSetting",
        (select count(*)::integer from source where state='prepared') as "prepared",
        (select count(*)::integer from source where state='prepared' and monthly_report is distinct from true) as "preparedAfterOptOut",
        (select count(*)::integer from source where state='attempted' and attempted_at > now() - interval '30 minutes') as "attemptedWithinSafetyWindow",
        (select count(*)::integer from source where state='attempted' and attempted_at <= now() - interval '30 minutes') as "attemptedMature",
        (select count(*)::integer from with_review where state='uncertain' and not reviewed) as "uncertainUnreviewed",
        (select count(*)::integer from with_review where decision='unresolved') as "unresolvedReviews",
        (select count(*)::integer from with_review where decision='provider_accepted') as "providerAcceptedReviews",
        (select count(*)::integer from with_review where state='accepted' and not reviewed) as "acceptedWithoutReview",
        (select count(*)::integer from source where state='skipped') as "skipped",
        (select count(*)::integer from source s
          where s.state in ('attempted','accepted','uncertain','skipped')
            and not exists (
              select 1 from montral_usage_reservation q
              where q.organization_id=s.organization_id and q.kind='emails'
                and q.period_start=((s.report_month || '-01')::date + interval '1 month')::timestamptz
                and q.idempotency_key='monthly:' || s.report_month || ':' || s.recipient_user_id
            )) as "missingAttemptReservations",
        current_setting('transaction_read_only') as "transactionReadOnly"
    `);
  if (!result || result.transactionReadOnly !== "on") throw new Error("Monthly preflight read-only guarantee not established");
  const counts = Object.fromEntries(columns.map((key) => {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid monthly preflight aggregate");
    return [key, value];
  })) as unknown as MonthlyTransitionCounts;
  const findings: string[] = [];
  if (counts.legacyClaimedWithoutOutbox) findings.push("Legacy claims have no recipient delivery evidence; never auto-replay");
  if (counts.outboxMissingWorkspaceSetting) findings.push("Outbox recipient rows have no workspace settings; no automatic sends");
  if (counts.outboxMonthMismatch) findings.push("Outbox rows disagree with workspace month claims; investigate before migration");
  if (counts.attemptedWithinSafetyWindow || counts.attemptedMature || counts.uncertainUnreviewed || counts.unresolvedReviews)
    findings.push("Ambiguous provider attempts require independent external reconciliation, not retry");
  if (counts.preparedAfterOptOut) findings.push("Prepared recipients exist after workspace opt-out; keep sends disabled");
  if (counts.missingAttemptReservations) findings.push("Some terminal/attempted outbox rows lack idempotent reservation evidence");
  // Even an entirely empty local database cannot demonstrate provider or
  // deployment readiness. Never expose a positive GO verdict from a DB scan.
  findings.push("External SMTP evidence, production scheduler migration, hosted CI and managed recovery not qualified");
  return {
    reportMonth, readOnly: true, outcome: "NO_GO", authorizesSending: false,
    counts, findings,
    countsSha256: createHash("sha256").update(JSON.stringify({ reportMonth, counts })).digest("hex"),
  };
}
