import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { migrate } from "./migrate";
import { createRepo } from "./repo";
import { eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const month = "2026-09";
const empty = { prepared: 0, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 };

/** Each suite owns its own disposable database, so claiming every eligible
 *  workspace in this file never claims another test's synthetic work. */
describe.skipIf(!url)("atomic monthly owner snapshots and crash recovery (staged)", () => {
  let admin: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let repo: ReturnType<typeof createRepo>;
  const suffix = randomUUID().replaceAll("-", "");
  const dbName = `montral_atomic_${suffix}`;
  const orgA = `synthetic-a-${suffix}`;
  const orgB = `synthetic-b-${suffix}`;
  const orgC = `synthetic-c-${suffix}`;
  const a1 = `synthetic-a-owner-${suffix}`;
  const a2 = `synthetic-a-owner2-${suffix}`;
  const b1 = `synthetic-b-owner-${suffix}`;
  const nonowner = `synthetic-member-${suffix}`;

  beforeAll(async () => {
    admin = createDb(url!, { max: 1 });
    await admin.$client.unsafe(`create database "${dbName}"`);
    const fresh = new URL(url!);
    fresh.pathname = `/${dbName}`;
    db = createDb(fresh.href, { max: 12 });
    await migrate(db);
    repo = createRepo(db);
    await db.insert(schema.organization).values([orgA, orgB, orgC].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    await db.insert(schema.user).values([a1, a2, b1, nonowner].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(schema.member).values([
      { id: `m-${a1}`, organizationId: orgA, userId: a1, role: "owner", createdAt: new Date() },
      { id: `m-${a2}`, organizationId: orgA, userId: a2, role: "owner", createdAt: new Date() },
      { id: `m-${b1}`, organizationId: orgB, userId: b1, role: "owner", createdAt: new Date() },
      { id: `m-${nonowner}`, organizationId: orgB, userId: nonowner, role: "member", createdAt: new Date() },
    ]);
    await db.insert(schema.workspaceSetting).values([orgA, orgB, orgC].map((organizationId) => ({ organizationId, monthlyReport: true })));
  });
  beforeEach(async () => {
    await db.delete(schema.monthlyReportRecipient);
    await db.update(schema.workspaceSetting).set({ lastReportMonth: null, monthlyReport: true });
    await db.update(schema.user).set({ email: `${a2}@example.test` }).where(eq(schema.user.id, a2));
  });
  afterAll(async () => {
    await db?.$client.end();
    if (admin) {
      await admin.$client.unsafe(`drop database if exists "${dbName}"`);
      await admin.$client.end();
    }
  });

  it("atomically snapshots owners and recovers only persisted prepared records", async () => {
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([orgA, orgB]);
    expect(await repo.preparedMonthlyReportRecipients(orgA, month)).toEqual([
      { userId: a1, email: `${a1}@example.test`, locale: null },
      { userId: a2, email: `${a2}@example.test`, locale: null },
    ]);
    expect(await repo.preparedMonthlyReportRecipients(orgB, month)).toEqual([{ userId: b1, email: `${b1}@example.test`, locale: null }]);
    expect(await repo.preparedMonthlyReportRecipients(orgC, month)).toEqual([]);
    // Simulate a new worker instance after a process stopped post-commit.
    const restarted = createRepo(db);
    expect(await restarted.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([orgA, orgB]);
    expect(await restarted.claimMonthlyReportsWithRecipients(month, 20)).toEqual([]);
    expect(await restarted.monthlyReportRecipientCounts(orgA, month)).toMatchObject({ prepared: 2 });
  });

  it("eight competing workers reserve each owner only once", async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => repo.claimMonthlyReportsWithRecipients(month, 20)));
    expect(outcomes.flat().sort()).toEqual([orgA, orgB]);
    expect(await repo.monthlyReportRecipientCounts(orgA, month)).toMatchObject({ prepared: 2 });
    expect(await repo.monthlyReportRecipientCounts(orgB, month)).toMatchObject({ prepared: 1 });
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([orgA, orgB]);
  });

  it("does not infer retry rights from a legacy workspace-month claim without recipients", async () => {
    await db.update(schema.workspaceSetting).set({ lastReportMonth: month }).where(eq(schema.workspaceSetting.organizationId, orgA));
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([]);
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([orgB]);
    expect(await repo.monthlyReportRecipientCounts(orgA, month)).toEqual(empty);
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([orgB]);
    // Preserve legacy release behavior only when there are no snapshot rows.
    await repo.releaseMonthlyReportClaim(orgA, month);
    const [ws] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgA));
    expect(ws.lastReportMonth).toBeNull();
  });

  it("never resets a claimed month with any snapshotted or attempted recipient", async () => {
    await repo.claimMonthlyReportsWithRecipients(month, 20);
    await repo.releaseMonthlyReportClaim(orgA, month);
    let [ws] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgA));
    expect(ws.lastReportMonth).toBe(month);
    expect(await repo.attemptMonthlyReportRecipient(orgA, month, a1)).toBe(true);
    expect(await repo.finishMonthlyReportRecipient(orgA, month, a1, "uncertain")).toBe(true);
    await repo.releaseMonthlyReportClaim(orgA, month);
    expect((await repo.recoverPreparedMonthlyReportWorkspaces(month, 20))).toContain(orgA); // a2 is still prepared
    expect(await repo.attemptMonthlyReportRecipient(orgA, month, a1)).toBe(false);
    // Even if an admin mistakenly resets the old setting, prior-month rows
    // prevent a new "first" recipient snapshot from being created.
    await db.update(schema.workspaceSetting).set({ lastReportMonth: null }).where(eq(schema.workspaceSetting.organizationId, orgA));
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([]);
    expect(await repo.monthlyReportRecipientCounts(orgA, month)).toMatchObject({ prepared: 1, uncertain: 1 });
    ws = (await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, orgA)))[0];
    expect(ws.lastReportMonth).toBeNull();
  });

  it("rolls back workspace claim and entire recipient snapshot after a database write failure", async () => {
    await db.$client.unsafe(`create function synthetic_fail_monthly_snapshot() returns trigger language plpgsql as $$
      begin if new.organization_id = '${orgA}' then raise exception 'synthetic snapshot interrupted'; end if; return new; end; $$`);
    await db.$client.unsafe(`create trigger synthetic_monthly_snapshot_interrupt before insert on monthly_report_recipient
      for each row execute function synthetic_fail_monthly_snapshot()`);
    try {
      await expect(repo.claimMonthlyReportsWithRecipients(month, 20)).rejects.toThrow();
      expect(await repo.monthlyReportRecipientCounts(orgA, month)).toEqual(empty);
      expect(await repo.monthlyReportRecipientCounts(orgB, month)).toEqual(empty);
      expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([]);
      for (const org of [orgA, orgB]) {
        const [ws] = await db.select().from(schema.workspaceSetting).where(eq(schema.workspaceSetting.organizationId, org));
        expect(ws.lastReportMonth).toBeNull();
      }
    } finally {
      await db.$client.unsafe("drop trigger if exists synthetic_monthly_snapshot_interrupt on monthly_report_recipient");
      await db.$client.unsafe("drop function if exists synthetic_fail_monthly_snapshot()");
    }
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([orgA, orgB]);
  });

  it("skips malformed owners and opt-out workspaces without consuming their month", async () => {
    await db.update(schema.user).set({ email: " " }).where(eq(schema.user.id, a2));
    await db.update(schema.workspaceSetting).set({ monthlyReport: false }).where(eq(schema.workspaceSetting.organizationId, orgB));
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([]);
    expect(await repo.monthlyReportRecipientCounts(orgA, month)).toEqual(empty);
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([]);
    await db.update(schema.user).set({ email: `${a2}@example.test` }).where(eq(schema.user.id, a2));
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toEqual([orgA]);
    await db.update(schema.workspaceSetting).set({ monthlyReport: false }).where(eq(schema.workspaceSetting.organizationId, orgA));
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([]);
  });

  it("only returns workspaces with unfinished prepared mail and validates bounded requests", async () => {
    for (const amount of [0, -1, 1.3, 101]) {
      await expect(repo.claimMonthlyReportsWithRecipients(month, amount)).rejects.toThrow("Invalid monthly report atomic snapshot request");
      await expect(repo.recoverPreparedMonthlyReportWorkspaces(month, amount)).rejects.toThrow("Invalid monthly report recovery request");
    }
    await expect(repo.claimMonthlyReportsWithRecipients("2026-13", 20)).rejects.toThrow("Invalid monthly report atomic snapshot request");
    await repo.claimMonthlyReportsWithRecipients(month, 20);
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 1)).toEqual([orgA]);
    for (const userId of [a1, a2]) {
      expect(await repo.attemptMonthlyReportRecipient(orgA, month, userId)).toBe(true);
      expect(await repo.finishMonthlyReportRecipient(orgA, month, userId, "accepted")).toBe(true);
    }
    expect(await repo.recoverPreparedMonthlyReportWorkspaces(month, 20)).toEqual([orgB]);
    expect(await repo.monthlyReportRecipientCounts(orgA, month)).toMatchObject({ accepted: 2, prepared: 0 });
  });
});
