import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, createRepo, eq, schema } from "./index";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
const db = url ? createDb(url, { max: 6 }) : (undefined as never);
const repo = url ? createRepo(db) : (undefined as never);
const orgId = `synthetic-outbox-${crypto.randomUUID()}`;
const userId = `synthetic-user-${crypto.randomUUID()}`;
const secondId = `synthetic-user-${crypto.randomUUID()}`;
const outsiderId = `synthetic-user-${crypto.randomUUID()}`;
const month = "2026-09";
const recipients = [
  { userId, email: `${userId}@example.test`, locale: "en" },
  { userId: secondId, email: `${secondId}@example.test`, locale: "en" },
];

// Real Postgres required; no SMTP or production metering is invoked.
describe.skipIf(!url)("monthly report outbox database foundation", () => {
  beforeAll(async () => {
    await migrate(db);
    await db.insert(schema.organization).values({ id: orgId, name: "Synthetic outbox", slug: orgId, createdAt: new Date() });
    await db.insert(schema.user).values([userId, secondId, outsiderId].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(schema.member).values([
      { id: `m-${userId}`, organizationId: orgId, userId, role: "owner", createdAt: new Date() },
      { id: `m-${secondId}`, organizationId: orgId, userId: secondId, role: "owner", createdAt: new Date() },
      { id: `m-${outsiderId}`, organizationId: orgId, userId: outsiderId, role: "member", createdAt: new Date() },
    ]);
    await db.insert(schema.workspaceSetting).values({ organizationId: orgId, monthlyReport: true });
  });
  beforeEach(async () => {
    await db.delete(schema.monthlyReportRecipient).where(eq(schema.monthlyReportRecipient.organizationId, orgId));
    await db.update(schema.workspaceSetting).set({ monthlyReport: true, lastReportMonth: null }).where(eq(schema.workspaceSetting.organizationId, orgId));
    await db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.userId, secondId));
  });
  afterAll(async () => {
    if (!url) return;
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, secondId));
    await db.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await db.$client.end();
  });
  async function claim() {
    expect(await repo.claimMonthlyReports(month, 100)).toContain(orgId);
  }

  it("does not reserve unclaimed, disabled or invalid recipients, including nonowners", async () => {
    expect(await repo.reserveMonthlyReportRecipients(orgId, month, recipients)).toBe(0);
    await claim();
    await expect(repo.reserveMonthlyReportRecipients(orgId, "2026-13", recipients)).rejects.toThrow("Invalid report month");
    await expect(repo.reserveMonthlyReportRecipients(orgId, month, [recipients[0], recipients[0]])).rejects.toThrow("Invalid or duplicate");
    await expect(repo.reserveMonthlyReportRecipients(orgId, month, [{ userId: outsiderId, email: "synthetic@example.test", locale: "en" }])).rejects.toThrow("not a current workspace owner");
    expect((await repo.monthlyReportRecipientCounts(orgId, month)).prepared).toBe(0);
    await db.update(schema.workspaceSetting).set({ monthlyReport: false }).where(eq(schema.workspaceSetting.organizationId, orgId));
    expect(await repo.reserveMonthlyReportRecipients(orgId, month, recipients)).toBe(0);
  });

  it("atomically reserves one immutable owner snapshot across competing workers", async () => {
    await claim();
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.reserveMonthlyReportRecipients(orgId, month, recipients)));
    expect(results.reduce((n, value) => n + value, 0)).toBe(2);
    expect(await repo.monthlyReportRecipientCounts(orgId, month)).toEqual({ prepared: 2, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 });
    expect(await repo.reserveMonthlyReportRecipients(orgId, month, [{ userId: outsiderId, email: "new@example.test", locale: "en" }])).toBe(0);
    const rows = await db.select().from(schema.monthlyReportRecipient).where(eq(schema.monthlyReportRecipient.organizationId, orgId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.recipientUserId))).toEqual(new Set([userId, secondId]));
  });

  it("permits one and only one concurrent prepared-to-attempted transition", async () => {
    await claim();
    await repo.reserveMonthlyReportRecipients(orgId, month, recipients);
    const attempts = await Promise.all(Array.from({ length: 12 }, () => repo.attemptMonthlyReportRecipient(orgId, month, userId)));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect((await repo.monthlyReportRecipientCounts(orgId, month)).attempted).toBe(1);
    expect(await repo.finishMonthlyReportRecipient(orgId, month, userId, "uncertain")).toBe(true);
    expect(await repo.finishMonthlyReportRecipient(orgId, month, userId, "accepted")).toBe(false);
    expect(await repo.attemptMonthlyReportRecipient(orgId, month, userId)).toBe(false);
    expect(await repo.monthlyReportRecipientCounts(orgId, month)).toEqual({ prepared: 1, attempted: 0, accepted: 0, uncertain: 1, skipped: 0 });
    // DB constraints also reject any manual attempt-state corruption.
    await expect(db.update(schema.monthlyReportRecipient).set({ state: "accepted", attemptedAt: null, decidedAt: null }).where(eq(schema.monthlyReportRecipient.organizationId, orgId))).rejects.toThrow();
  });

  it("records accepted independently and does not leak outbox counts between organizations", async () => {
    await claim();
    await repo.reserveMonthlyReportRecipients(orgId, month, recipients);
    expect(await repo.attemptMonthlyReportRecipient(orgId, month, userId)).toBe(true);
    expect(await repo.finishMonthlyReportRecipient(orgId, month, userId, "accepted")).toBe(true);
    expect(await repo.monthlyReportRecipientCounts(orgId, month)).toEqual({ prepared: 1, attempted: 0, accepted: 1, uncertain: 0, skipped: 0 });
    expect(await repo.monthlyReportRecipientCounts("other-synthetic-organization", month)).toEqual({ prepared: 0, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 });
    expect(await repo.monthlyReportRecipientCounts(orgId, "2026-10")).toEqual({ prepared: 0, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 });
  });

  it("refuses the attempt after a recipient loses ownership or a report is disabled", async () => {
    await claim();
    await repo.reserveMonthlyReportRecipients(orgId, month, recipients);
    await db.update(schema.member).set({ role: "member" }).where(eq(schema.member.userId, secondId));
    expect(await repo.attemptMonthlyReportRecipient(orgId, month, secondId)).toBe(false);
    await db.update(schema.workspaceSetting).set({ monthlyReport: false }).where(eq(schema.workspaceSetting.organizationId, orgId));
    expect(await repo.attemptMonthlyReportRecipient(orgId, month, userId)).toBe(false);
    expect((await repo.monthlyReportRecipientCounts(orgId, month)).prepared).toBe(2);
  });

  it("refuses a recipient after email changes until an explicit audited reconciliation", async () => {
    await claim();
    await repo.reserveMonthlyReportRecipients(orgId, month, recipients);
    await db.update(schema.user).set({ email: "changed-synthetic@example.test" }).where(eq(schema.user.id, userId));
    try {
      expect(await repo.attemptMonthlyReportRecipient(orgId, month, userId)).toBe(false);
      expect((await repo.monthlyReportRecipientCounts(orgId, month)).prepared).toBe(2);
    } finally {
      await db.update(schema.user).set({ email: `${userId}@example.test` }).where(eq(schema.user.id, userId));
    }
  });

  it("cascades recipient records when a workspace is deleted", async () => {
    const tempOrg = `synthetic-deleted-${crypto.randomUUID()}`;
    const tempUser = `synthetic-deleted-user-${crypto.randomUUID()}`;
    await db.insert(schema.organization).values({ id: tempOrg, name: "Deleted workspace", slug: tempOrg, createdAt: new Date() });
    await db.insert(schema.user).values({ id: tempUser, name: "Deleted owner", email: `${tempUser}@example.test` });
    try {
      await db.insert(schema.member).values({ id: `m-${tempUser}`, organizationId: tempOrg, userId: tempUser, role: "owner", createdAt: new Date() });
      await db.insert(schema.workspaceSetting).values({ organizationId: tempOrg, monthlyReport: true });
      expect(await repo.claimMonthlyReports(month, 100)).toContain(tempOrg);
      expect(await repo.reserveMonthlyReportRecipients(tempOrg, month, [{ userId: tempUser, email: `${tempUser}@example.test`, locale: "en" }])).toBe(1);
      await db.delete(schema.organization).where(eq(schema.organization.id, tempOrg));
      expect(await repo.monthlyReportRecipientCounts(tempOrg, month)).toEqual({ prepared: 0, attempted: 0, accepted: 0, uncertain: 0, skipped: 0 });
    } finally {
      await db.delete(schema.organization).where(eq(schema.organization.id, tempOrg));
      await db.delete(schema.user).where(eq(schema.user.id, tempUser));
    }
  });

  it("does not reserve for stale monthly claims and enforces DB month format", async () => {
    await claim();
    await db.update(schema.workspaceSetting).set({ lastReportMonth: "2026-10" }).where(eq(schema.workspaceSetting.organizationId, orgId));
    expect(await repo.reserveMonthlyReportRecipients(orgId, month, recipients)).toBe(0);
    await expect(db.insert(schema.monthlyReportRecipient).values({
      organizationId: orgId, reportMonth: "2026-99", recipientUserId: userId, recipientEmail: "synthetic@example.test",
    })).rejects.toThrow();
  });
});
