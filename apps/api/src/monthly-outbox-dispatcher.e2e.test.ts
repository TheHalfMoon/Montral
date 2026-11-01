import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@montral/db-pg";
import type { Repo } from "@montral/repo";
import { configureEmail, setMailTransport } from "./email";
import { unmetered } from "./entitlements";
import type { Bindings } from "./env";
import { createMontralEntitlements } from "./montral-metering";
import { migrateMontralSchema } from "./schema-migrate";
import { montralEdition } from "./montral-edition";
import { previousMonth } from "./reports";
import { dispatchPreparedMonthlyOutbox } from "./monthly-outbox-dispatcher";

const url = process.env.TEST_DATABASE_URL;
const db = url ? openDatabase(url, { max: 12 }) : null;
const flags = { MONTRAL_METERING_ENABLED: "true", MONTRAL_BILLING_ENABLED: "false" } as Bindings;
const entitlements = db ? createMontralEntitlements(db, flags) : null;
// Use the current UTC accounting month: the PostgreSQL metering ledger
// intentionally rejects attempts billed to a stale historical month.
const current = new Date();
const when = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 2, 12));
const month = previousMonth(when);
const orgs: { org: string; users: string[] }[] = [];
const delivered: string[] = [];

async function makeReport(n = 2) {
  const org = `synthetic-dispatch-${crypto.randomUUID()}`;
  const users = Array.from({ length: n }, () => `synthetic-owner-${crypto.randomUUID()}`);
  await db!.query("INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Synthetic report',$1,NOW())", [org]);
  orgs.push({ org, users });
  for (const id of users) {
    await db!.query("INSERT INTO \"user\" (id,name,email,created_at,updated_at) VALUES ($1,'Test owner',$2,NOW(),NOW())", [id, `${id}@example.test`]);
    await db!.query("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ($1,$2,$3,'owner',NOW())", [`membership-${id}`, org, id]);
  }
  await db!.query("INSERT INTO workspace_setting(organization_id,monthly_report,last_report_month) VALUES($1,true,$2)", [org, month]);
  expect(await db!.repo.reserveMonthlyReportRecipients(org, month, users.map((userId) => ({ userId, email: `${userId}@example.test`, locale: "en" })))).toBe(n);
  const repo = { ...db!.repo, monthlyReport: async () => [{ name: "Synthetic uptime monitor", uptime: 99.8, downtimeMinutes: 3, incidents: 1 }] } as Repo;
  return { org, users, repo };
}

const counts = (org: string) => db!.repo.monthlyReportRecipientCounts(org, month);
const balance = (org: string) => entitlements!.emailBalance(org);

describe.skipIf(!url)("staged monthly outbox dispatcher with real PostgreSQL and loopback-only mail", () => {
  beforeAll(async () => { await migrateMontralSchema(db!, montralEdition); });
  beforeEach(() => {
    delivered.length = 0;
    configureEmail({ EMAIL_FROM: "montral-synthetic@example.test", WEB_ORIGIN: "http://localhost:3000" } as Bindings);
    setMailTransport(async (mail) => { delivered.push(mail.to); });
  });
  afterEach(() => { setMailTransport(undefined); vi.restoreAllMocks(); });
  afterAll(async () => {
    for (const { org, users } of orgs) {
      await db!.query("DELETE FROM organization WHERE id=$1", [org]);
      for (const id of users) await db!.query("DELETE FROM \"user\" WHERE id=$1", [id]);
    }
    await db?.close(1);
  });

  it("delivers every prepared owner exactly once and persists accepted states", async () => {
    const { org, users, repo } = await makeReport();
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toEqual({ claimed: 2, accepted: 2, uncertain: 0, quotaDenied: 0 });
    expect(delivered.slice().sort()).toEqual(users.map(u => `${u}@example.test`).sort());
    expect(await counts(org)).toMatchObject({ prepared: 0, accepted: 2, attempted: 0, uncertain: 0 });
    expect(await balance(org)).toMatchObject({ used: 2 });
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toEqual({ claimed: 0, accepted: 0, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await balance(org)).toMatchObject({ used: 2 });
  });

  it("freezes report content before the first SMTP attempt and reuses it after metrics change", async () => {
    const { org, users, repo } = await makeReport();
    const messages: Array<{ to: string; html: string }> = [];
    setMailTransport(async (mail) => { messages.push({ to: mail.to, html: mail.html }); });
    // One recipient delivered; a second remains prepared for the next process.
    const truncated = { ...repo, preparedMonthlyReportRecipients: async () =>
      (await repo.preparedMonthlyReportRecipients(org, month)).filter((r) => r.userId === users[0]) } as Repo;
    expect(await dispatchPreparedMonthlyOutbox(truncated, entitlements!, org, when)).toMatchObject({ accepted: 1 });
    const first = await repo.monthlyReportFrozenContent(org, month);
    expect(first).toMatchObject({ workspaceName: "Synthetic report",
      components: [{ name: "Synthetic uptime monitor", uptime: 99.8 }] });
    const changed = { ...repo,
      organization: async () => ({ ...(await repo.organization(org))!, name: "Mutated after send" }),
      monthlyReport: async () => [{ name: "WRONG LATE METRICS", uptime: 12, downtimeMinutes: 300, incidents: 8 }],
    } as Repo;
    expect(await dispatchPreparedMonthlyOutbox(changed, entitlements!, org, when)).toMatchObject({ accepted: 1 });
    expect(messages.map((v) => v.to).sort()).toEqual(users.map((u) => `${u}@example.test`).sort());
    expect(messages[0].html).toContain("Synthetic uptime monitor");
    expect(messages[1].html).toContain("Synthetic uptime monitor");
    expect(messages[1].html).not.toContain("WRONG LATE METRICS");
    expect(messages[1].html).not.toContain("Mutated after send");
    expect(await repo.monthlyReportFrozenContent(org, month)).toEqual(first);
    expect(await balance(org)).toMatchObject({ used: 2 });
  });

  it("refuses to invent missing frozen content after any already-attempted recipient", async () => {
    const { org, users, repo } = await makeReport();
    expect(await entitlements!.claimMonthlyOutboxAttempt!(org, month, users[0])).toBe("attempted");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0 });
    expect(await repo.monthlyReportFrozenContent(org, month)).toBeNull();
    expect(delivered).toHaveLength(0);
    expect(await balance(org)).toMatchObject({ used: 1 });
    expect(await counts(org)).toMatchObject({ attempted: 1, prepared: 1 });
    expect(log).not.toHaveBeenCalledWith("monthly outbox provider acceptance uncertain");
  });

  it("concurrent content writers converge to the first committed immutable report", async () => {
    const { org, repo } = await makeReport(2);
    const candidate = (name: string) => ({ workspaceName: name,
      components: [{ name: "Synthetic monitor", uptime: 98.9, downtimeMinutes: 4, incidents: 2 }] });
    const reports = await Promise.all(Array.from({ length: 8 }, (_, n) =>
      repo.freezeMonthlyReportContent(org, month, candidate(`Candidate-${n}`))));
    expect(reports.every((r) => JSON.stringify(r) === JSON.stringify(reports[0]))).toBe(true);
    expect((await repo.monthlyReportFrozenContent(org, month))?.workspaceName).toBe(reports[0]?.workspaceName);
    expect(await repo.freezeMonthlyReportContent(org, month, candidate("Attempted overwrite"))).toEqual(reports[0]);
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("PostgreSQL trigger prohibits changing an already frozen report and workspace deletion erases it", async () => {
    const { org, repo } = await makeReport();
    const components = [{ name: "Confidential synthetic monitor", uptime: 99, downtimeMinutes: 1, incidents: 1 }];
    expect(await repo.freezeMonthlyReportContent(org, month, { workspaceName: "Synthetic freeze", components })).toMatchObject({ components });
    await expect(db!.query("UPDATE monthly_report_content SET workspace_name='Tampered' WHERE organization_id=$1 AND report_month=$2", [org, month])).rejects.toThrow("monthly report content is immutable");
    expect((await repo.monthlyReportFrozenContent(org, month))?.workspaceName).toBe("Synthetic freeze");
    await db!.query("DELETE FROM organization WHERE id=$1", [org]);
    expect(await repo.monthlyReportFrozenContent(org, month)).toBeNull();
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("cannot freeze bad content and does not spend mail quota", async () => {
    const { org, repo } = await makeReport();
    await expect(repo.freezeMonthlyReportContent(org, month, { workspaceName: "Bad",
      components: [{ name: "Bad stats", uptime: 900, downtimeMinutes: 0, incidents: 0 }] })).rejects.toThrow();
    expect(await repo.monthlyReportFrozenContent(org, month)).toBeNull();
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("records uncertain after provider accepted then timed out, and keeps healthy peers moving", async () => {
    const { org, users, repo } = await makeReport();
    setMailTransport(async (mail) => {
      delivered.push(mail.to); // simulates a provider accepting before throwing
      if (mail.to === `${users[0]}@example.test`) throw new Error("synthetic SMTP private credential, acceptance unknown");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(result).toEqual({ claimed: 2, accepted: 1, uncertain: 1, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await counts(org)).toMatchObject({ accepted: 1, uncertain: 1, prepared: 0 });
    expect(await balance(org)).toMatchObject({ used: 2 });
    await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(delivered).toHaveLength(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic SMTP private credential");
    expect(log).toHaveBeenCalledWith("monthly outbox provider acceptance uncertain");
  });

  it("never replays accepted SMTP after DB result persistence fails", async () => {
    const { org, users, repo } = await makeReport();
    const finish = repo.finishMonthlyReportRecipient.bind(repo);
    const broken = { ...repo, finishMonthlyReportRecipient: async (organization: string, reportMonth: string, userId: string, outcome: "accepted" | "uncertain") => {
      if (userId === users[0]) throw new Error("synthetic database private password after acceptance");
      return finish(organization, reportMonth, userId, outcome);
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(broken, entitlements!, org, when)).toEqual({ claimed: 2, accepted: 1, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toHaveLength(2);
    expect(await counts(org)).toMatchObject({ attempted: 1, accepted: 1, prepared: 0 });
    await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when);
    expect(delivered).toHaveLength(2);
    expect(await balance(org)).toMatchObject({ used: 2 });
    expect(log).toHaveBeenCalledWith("monthly outbox result persistence unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic database private password");
  });

  it("does not charge for malformed recipient and still sends another valid owner", async () => {
    const { org, users, repo } = await makeReport();
    const original = repo.preparedMonthlyReportRecipients.bind(repo);
    const broken = { ...repo, preparedMonthlyReportRecipients: async (organization: string, reportMonth: string) => {
      const rows = await original(organization, reportMonth);
      return rows.map((r) => r.userId === users[0] ? { ...r, email: "" } : r);
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(broken, entitlements!, org, when)).toEqual({ claimed: 1, accepted: 1, uncertain: 0, quotaDenied: 0 });
    expect(delivered).toEqual([`${users[1]}@example.test`]);
    expect(await counts(org)).toMatchObject({ prepared: 1, accepted: 1 });
    expect(await balance(org)).toMatchObject({ used: 1 });
    expect(log).toHaveBeenCalledWith("monthly outbox message preparation unavailable");
  });

  it("refuses to charge or send when there is no configured provider", async () => {
    const { org, repo } = await makeReport();
    setMailTransport(undefined);
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("does not consume quota or send when the workspace report is disabled", async () => {
    const { org, repo } = await makeReport();
    await db!.query("UPDATE workspace_setting SET monthly_report=false WHERE organization_id=$1", [org]);
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(delivered).toHaveLength(0);
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(await balance(org)).toMatchObject({ used: 0 });
  });

  it("does not resend after a worker crashed immediately after committed claim but before SMTP", async () => {
    const { org, users, repo } = await makeReport(1);
    expect(await entitlements!.claimMonthlyOutboxAttempt!(org, month, users[0])).toBe("attempted");
    expect(await counts(org)).toMatchObject({ attempted: 1 });
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)).toMatchObject({ claimed: 0 });
    expect(delivered).toHaveLength(0);
    expect(await balance(org)).toMatchObject({ used: 1 });
  });

  it("lets three concurrent dispatcher workers jointly send each prepared owner once", async () => {
    const { org, users, repo } = await makeReport(3);
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => dispatchPreparedMonthlyOutbox(repo, entitlements!, org, when)));
    expect(outcomes.reduce((n, r) => n + r.claimed, 0)).toBe(3);
    expect(outcomes.reduce((n, r) => n + r.accepted, 0)).toBe(3);
    expect(delivered.slice().sort()).toEqual(users.map((u) => `${u}@example.test`).sort());
    expect(await counts(org)).toMatchObject({ prepared: 0, attempted: 0, accepted: 3 });
    expect(await balance(org)).toMatchObject({ used: 3 });
  });

  it("fails closed without charging if the prepared-recipient query fails", async () => {
    const { org, repo } = await makeReport();
    const unavailable = { ...repo, preparedMonthlyReportRecipients: async () => {
      throw new Error("private database connection string");
    } } as Repo;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchPreparedMonthlyOutbox(unavailable, entitlements!, org, when)).toMatchObject({ claimed: 0, accepted: 0 });
    expect(delivered).toHaveLength(0);
    expect(await balance(org)).toMatchObject({ used: 0 });
    expect(await counts(org)).toMatchObject({ prepared: 2 });
    expect(log).toHaveBeenCalledWith("monthly outbox preparation unavailable");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private database connection string");
  });

  it("enforces reporting window and refuses unmetered entitlement bypass", async () => {
    const { org, repo } = await makeReport();
    expect(await dispatchPreparedMonthlyOutbox(repo, entitlements!, org, new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 4)))).toMatchObject({ claimed: 0 });
    expect(await dispatchPreparedMonthlyOutbox(repo, unmetered, org, when)).toMatchObject({ claimed: 0 });
    expect(delivered).toHaveLength(0);
    expect(await counts(org)).toMatchObject({ prepared: 2 });
  });
});
