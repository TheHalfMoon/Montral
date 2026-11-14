import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { MIGRATIONS } from "./migrations.generated";
import { createRepo } from "./repo";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("monthly outbox migration from an existing Montral database", () => {
  it("upgrades previous migration history without modifying old monthly claims", async () => {
    const admin = createDb(url!, { max: 1 });
    const name = `monthly_upgrade_${randomUUID().replaceAll("-", "")}`;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      await admin.$client.unsafe(`create database "${name}"`);
      const fresh = new URL(url!);
      fresh.pathname = `/${name}`;
      db = createDb(fresh.href, { max: 4 });
      // Upgrade historical 0040 through 0041 recipient outbox, 0042 review
      // evidence and 0043 immutable report content, without replaying claims.
      const baseline = MIGRATIONS.findIndex((m) => m.tag === "0040_gray_ultimates");
      expect(baseline).toBeGreaterThanOrEqual(0);
      const previous = MIGRATIONS.slice(0, baseline + 1);
      expect(previous.at(-1)?.tag).toBe("0040_gray_ultimates");
      expect((await migrate(db, previous)).length).toBe(previous.length);
      const org = `synthetic-legacy-${randomUUID()}`;
      await db.$client`insert into organization (id, name, slug, created_at) values (${org},'Synthetic legacy',${org},now())`;
      await db.$client`insert into workspace_setting (organization_id, monthly_report, last_report_month) values (${org},true,'2026-09')`;
      expect((await db.$client`select to_regclass('public.monthly_report_recipient') as name`)[0].name).toBeNull();
      // Simulate multiple application replicas upgrading at once.
      const runs = await Promise.all([migrate(db), migrate(db), migrate(db)]);
      expect(runs.flat()).toEqual(MIGRATIONS.slice(baseline + 1).map((m) => m.tag));
      expect((await db.$client`select last_report_month as month,monthly_report as enabled from workspace_setting where organization_id=${org}`)[0]).toEqual({ month: "2026-09", enabled: true });
      expect((await db.$client`select count(*)::int as n from monthly_report_recipient`)[0].n).toBe(0);
      expect((await db.$client`select count(*)::int as n from monthly_report_reconciliation`)[0].n).toBe(0);
      expect((await db.$client`select count(*)::int as n from monthly_report_content`)[0].n).toBe(0);
      expect(await createRepo(db).monthlyReportRecipientCounts(org, "2026-09")).toEqual({ prepared: 0, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 });
      expect(await migrate(db)).toEqual([]);
      // An old claimed report stays claimed; migrations never silently resend it.
      expect((await createRepo(db).claimMonthlyReports("2026-09", 20)).includes(org)).toBe(false);
    } finally {
      await db?.$client.end();
      await admin.$client.unsafe(`drop database if exists "${name}"`);
      await admin.$client.end();
    }
  });
});
