import { createHash } from "node:crypto";
import type { Db } from "@montral/db-pg";

/** STAGED PRIVACY REHEARSAL ONLY. No production HTTP, scheduler or default job.
 * Content is confidential and should not outlive a reviewed retention policy.
 * The outbox/recipient/usage/reconciliation records MUST remain untouched. */
export type ContentRetentionReport = Readonly<{
  retentionDays: number;
  cutoffUtc: string;
  readOnly: true;
  outcome: "NO_GO";
  permitsProductionPurge: false;
  counts: {
    total: number;
    eligibleClosed: number;
    heldRecent: number;
    heldMissingRecipients: number;
    heldUnresolved: number;
  };
  countsSha256: string;
}>;

function validateWindow(retentionDays: number, now: Date) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 180 || retentionDays > 3650
    || !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error("Invalid content retention rehearsal window");
  return new Date(now.getTime() - retentionDays * 86400000).toISOString();
}

/** All results are aggregates: never return names, tenants, addresses, raw
 * report JSON, provider identifiers, or SQL failure details to an operator. */
export async function inspectFrozenContentRetention(db: Db, retentionDays: number, now = new Date()): Promise<ContentRetentionReport> {
  const cutoff = validateWindow(retentionDays, now);
  const [r] = await db.$client.begin("isolation level repeatable read read only", async (tx) => tx<{
    total: number; eligibleClosed: number; heldRecent: number;
    heldMissingRecipients: number; heldUnresolved: number; readOnly: string;
  }[]>`
    with records as (
      select c.created_at,
        exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month) as has_recipients,
        exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month
          and r.state not in ('accepted','skipped')) as has_unresolved
      from monthly_report_content c
    ) select
      count(*)::integer as "total",
      count(*) filter (where created_at < ${cutoff}::timestamptz and has_recipients and not has_unresolved)::integer as "eligibleClosed",
      count(*) filter (where created_at >= ${cutoff}::timestamptz)::integer as "heldRecent",
      count(*) filter (where created_at < ${cutoff}::timestamptz and not has_recipients)::integer as "heldMissingRecipients",
      count(*) filter (where created_at < ${cutoff}::timestamptz and has_recipients and has_unresolved)::integer as "heldUnresolved",
      current_setting('transaction_read_only') as "readOnly"
    from records
  `);
  if (!r || r.readOnly !== "on") throw new Error("Content retention preflight not read-only");
  const counts = { total: r.total, eligibleClosed: r.eligibleClosed, heldRecent: r.heldRecent,
    heldMissingRecipients: r.heldMissingRecipients, heldUnresolved: r.heldUnresolved };
  if (Object.values(counts).some((v) => !Number.isSafeInteger(v) || v < 0)
    || counts.total !== counts.eligibleClosed + counts.heldRecent + counts.heldMissingRecipients + counts.heldUnresolved)
    throw new Error("Invalid content retention aggregates");
  return { retentionDays, cutoffUtc: cutoff, readOnly: true, outcome: "NO_GO",
    permitsProductionPurge: false, counts,
    countsSha256: createHash("sha256").update(JSON.stringify({ retentionDays, cutoff, counts })).digest("hex") };
}

/** ONLY for an isolated synthetic local rehearsal, never a scheduled call.
 * Lock eligible content rows and recheck recipient states in the DELETE.
 * Blocks all attempted/prepared/uncertain records, even if provider-reviewed.
 * Does NOT delete recipient metadata, quota, reconciliation or usage history. */
export async function purgeFrozenContentInDisposableTestDb(
  db: Db, retentionDays: number, now: Date, batchSize = 50,
): Promise<number> {
  const cutoff = validateWindow(retentionDays, now);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error("Invalid content retention rehearsal batch");
  const [result] = await db.$client.begin(async (tx) => {
    // Defense in depth: a misused internal import must not turn this rehearsal
    // into an accidental production purge, even when the CLI was bypassed.
    const [target] = await tx<{ name: string; address: string | null }[]>`
      select current_database() as name, host(inet_server_addr()) as address
    `;
    if (!target || !/^montral_test_[A-Za-z0-9_]+$/.test(target.name)
      || !["127.0.0.1", "::1"].includes(target.address ?? ""))
      throw new Error("Disposable localhost database required for retention rehearsal");
    return tx<{ n: number }[]>`
    with eligible as (
      select c.organization_id, c.report_month from monthly_report_content c
      where c.created_at < ${cutoff}::timestamptz
        and exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month)
        and not exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month
            and r.state not in ('accepted','skipped'))
      order by c.created_at, c.organization_id, c.report_month
      limit ${batchSize} for update of c skip locked
    ), removed as (
      delete from monthly_report_content c using eligible e
      where c.organization_id=e.organization_id and c.report_month=e.report_month
        and c.created_at < ${cutoff}::timestamptz
        and exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month)
        and not exists (select 1 from monthly_report_recipient r
          where r.organization_id=c.organization_id and r.report_month=c.report_month
            and r.state not in ('accepted','skipped'))
      returning c.organization_id
    ) select count(*)::integer as n from removed
    `;
  });
  if (!result || !Number.isSafeInteger(result.n) || result.n < 0 || result.n > batchSize)
    throw new Error("Invalid content retention rehearsal result");
  return result.n;
}
