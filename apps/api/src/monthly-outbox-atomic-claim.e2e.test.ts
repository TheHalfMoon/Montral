import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@montral/db-pg";
import { createMontralEntitlements, calendarMonthUtc } from "./montral-metering";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import type { Bindings } from "./env";

const url = process.env.TEST_DATABASE_URL;
const db = url ? openDatabase(url, { max: 12 }) : null;
const flags = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
const limits = db ? createMontralEntitlements(db, flags) : null;
const { start } = calendarMonthUtc();
const reportMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
const created: { org: string; users: string[] }[] = [];

async function makeClaimedReport(n = 1) {
  const org = `synthetic-atomic-report-${crypto.randomUUID()}`;
  const users = Array.from({ length: n }, () => `synthetic-atomic-owner-${crypto.randomUUID()}`);
  await db!.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic monthly test',$1,NOW())", [org]);
  created.push({ org, users });
  for (const user of users) {
    await db!.query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Synthetic owner',$2,NOW(),NOW())", [user, `${user}@example.test`]);
    await db!.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',NOW())", [`membership-${user}`, org, user]);
  }
  await db!.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [org, reportMonth]);
  const count = await db!.repo.reserveMonthlyReportRecipients(org, reportMonth,
    users.map((userId) => ({ userId, email: `${userId}@example.test`, locale: "en" })));
  expect(count).toBe(n);
  return { org, users };
}

async function reservationCount(org: string) {
  const rows = await db!.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM montral_usage_reservation WHERE organization_id=$1", [org]);
  return rows[0].n;
}

describe.skipIf(!url)("staged atomic monthly recipient claim + idempotent email quota", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  afterAll(async () => {
    for (const { org, users } of created) {
      await db!.query("DELETE FROM organization WHERE id=$1", [org]);
      for (const user of users) await db!.query("DELETE FROM \"user\" WHERE id=$1", [user]);
    }
    await db?.close(1);
  });

  it("allows exactly one of 20 concurrent attempts and one quota debit", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    const claims = await Promise.all(Array.from({ length: 20 }, () => limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)));
    expect(claims.filter(x => x === "attempted")).toHaveLength(1);
    expect(claims.filter(x => x === "already_claimed")).toHaveLength(19);
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 1, limit: 20 });
    expect(await reservationCount(org)).toBe(1);
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ attempted: 1, accepted: 0, uncertain: 0 });
    expect(await db!.repo.finishMonthlyReportRecipient(org, reportMonth, user, "accepted")).toBe(true);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("already_claimed");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 1 });
  });

  it("stays under the same free-tier limit as ordinary email senders with 25 recipients", async () => {
    const { org, users } = await makeClaimedReport(25);
    const ordinary = await limits!.spendEmails(org, 3);
    expect(ordinary).toBe(3);
    const results = await Promise.all(users.map(u => limits!.claimMonthlyOutboxAttempt!(org, reportMonth, u)));
    expect(results.filter(s => s === "attempted")).toHaveLength(17);
    expect(results.filter(s => s === "quota_denied")).toHaveLength(8);
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ prepared: 0, attempted: 17, skipped: 8 });
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 20, limit: 20 });
    expect(await reservationCount(org)).toBe(25);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, users[0])).toBe("already_claimed");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 20 });
  });

  it("rolls back quota, reservation and outbox state together on aborted transaction", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    await expect(db!.migrateEdition!(async tx => {
      const result = await tx.query<{ result: string }>(
        "SELECT montral_claim_monthly_report_send($1::text,$2::text,$3::text,$4::timestamptz,$5::integer) AS result",
        [org, reportMonth, user, start.toISOString(), 20],
      );
      expect(result[0].result).toBe("attempted");
      throw new Error("synthetic crash before durable commit");
    })).rejects.toThrow("synthetic crash before durable commit");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 0 });
    expect(await reservationCount(org)).toBe(0);
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ prepared: 1, attempted: 0 });
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("attempted");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 1 });
  });

  it("marks prior preexisting quota reservation uncertain, rather than allowing another send", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    const key = `monthly:${reportMonth}:${user}`;
    expect(await limits!.reserveEmailQuotaOnce!(org, key)).toEqual({ granted: true, newlyReserved: true });
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("prior_reservation_uncertain");
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ uncertain: 1, attempted: 0, prepared: 0 });
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("already_claimed");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 1 });
    expect(await reservationCount(org)).toBe(1);
  });

  it("returns quota_denied on an exhausted ledger and never makes a provider attempt", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    expect(await limits!.spendEmails(org, 20)).toBe(20);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("quota_denied");
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ skipped: 1, prepared: 0 });
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("already_claimed");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 20 });
  });

  it("fails closed when ownership, verified address, settings or report month changed", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    await db!.query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2", [org, user]);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("not_eligible");
    await db!.query("UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2", [org, user]);
    await db!.query("UPDATE \"user\" SET email='changed-synthetic@example.test' WHERE id=$1", [user]);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("not_eligible");
    await db!.query("UPDATE \"user\" SET email=$2 WHERE id=$1", [user, `${user}@example.test`]);
    await db!.query("UPDATE workspace_setting SET monthly_report=false WHERE organization_id=$1", [org]);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("not_eligible");
    await db!.query("UPDATE workspace_setting SET monthly_report=true,last_report_month='2001-01' WHERE organization_id=$1", [org]);
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, user)).toBe("not_eligible");
    expect(await limits!.claimMonthlyOutboxAttempt!(org, reportMonth, "not-a-recipient")).toBe("not_eligible");
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 0 });
    expect(await reservationCount(org)).toBe(0);
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ prepared: 1 });
  });

  it("rejects report/accounting period mismatch and noncanonical UTC month without state changes", async () => {
    const { org, users: [user] } = await makeClaimedReport();
    const query = "SELECT montral_claim_monthly_report_send($1::text,$2::text,$3::text,$4::timestamptz,$5::integer) AS result";
    const otherMonth = reportMonth === "2026-08" ? "2026-01" : "2026-08";
    await expect(db!.query(query, [org, otherMonth, user, start.toISOString(), 20])).rejects.toThrow();
    await expect(db!.query(query, [org, reportMonth, user, new Date(start.getTime() + 86_400_000).toISOString(), 20])).rejects.toThrow();
    await expect(db!.query(query, [org, reportMonth, user, start.toISOString(), -1])).rejects.toThrow();
    expect(await limits!.emailBalance(org)).toMatchObject({ used: 0 });
    expect(await db!.repo.monthlyReportRecipientCounts(org, reportMonth)).toMatchObject({ prepared: 1 });
  });

  it("leaves non-metered edition disabled rather than bypassing durable quota", () => {
    const other = createMontralEntitlements(db!, { MONTRAL_METERING_ENABLED: "false" } as Bindings);
    expect(other.claimMonthlyOutboxAttempt).toBeUndefined();
  });
});
