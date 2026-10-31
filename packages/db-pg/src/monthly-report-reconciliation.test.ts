import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { createRepo } from "./repo";
import { migrate } from "./migrate";
import { and, eq, schema } from "./index";

const url = process.env.DATABASE_URL;
const month = "2026-09";
const old = new Date(Date.now() - 65 * 60_000);

describe.skipIf(!url)("staged owner-reviewed monthly mail reconciliation", () => {
  const name = `monthly_reconcile_${randomUUID().replaceAll("-", "")}`;
  const org = `synthetic-reconcile-${randomUUID()}`;
  const otherOrg = `synthetic-other-${randomUUID()}`;
  const owner = `synthetic-owner-${randomUUID()}`;
  const nonOwner = `synthetic-member-${randomUUID()}`;
  const outsider = `synthetic-outsider-${randomUUID()}`;
  const recipient = `synthetic-recipient-${randomUUID()}`;
  let admin: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>;
  let repo: ReturnType<typeof createRepo>;

  const scope = () => and(
    eq(schema.monthlyReportRecipient.organizationId, org),
    eq(schema.monthlyReportRecipient.reportMonth, month),
    eq(schema.monthlyReportRecipient.recipientUserId, recipient),
  );
  const audit = () => db.select().from(schema.monthlyReportReconciliation)
    .where(and(eq(schema.monthlyReportReconciliation.organizationId, org), eq(schema.monthlyReportReconciliation.reportMonth, month)));

  beforeAll(async () => {
    admin = createDb(url!, { max: 1 });
    await admin.$client.unsafe(`create database "${name}"`);
    const next = new URL(url!);
    next.pathname = `/${name}`;
    db = createDb(next.href, { max: 10 });
    await migrate(db);
    repo = createRepo(db);
    await db.insert(schema.organization).values([org, otherOrg].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    await db.insert(schema.user).values([owner, nonOwner, outsider, recipient].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(schema.member).values([
      { id: `m-${owner}`, organizationId: org, userId: owner, role: "owner", createdAt: new Date() },
      { id: `m-${nonOwner}`, organizationId: org, userId: nonOwner, role: "member", createdAt: new Date() },
      { id: `m-${outsider}`, organizationId: otherOrg, userId: outsider, role: "owner", createdAt: new Date() },
      { id: `m-${recipient}`, organizationId: org, userId: recipient, role: "owner", createdAt: new Date() },
    ]);
    await db.insert(schema.workspaceSetting).values({ organizationId: org, monthlyReport: true });
  });
  beforeEach(async () => {
    await db.delete(schema.monthlyReportReconciliation);
    await db.delete(schema.monthlyReportRecipient);
    await db.update(schema.workspaceSetting).set({ lastReportMonth: null, monthlyReport: true });
    expect(await repo.claimMonthlyReportsWithRecipients(month, 20)).toContain(org);
    expect(await repo.attemptMonthlyReportRecipient(org, month, recipient)).toBe(true);
    await db.update(schema.monthlyReportRecipient).set({ attemptedAt: old }).where(scope());
  });
  afterAll(async () => {
    await db?.$client.end();
    if (admin) {
      await admin.$client.unsafe(`drop database if exists "${name}"`);
      await admin.$client.end();
    }
  });

  it("owner confirms provider acceptance once with a SHA-256 evidence digest", async () => {
    const reference = "provider:synthetic-confirmation-id-01";
    expect(await repo.monthlyReportReconciliationSummary(org, month, owner)).toEqual({ pending: 1, unresolved: 0, confirmed: 0 });
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", reference)).toBe(true);
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ accepted: 1, attempted: 0 });
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ previousState: "attempted", decision: "provider_accepted", actorUserId: owner });
    expect(rows[0].evidenceSha256).toBe(createHash("sha256").update(reference).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(reference);
    expect(await repo.monthlyReportReconciliationSummary(org, month, owner)).toEqual({ pending: 0, unresolved: 0, confirmed: 1 });
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", reference)).toBe(false);
    expect(await repo.attemptMonthlyReportRecipient(org, month, recipient)).toBe(false);
  });

  it("unresolved review remains non-replayable and cannot be upgraded by a second review", async () => {
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "unresolved", "provider:unresolved-ticket-02")).toBe(true);
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ uncertain: 1, attempted: 0 });
    expect(await repo.monthlyReportReconciliationSummary(org, month, owner)).toEqual({ pending: 0, unresolved: 1, confirmed: 0 });
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:later-accepted-ticket")).toBe(false);
    expect(await repo.finishMonthlyReportRecipient(org, month, recipient, "accepted")).toBe(false);
    expect(await repo.attemptMonthlyReportRecipient(org, month, recipient)).toBe(false);
  });

  it("previously uncertain provider errors may be documented as accepted once", async () => {
    expect(await repo.finishMonthlyReportRecipient(org, month, recipient, "uncertain")).toBe(true);
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:confirmed-after-timeout")).toBe(true);
    expect((await audit())[0].previousState).toBe("uncertain");
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ accepted: 1, uncertain: 0 });
  });

  it("rejects nonowners, cross-tenant owners and callers asking for another month", async () => {
    for (const actor of [nonOwner, outsider, "not-a-user"]) {
      await expect(repo.reconcileMonthlyReportRecipient(org, month, recipient, actor, "provider_accepted", "provider:synthetic-accepted")).rejects.toThrow("not authorized");
      await expect(repo.monthlyReportReconciliationSummary(org, month, actor)).rejects.toThrow("not authorized");
    }
    expect(await repo.reconcileMonthlyReportRecipient(otherOrg, month, recipient, outsider, "provider_accepted", "provider:synthetic-accepted")).toBe(false);
    expect(await repo.reconcileMonthlyReportRecipient(org, "2026-08", recipient, owner, "provider_accepted", "provider:synthetic-accepted")).toBe(false);
    expect(await audit()).toHaveLength(0);
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ attempted: 1 });
  });

  it("refuses in-flight attempts younger than the safety threshold and invalid evidence", async () => {
    await db.update(schema.monthlyReportRecipient).set({ attemptedAt: new Date() }).where(scope());
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:fresh-request")).toBe(false);
    await db.update(schema.monthlyReportRecipient).set({ attemptedAt: old }).where(scope());
    for (const ref of ["", "too", "provider:with space", "x".repeat(161)]) {
      await expect(repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", ref)).rejects.toThrow("Invalid monthly reconciliation request");
    }
    expect(await audit()).toHaveLength(0);
  });

  it("only one of twelve competing owner reviews can commit an audit event", async () => {
    const reviews = await Promise.all(Array.from({ length: 12 }, () => repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:concurrent-reference")));
    expect(reviews.filter(Boolean)).toHaveLength(1);
    expect(await audit()).toHaveLength(1);
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ accepted: 1 });
  });

  it("an audit-write failure rolls back the recipient state in the same transaction", async () => {
    await db.$client.unsafe(`create function synthetic_audit_reject() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end; $$`);
    await db.$client.unsafe(`create trigger synthetic_audit_reject_trigger before insert on monthly_report_reconciliation for each row execute function synthetic_audit_reject()`);
    try {
      await expect(repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:synthetic-persist-error")).rejects.toThrow();
      expect(await audit()).toHaveLength(0);
      expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ attempted: 1, accepted: 0 });
    } finally {
      await db.$client.unsafe("drop trigger synthetic_audit_reject_trigger on monthly_report_reconciliation");
      await db.$client.unsafe("drop function synthetic_audit_reject()");
    }
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "provider_accepted", "provider:synthetic-persist-error")).toBe(true);
  });

  it("keeps an audit record but anonymizes the reviewing actor after account deletion", async () => {
    const temporaryActor = `synthetic-reviewer-${randomUUID()}`;
    await db.insert(schema.user).values({ id: temporaryActor, name: temporaryActor, email: `${temporaryActor}@example.test` });
    await db.insert(schema.member).values({ id: `m-${temporaryActor}`, organizationId: org, userId: temporaryActor, role: "owner", createdAt: new Date() });
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, temporaryActor, "unresolved", "provider:anonymized-operator-03")).toBe(true);
    await db.delete(schema.user).where(eq(schema.user.id, temporaryActor));
    expect((await audit())[0].actorUserId).toBeNull();
    expect(await repo.monthlyReportReconciliationSummary(org, month, owner)).toEqual({ pending: 0, unresolved: 1, confirmed: 0 });
  });

  it("workspace deletion cascades both outbox and reconciliation evidence", async () => {
    expect(await repo.reconcileMonthlyReportRecipient(org, month, recipient, owner, "unresolved", "provider:workspace-deletion")).toBe(true);
    await db.delete(schema.organization).where(eq(schema.organization.id, org));
    expect(await audit()).toHaveLength(0);
    expect(await repo.monthlyReportRecipientCounts(org, month)).toMatchObject({ uncertain: 0 });
    // The final test runs last: tests before this one need the seeded org.
  });
});
