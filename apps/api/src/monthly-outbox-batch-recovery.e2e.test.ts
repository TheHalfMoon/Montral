import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import type { Repo } from "@montral/repo";
import { configureEmail, setMailTransport } from "./email";
import type { Bindings } from "./env";
import { createMontralEntitlements } from "./montral-metering";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import { previousMonth } from "./reports";
import { runStagedMonthlyOutboxBatch } from "./monthly-outbox-dispatcher";

const url = process.env.TEST_DATABASE_URL;
const flags = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
// Keep the injected report window and the actual UTC billing period aligned.
// Historical fixed months stop being eligible when the calendar rolls over.
const current = new Date();
const when = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 2, 10));
const month = previousMonth(when);
const zero = { workspaces: 0, claimed: 0, accepted: 0, uncertain: 0, quotaDenied: 0 };

/** Isolated database: the staged *batch* intentionally selects all eligible
 * organizations, so it must never touch the shared API E2E test fixture. */
describe.skipIf(!url)("monthly outbox staged atomic materialization and crash recovery", () => {
  const name = `montral_batch_${randomUUID().replaceAll("-", "")}`;
  let admin: ReturnType<typeof openDatabase>;
  let db: ReturnType<typeof openDatabase>;
  let connection: string;
  let sent: string[] = [];
  const orgs: Array<{ id: string; owners: string[] }> = [];
  beforeAll(async () => {
    admin = openDatabase(url!, { max: 1 });
    await admin.query(`CREATE DATABASE "${name}"`);
    const parsed = new URL(url!);
    parsed.pathname = `/${name}`;
    connection = parsed.href;
    db = openDatabase(connection, { max: 8 });
    await migrateMontralSchema(db, montralEdition);
  });
  beforeEach(() => {
    sent = [];
    configureEmail({ EMAIL_FROM: "montral@example.test", WEB_ORIGIN: "http://localhost:3000" } as Bindings);
    setMailTransport(async (mail) => { sent.push(mail.to); });
  });
  afterEach(async () => {
    setMailTransport(undefined);
    vi.restoreAllMocks();
    for (const { id, owners } of orgs.splice(0)) {
      await db.query("DELETE FROM organization WHERE id=$1", [id]);
      for (const owner of owners) await db.query('DELETE FROM "user" WHERE id=$1', [owner]);
    }
  });
  afterAll(async () => {
    await db?.close(8);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.close(1);
    }
  });

  const meter = () => createMontralEntitlements(db, flags);
  const repo = () => ({
    ...db.repo,
    monthlyReport: async () => [{ name: "Synthetic uptime", uptime: 99.8, downtimeMinutes: 4, incidents: 1 }],
  }) as Repo;
  async function makeOrg(claimed = false) {
    const id = `synthetic-batch-${randomUUID()}`;
    const owners = Array.from({ length: 2 }, () => `synthetic-owner-${randomUUID()}`);
    await db.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic outbox batch',$1,NOW())", [id]);
    orgs.push({ id, owners });
    for (const user of owners) {
      await db.query('INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES($1,$1,$2,NOW(),NOW())', [user, `${user}@example.test`]);
      await db.query("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',NOW())", [`m-${user}`, id, user]);
    }
    await db.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [id, claimed ? month : null]);
    return { id, owners };
  }
  async function count(org: string) { return db.repo.monthlyReportRecipientCounts(org, month); }
  async function usage(org: string) { return meter().emailBalance(org); }

  it("atomically creates owner snapshots, delivers and never repeats on next batch tick", async () => {
    const { id, owners } = await makeOrg();
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual({ workspaces: 1, claimed: 2, accepted: 2, uncertain: 0, quotaDenied: 0 });
    expect(sent.slice().sort()).toEqual(owners.map((u) => `${u}@example.test`).sort());
    expect(await count(id)).toMatchObject({ prepared: 0, accepted: 2, uncertain: 0 });
    expect(await usage(id)).toMatchObject({ used: 2 });
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual(zero);
    expect(sent).toHaveLength(2);
  });

  it("recovers committed recipient snapshot after process stopped before dispatcher ran", async () => {
    const { id } = await makeOrg();
    expect(await db.repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([id]);
    expect(await count(id)).toMatchObject({ prepared: 2 });
    // New connection simulates a restarted application process.
    const restarted = openDatabase(connection, { max: 3 });
    try {
      const recoveredRepo = { ...restarted.repo, monthlyReport: repo().monthlyReport } as Repo;
      const recoveredMeter = createMontralEntitlements(restarted, flags);
      expect(await runStagedMonthlyOutboxBatch(recoveredRepo, recoveredMeter, when)).toEqual({ workspaces: 1, claimed: 2, accepted: 2, uncertain: 0, quotaDenied: 0 });
      expect(sent).toHaveLength(2);
      expect(await count(id)).toMatchObject({ prepared: 0, accepted: 2 });
      expect(await runStagedMonthlyOutboxBatch(recoveredRepo, recoveredMeter, when)).toEqual(zero);
    } finally { await restarted.close(3); }
  });

  it("never infers delivery eligibility from a legacy month claim lacking recipient records", async () => {
    const { id } = await makeOrg(true);
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual(zero);
    expect(sent).toHaveLength(0);
    expect(await count(id)).toMatchObject({ prepared: 0, attempted: 0 });
    expect(await usage(id)).toMatchObject({ used: 0 });
  });

  it("rolls back snapshot failures then safely resumes next tick without duplicate mail", async () => {
    const { id } = await makeOrg();
    await db.query(`CREATE FUNCTION synthetic_batch_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic interrupted batch transaction'; END; $$`);
    await db.query(`CREATE TRIGGER synthetic_batch_interrupt_trigger BEFORE INSERT ON monthly_report_recipient
      FOR EACH ROW EXECUTE FUNCTION synthetic_batch_interrupt()`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual(zero);
      expect(await count(id)).toMatchObject({ prepared: 0 });
      const ws = await db.query<{ last_report_month: string | null }>("SELECT last_report_month FROM workspace_setting WHERE organization_id=$1", [id]);
      expect(ws[0].last_report_month).toBeNull();
      expect(await usage(id)).toMatchObject({ used: 0 });
      expect(log).toHaveBeenCalledWith("monthly outbox atomic owner snapshot unavailable");
      expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic interrupted batch transaction");
    } finally {
      await db.query("DROP TRIGGER synthetic_batch_interrupt_trigger ON monthly_report_recipient");
      await db.query("DROP FUNCTION synthetic_batch_interrupt()");
    }
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toMatchObject({ workspaces: 1, accepted: 2 });
    expect(sent).toHaveLength(2);
    expect(await usage(id)).toMatchObject({ used: 2 });
  });

  it("multiple batch workers competing for the same first claim never send twice", async () => {
    const { id, owners } = await makeOrg();
    setMailTransport(async (mail) => { sent.push(mail.to); await new Promise((resolve) => setTimeout(resolve, 5)); });
    const batch = () => runStagedMonthlyOutboxBatch(repo(), meter(), when);
    const attempts = await Promise.all(Array.from({ length: 5 }, batch));
    expect(attempts.reduce((n, r) => n + r.accepted, 0)).toBe(2);
    expect(sent.slice().sort()).toEqual(owners.map((o) => `${o}@example.test`).sort());
    expect(await usage(id)).toMatchObject({ used: 2 });
    expect(await count(id)).toMatchObject({ accepted: 2, prepared: 0 });
  });

  it("missing mail provider or disabled preference creates no claim or quota usage", async () => {
    const { id } = await makeOrg();
    setMailTransport(undefined);
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual(zero);
    expect(await count(id)).toMatchObject({ prepared: 0 });
    expect(await usage(id)).toMatchObject({ used: 0 });
    setMailTransport(async (mail) => { sent.push(mail.to); });
    await db.query("UPDATE workspace_setting SET monthly_report=false WHERE organization_id=$1", [id]);
    expect(await runStagedMonthlyOutboxBatch(repo(), meter(), when)).toEqual(zero);
    expect(await count(id)).toMatchObject({ prepared: 0 });
    expect(sent).toHaveLength(0);
  });
});
